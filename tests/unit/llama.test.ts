import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { LlamaClient, extractJson } from "../../src/translation/llama/client";
import { ProviderError } from "../../src/translation/provider";
import {
  LlamaServerManager,
  type SpawnedProcess,
  type Spawner,
} from "../../src/translation/llama/server-manager";

// ---------------------------------------------------------------------------
// Mock llama-server (TEST_PLAN §14)
// ---------------------------------------------------------------------------

let server: http.Server;
let port = 0;
let behavior: {
  healthStatus?: number;
  completionsStatus?: number;
  completionsBody?: string;
  delayMs?: number;
} = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const respond = () => {
      if (req.url?.startsWith("/health")) {
        res.statusCode = behavior.healthStatus ?? 200;
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url?.startsWith("/v1/chat/completions")) {
        res.statusCode = behavior.completionsStatus ?? 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          behavior.completionsBody ??
            JSON.stringify({
              model: "test-model",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      blocks: [{ id: "p_1", translation: "hello ⟦MATH_001⟧" }],
                    }),
                  },
                },
              ],
            }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    if (behavior.delayMs) setTimeout(respond, behavior.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  behavior = {};
});

const makeClient = (timeoutMs = 3_000) =>
  new LlamaClient({ baseUrl: `http://127.0.0.1:${port}`, model: "test-model", timeoutMs });

describe("LlamaClient (TEST_PLAN §14)", () => {
  it("reports healthy server", async () => {
    behavior = { healthStatus: 200 };
    expect(await makeClient().health()).toBe(true);
  });

  it("reports unhealthy when health returns 503 (model loading)", async () => {
    behavior = { healthStatus: 503 };
    expect(await makeClient().health()).toBe(false);
  });

  it("reports unhealthy when server is unavailable", async () => {
    const client = new LlamaClient({ baseUrl: "http://127.0.0.1:1", model: "m" });
    expect(await client.health()).toBe(false);
  });

  it("translates with a valid structured response", async () => {
    const result = await makeClient().translate({
      blocks: [{ id: "p_1", text: "hola ⟦MATH_001⟧" }],
      sourceLanguage: "es",
      targetLanguage: "en",
      style: "academic",
    });
    expect(result.blocks).toEqual([{ id: "p_1", translation: "hello ⟦MATH_001⟧" }]);
    expect(result.model).toBe("test-model");
  });

  it("fails with malformed on non-JSON completion body", async () => {
    behavior = { completionsBody: "not json at all" };
    const err = await makeClient()
      .translate({ blocks: [], sourceLanguage: "a", targetLanguage: "b", style: "s" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("malformed");
  });

  it("fails with http error on 500", async () => {
    behavior = { completionsStatus: 500 };
    const err = await makeClient()
      .translate({ blocks: [], sourceLanguage: "a", targetLanguage: "b", style: "s" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("http");
    expect((err as ProviderError).status).toBe(500);
  });

  it("fails with timeout when the server stalls", async () => {
    behavior = { delayMs: 5_000 };
    const err = await makeClient(300)
      .translate({ blocks: [{ id: "x", text: "y" }], sourceLanguage: "a", targetLanguage: "b", style: "s" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("timeout");
  }, 10_000);

  it("times out when the server stalls after sending headers (body read is in scope)", async () => {
    const stall = await startStallServer();
    try {
      const client = new LlamaClient({ baseUrl: stall.url, model: "m", timeoutMs: 300 });
      const err = await client.chat([{ role: "user", content: "hi" }], 0.2).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("timeout");
    } finally {
      await stall.close();
    }
  }, 10_000);

  it("rejects immediately with aborted when the signal is already aborted", async () => {
    let called = false;
    const client = new LlamaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "m",
      fetchImpl: (async () => {
        called = true;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();
    const err = await client
      .chat([{ role: "user", content: "hi" }], 0.2, controller.signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("aborted");
    expect(called).toBe(false);
  });

  it("reports aborted (not timeout) when the caller aborts during the body read", async () => {
    const stall = await startStallServer();
    try {
      const client = new LlamaClient({ baseUrl: stall.url, model: "m", timeoutMs: 10_000 });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const err = await client
        .chat([{ role: "user", content: "hi" }], 0.2, controller.signal)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe("aborted");
    } finally {
      await stall.close();
    }
  }, 10_000);

  it("reports aborted (not timeout) when the caller aborts during the headers phase", async () => {
    behavior = { delayMs: 5_000 };
    const client = makeClient(3_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const err = await client
      .translate(
        { blocks: [{ id: "x", text: "y" }], sourceLanguage: "a", targetLanguage: "b", style: "s" },
        controller.signal,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("aborted");
  }, 10_000);

  it("a request with no onRequestStart hook still works", async () => {
    const res = await makeClient().chat([{ role: "user", content: "hi" }], 0.2);
    expect(typeof res.content).toBe("string");
    expect(res.model).toBe("test-model");
  });

  it("extracts JSON from fenced model output", () => {
    const fenced = '```json\n{"blocks":[]}\n```';
    expect(extractJson(fenced)).toBe('{"blocks":[]}');
    const padded = 'Here you go: {"blocks":[]} hope it helps';
    expect(extractJson(padded)).toBe('{"blocks":[]}');
  });
});

// ---------------------------------------------------------------------------
// Server manager with a fake spawner (TEST_PLAN §14 process scenarios)
// ---------------------------------------------------------------------------

interface FakeProcessOptions {
  spawnError?: Error;
  exitCode?: number | null;
  exitAfterMs?: number;
}

function fakeSpawner(opts: FakeProcessOptions, log: string[]): Spawner {
  return (_command, args) => {
    log.push(args.join(" "));
    const listeners: Record<string, ((...a: never[]) => void)[]> = {};
    const proc: SpawnedProcess = {
      pid: 4242,
      killed: false,
      kill(signal) {
        proc.killed = true;
        log.push(`kill:${signal ?? "SIGTERM"}`);
        const exits = listeners.exit ?? [];
        for (const l of exits) (l as (code: number | null) => void)(opts.exitCode ?? 0);
        return true;
      },
      on(event, listener) {
        (listeners[event] ??= []).push(listener as never);
        if (event === "error" && opts.spawnError) {
          const err = opts.spawnError;
          const timer = setTimeout(() => (listener as (e: Error) => void)(err), 0);
          if (typeof timer.unref === "function") timer.unref();
        }
        if (event === "exit" && opts.exitAfterMs !== undefined) {
          const timer = setTimeout(
            () => (listener as (code: number | null) => void)(opts.exitCode ?? null),
            opts.exitAfterMs,
          );
          if (typeof timer.unref === "function") timer.unref();
        }
        return proc;
      },
      stderr: {
        on(event, listener) {
          if (event === "data" && opts.spawnError) {
            const timer = setTimeout(() => (listener as (c: string) => void)("error: model not found"), 0);
            if (typeof timer.unref === "function") timer.unref();
          }
        },
      },
    };
    return proc;
  };
}

const managerProvider = (healthy: boolean) =>
  ({
    health: async () => healthy,
    translate: async () => {
      throw new Error("unused");
    },
  }) as import("../../src/translation/provider").TranslationProvider;

/** Server that sends chat-completion headers and then never finishes the body. */
async function startStallServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/chat/completions")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.write('{"choices":[{"message":{"content":"partial"}}]}');
      // never res.end(): the body stalls after the headers are out
    } else {
      res.statusCode = 200;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const stallPort = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${stallPort}`,
    close: async () => {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      srv.closeAllConnections?.();
    },
  };
}

describe("LlamaServerManager (TEST_PLAN §14 process scenarios)", () => {
  const baseCfg = {
    executablePath: "llama-server",
    modelPath: "model.gguf",
    host: "127.0.0.1",
    port: 8080,
    gpuLayers: 0,
    contextSize: 2048,
    idleTimeoutMs: 0,
  };

  it("fails clearly when the executable is missing", async () => {
    const manager = new LlamaServerManager(baseCfg, managerProvider(false), fakeSpawner({ spawnError: new Error("ENOENT") }, []));
    await expect(manager.start()).rejects.toBeInstanceOf(ProviderError);
    expect(manager.status()).toBe("error");
    expect(manager.lastErrorMessage()).toContain("Failed to start");
  });

  it("captures the stderr tail when the model is missing", async () => {
    // spawn ok but exits immediately with error, stderr explains why
    const manager = new LlamaServerManager(
      baseCfg,
      managerProvider(false),
      fakeSpawner({ exitCode: 1, exitAfterMs: 5 }, []),
    );
    await expect(manager.start()).rejects.toBeInstanceOf(ProviderError);
    expect(manager.status()).toBe("error");
    expect(manager.lastErrorMessage()).toContain("exited");
  });

  it("refuses to spawn when the port already answers health (no adoption)", async () => {
    // A foreign/orphan llama-server on host:port: the manager must error out
    // before spawning instead of adopting the endpoint and letting its own
    // child die with EADDRINUSE.
    const log: string[] = [];
    const manager = new LlamaServerManager(baseCfg, managerProvider(true), fakeSpawner({}, log));
    const err = await manager.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("already running");
    expect(log).toHaveLength(0); // nothing was spawned
    expect(manager.status()).toBe("error");
  });

  it("becomes ready when health turns ok after spawn, then stops cleanly", async () => {
    const log: string[] = [];
    // Health flips true only once the manager has spawned its own child, so
    // the pre-spawn probe correctly sees a free endpoint.
    let spawned = false;
    const provider = {
      health: async () => spawned,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    const manager = new LlamaServerManager(baseCfg, provider, fakeSpawner({}, log));
    const started = manager.start();
    spawned = true;
    await started;
    expect(manager.status()).toBe("ready");
    expect(log[0]).toContain("-m");
    expect(log.join(" ")).toContain("--port 8080");
    await manager.stop();
    expect(manager.status()).toBe("stopped");
    expect(log.join(" ")).toContain("kill:SIGTERM");
  });

  it("start() queued behind stop() spawns only after the previous child exits (R3 P3-6)", async () => {
    const log: string[] = [];
    let alive = false;
    const provider = {
      health: async () => alive,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    // Child whose exit fires 20ms after SIGTERM: stop() is still reaping the
    // process when the next start() arrives — the old port-race scenario.
    const spawner: Spawner = (_command, args) => {
      log.push(`spawn:${args.length}`);
      alive = true;
      const listeners: Record<string, ((...a: never[]) => void)[]> = {};
      const proc: SpawnedProcess = {
        pid: 4242,
        killed: false,
        kill(signal) {
          proc.killed = true;
          log.push(`kill:${signal ?? "SIGTERM"}`);
          alive = false;
          const timer = setTimeout(() => {
            log.push("exit");
            for (const l of listeners.exit ?? []) (l as (code: number | null) => void)(0);
          }, 20);
          if (typeof timer.unref === "function") timer.unref();
          return true;
        },
        on(event, listener) {
          (listeners[event] ??= []).push(listener as never);
          return proc;
        },
        stderr: {
          on() {
            /* no stderr traffic in this test */
          },
        },
      };
      return proc;
    };

    const manager = new LlamaServerManager(baseCfg, provider, spawner);
    await manager.start();
    expect(manager.status()).toBe("ready");
    const stopping = manager.stop(); // SIGTERM now, exit only in 20ms
    const restarted = manager.start(); // must not spawn before that exit
    await stopping;
    await restarted;
    expect(manager.status()).toBe("ready");
    const spawnIndices = log
      .map((entry, i) => (entry.startsWith("spawn") ? i : -1))
      .filter((i) => i >= 0);
    expect(spawnIndices).toHaveLength(2);
    expect(log.indexOf("exit")).toBeGreaterThan(-1);
    expect(spawnIndices[1]).toBeGreaterThan(log.indexOf("exit"));
  });

  it("marks error when the process crashes after startup", async () => {
    let spawned = false;
    let healthy = false;
    const provider = {
      health: async () => healthy,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    const manager = new LlamaServerManager(
      baseCfg,
      provider,
      fakeSpawner({ exitAfterMs: 30 }, []),
    );
    const started = manager.start();
    spawned = true;
    healthy = true;
    await started;
    expect(manager.status()).toBe("ready");
    healthy = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(manager.status()).toBe("error");
    expect(manager.lastErrorMessage()).toContain("exited unexpectedly");
  });

  it("requires config before spawning", async () => {
    const manager = new LlamaServerManager({ ...baseCfg, executablePath: "" }, managerProvider(true), fakeSpawner({}, []));
    await expect(manager.start()).rejects.toBeInstanceOf(ProviderError);
    expect(manager.status()).toBe("error");
  });

  it("stop() after a crash resolves fast (process already exited)", async () => {
    let spawned = false;
    const provider = {
      health: async () => spawned,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    const manager = new LlamaServerManager(baseCfg, provider, fakeSpawner({ exitAfterMs: 20 }, []));
    const started = manager.start();
    spawned = true;
    await started;
    await new Promise((r) => setTimeout(r, 60)); // crash: exit handler nulled this.process
    expect(manager.status()).toBe("error");
    const t0 = Date.now();
    await manager.stop();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("start cleanup only kills its own process handle (generation guard)", async () => {
    const procs: SpawnedProcess[] = [];
    const spawner: Spawner = (command, args) => {
      const proc = fakeSpawner({}, [])(command, args);
      procs.push(proc);
      return proc;
    };
    let healthy = false;
    const provider = {
      health: async () => healthy,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    const manager = new LlamaServerManager({ ...baseCfg, waitTimeoutMs: 30 }, provider, spawner);

    // First start is polling when an external stop + second start overlap it
    // (the restart() interleaving).
    const first = manager.start().catch((e: unknown) => e as Error);
    await new Promise((r) => setTimeout(r, 20));
    await manager.stop();
    const second = manager.start();
    healthy = true; // seen by the second start's polls, not by its pre-spawn probe
    await second;
    expect(manager.status()).toBe("ready");

    const firstErr = (await first) as Error;
    expect(firstErr).toBeInstanceOf(ProviderError);
    // The first start's cleanup must never kill the second start's process.
    expect(procs[1].killed).toBe(false);
    expect(manager.status()).toBe("ready");
  });

  it("client request hooks re-arm the idle timer (production beginRequest/endRequest wiring)", async () => {
    const log: string[] = [];
    let spawned = false;
    const provider = {
      health: async () => spawned,
      translate: async () => {
        throw new Error("unused");
      },
    } as import("../../src/translation/provider").TranslationProvider;
    const manager = new LlamaServerManager({ ...baseCfg, idleTimeoutMs: 500 }, provider, fakeSpawner({}, log));
    // Mirrors the makeClient() wiring in editor/translator-commands.ts.
    const client = new LlamaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-model",
      onRequestStart: () => manager.beginRequest(),
      onRequestEnd: () => manager.endRequest(),
    });
    const started = manager.start();
    spawned = true;
    await started;
    expect(manager.status()).toBe("ready");

    await new Promise((r) => setTimeout(r, 100)); // idle fire due at t=500
    await client.chat([{ role: "user", content: "hi" }], 0.2); // endRequest re-arms → due ≈ t=600
    await new Promise((r) => setTimeout(r, 300)); // t≈400 < 600: no shutdown mid-session
    expect(manager.status()).toBe("ready");
    expect(log.join(" ")).not.toContain("kill:");

    await new Promise((r) => setTimeout(r, 300)); // t≈700 > 600: idle shutdown fires
    expect(manager.status()).toBe("stopped");
    expect(log.join(" ")).toContain("kill:SIGTERM");
  });

  it("a request in flight suspends idle shutdown until endRequest()", async () => {
    const log: string[] = [];
    const manager = new LlamaServerManager({ ...baseCfg, idleTimeoutMs: 100 }, managerProvider(false), fakeSpawner({}, log));
    // White-box: drive the idle machinery directly, without the spawn
    // ceremony — armIdleTimer/postpone only keep re-arming while "ready".
    (manager as unknown as { statusValue: string }).statusValue = "ready";
    manager.endRequest(); // public entry that arms the idle timer (due ≈ t=100)

    manager.beginRequest(); // in flight — the armed timer must be suspended
    await new Promise((r) => setTimeout(r, 150)); // t=100 fire lands in the postpone branch
    expect(manager.status()).toBe("ready"); // without suspension this would be stopped

    manager.endRequest(); // re-arms → due ≈ t=250
    await new Promise((r) => setTimeout(r, 250)); // t≈400 > 250
    expect(manager.status()).toBe("stopped");
  });

  it("a leaked beginRequest cannot pin the server forever (postponement cap)", async () => {
    const log: string[] = [];
    const manager = new LlamaServerManager({ ...baseCfg, idleTimeoutMs: 60 }, managerProvider(false), fakeSpawner({}, log));
    (manager as unknown as { statusValue: string }).statusValue = "ready";
    manager.endRequest(); // arm

    manager.beginRequest(); // never ended — MAX_IDLE_POSTPONEMENTS must kick in
    // 60ms × (1 fire + 3 postponements) ⇒ stopped by ≈t=240.
    await new Promise((r) => setTimeout(r, 500));
    expect(manager.status()).toBe("stopped");
  });
});
