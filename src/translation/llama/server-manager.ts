import { ProviderError, type TranslationProvider } from "../provider";

/**
 * llama.cpp server manager, Phase B (TECHNICAL_DESIGN.md §10.3).
 *
 * Spawns/manages a local `llama-server` process. The spawner is injected so
 * unit tests run without a real binary, and the plugin wiring uses
 * node:child_process (desktop-only).
 *
 * Binding rule: never called during plugin load — only on an explicit user
 * command or the first translation request (PRODUCT_REQUIREMENTS.md §5).
 */

export type ServerStatus = "stopped" | "starting" | "ready" | "error";

export interface ServerManagerConfig {
  executablePath: string;
  modelPath: string;
  host: string;
  port: number;
  gpuLayers: number;
  contextSize: number;
  /** Idle shutdown in ms; 0 disables. */
  idleTimeoutMs: number;
  waitTimeoutMs?: number;
}

export interface SpawnedProcess {
  pid?: number;
  killed: boolean;
  kill(signal?: string): boolean;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  stderr?: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  stdout?: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
}

export type Spawner = (command: string, args: string[]) => SpawnedProcess;

/**
 * Cap on how often an idle shutdown may be deferred because a request is
 * still in flight. Purely a safety net: with beginRequest/endRequest wired
 * correctly the counter never grows beyond zero.
 */
const MAX_IDLE_POSTPONEMENTS = 3;

export class LlamaServerManager {
  private cfg: ServerManagerConfig;
  private provider: TranslationProvider;
  private spawner: Spawner;
  private process: SpawnedProcess | null = null;
  private statusValue: ServerStatus = "stopped";
  private lastError: string | null = null;
  private stderrTail: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: ((err: Error | null) => void)[] = [];
  /** Monotonically increasing id per start() invocation (ownership guard). */
  private startGeneration = 0;
  /** Requests currently in flight; idle shutdown is suspended while > 0. */
  private inFlight = 0;
  /** Bounded safety net: how many times an idle fire may be postponed. */
  private idlePostponements = 0;
  /** In-flight start() promise, so concurrent callers await the same startup. */
  private starting: Promise<void> | null = null;
  /** Resolves once the last reaped child is really gone (R3 P3-6): a new
   *  start must not spawn while a dying process may still hold the port. */
  private lastStop: Promise<void> | null = null;

  constructor(cfg: ServerManagerConfig, provider: TranslationProvider, spawner: Spawner) {
    this.cfg = cfg;
    this.provider = provider;
    this.spawner = spawner;
  }

  status(): ServerStatus {
    return this.statusValue;
  }

  lastErrorMessage(): string | null {
    return this.lastError;
  }

  /** Current reachability of the endpoint (owned process or external). */
  async health(): Promise<boolean> {
    try {
      return await this.provider.health();
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "unavailable") return false;
      return false;
    }
  }

  /** Spawn the local server and wait until the endpoint is healthy.
   *  Concurrent callers share one startup instead of the second returning
   *  immediately while the server is still booting. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.statusValue === "ready") return;
    const attempt = this.startOnce().finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    return attempt;
  }

  private async startOnce(): Promise<void> {
    if (this.statusValue === "ready") return;
    if (!this.cfg.executablePath) {
      this.fail("No llama-server executable configured.");
      throw new ProviderError("config", "No llama-server executable configured.");
    }
    if (!this.cfg.modelPath) {
      this.fail("No GGUF model configured.");
      throw new ProviderError("config", "No GGUF model configured.");
    }

    const gen = ++this.startGeneration;
    this.statusValue = "starting";
    this.lastError = null;
    this.stderrTail = [];

    // A stop() may still be reaping the previous child (SIGTERM→SIGKILL
    // window, up to the 2s force timer): spawning before the port is released
    // races the dying process into EADDRINUSE (R3 P3-6). A stop() that fires
    // while we wait cancels this start instead of resurrecting a server
    // behind the user's back.
    if (this.lastStop) {
      await this.lastStop.catch(() => undefined);
      if (gen !== this.startGeneration || this.statusValue !== "starting") return;
    }

    // Probe before spawning: whatever already answers /health on this
    // endpoint is a foreign/orphan llama-server. Spawning anyway would adopt
    // the foreign server for translations while our own child dies with
    // EADDRINUSE — refuse clearly instead.
    let occupied = false;
    try {
      occupied = await this.provider.health();
    } catch {
      occupied = false;
    }
    if (gen !== this.startGeneration) return; // superseded by a newer start
    if (occupied) {
      const message =
        `A llama-server is already running on http://${this.cfg.host}:${this.cfg.port} — ` +
        "connect-only mode will use it. Stop it first to spawn a managed server here.";
      this.fail(message);
      throw new ProviderError("unavailable", message);
    }

    const args = [
      "-m",
      this.cfg.modelPath,
      "--host",
      this.cfg.host,
      "--port",
      String(this.cfg.port),
      "-c",
      String(this.cfg.contextSize),
    ];
    if (this.cfg.gpuLayers > 0) args.push("-ngl", String(this.cfg.gpuLayers));

    let proc: SpawnedProcess;
    try {
      proc = this.spawner(this.cfg.executablePath, args);
    } catch (err) {
      this.fail(`Failed to spawn llama-server: ${String(err)}`);
      throw new ProviderError("unavailable", `Failed to spawn llama-server: ${String(err)}`);
    }
    if (gen !== this.startGeneration) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      return;
    }
    this.process = proc;
    proc.stderr?.on("data", (chunk) => this.pushTail(String(chunk)));
    proc.stdout?.on("data", (chunk) => this.pushTail(String(chunk)));
    proc.on("error", (err) => {
      if (this.process !== proc) return; // a newer start owns the manager
      this.fail(`Failed to start llama-server: ${err.message}`);
      this.resolveWaiters(new ProviderError("unavailable", err.message));
    });
    proc.on("exit", (code) => {
      if (this.process !== proc) return; // stale handle: never kills newer state
      // A deliberate stop() has already nulled this.process, so this only
      // fires for an unexpected exit of the owned process.
      this.process = null;
      if (this.statusValue === "starting" || this.statusValue === "ready") {
        this.fail(
          `llama-server exited unexpectedly (code ${code}).${this.stderrTail.length ? " Tail: " + this.stderrTail.join("") : ""}`,
        );
      }
      this.resolveWaiters(
        new ProviderError("unavailable", `llama-server exited (code ${code})`),
      );
    });

    try {
      await this.waitUntilReady(this.cfg.waitTimeoutMs ?? 120_000, proc);
    } catch (err) {
      // Only our own generation's process may be cleaned up here; a newer
      // start's freshly spawned server must survive.
      await this.stopOwned(proc);
      throw err;
    }
    if (this.process !== proc) return; // superseded while polling
    this.statusValue = "ready";
    this.armIdleTimer();
  }

  /** Poll /health until ready or timeout. When `ownProcess` is given, the
   *  wait only succeeds while that exact (own) child is still running. */
  waitUntilReady(timeoutMs: number, ownProcess?: SpawnedProcess): Promise<void> {
    if (this.statusValue === "ready") return Promise.resolve();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      let waiter: ((err: Error | null) => void) | null = null;
      // Always detach our own waiter before settling. Otherwise every
      // rejected path leaves its callback behind and the array grows
      // without bound across repeated failed starts.
      const settle = (fn: () => void): void => {
        if (waiter) {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          waiter = null;
        }
        fn();
      };
      const attempt = async (): Promise<void> => {
        if (this.statusValue === "stopped" || this.statusValue === "error") {
          settle(() => reject(new ProviderError("unavailable", this.lastError ?? "server stopped")));
          return;
        }
        // Gate on the own child being alive: a dead child must never yield
        // "ready" just because something else answers on the port.
        const owned = ownProcess !== undefined ? this.process === ownProcess : this.process !== null;
        if (!owned) {
          settle(() => reject(new ProviderError("unavailable", "llama-server process is not running")));
          return;
        }
        let healthy = false;
        try {
          healthy = await this.provider.health();
        } catch {
          healthy = false;
        }
        if (healthy) {
          this.resolveWaiters(null);
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          settle(() => reject(new ProviderError("timeout", `llama-server not ready after ${timeoutMs}ms`)));
          return;
        }
        setTimeout(() => void attempt(), 500);
      };
      waiter = (err: Error | null) => {
        if (err) settle(() => reject(err));
      };
      this.waiters.push(waiter);
      void attempt();
    });
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    // A stop cancels any startup still in flight; otherwise a later start()
    // would await the cancelled attempt instead of spawning a fresh one.
    this.starting = null;
    this.inFlight = 0;
    this.idlePostponements = 0;
    const proc = this.process;
    this.process = null;
    if (this.statusValue !== "error") this.statusValue = "stopped";
    if (!proc) return; // already crashed/exited: nothing to wait for
    const released = new Promise<void>((resolve) => {
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      // SIGTERM first, escalate to SIGKILL — but keep waiting for the exit
      // event either way so callers (notably restart()) only continue once
      // the process is really gone and the port is free. The extra timer
      // bounds the wait so an unresponsive child cannot hang unload forever.
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        forceTimer = setTimeout(done, 2_000);
      }, 2_000);
      proc.on("exit", () => {
        clearTimeout(killTimer);
        done();
      });
      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        done();
      }
    });
    // A start() queued behind this stop spawns only after the port is free.
    // The gate clears itself once released: a start() that arrives after
    // stop() resolved skips the await entirely, so its pre-spawn health
    // probe still runs synchronously (a resolved-promise await would defer
    // the probe past callers' flag updates — found by the generation-guard
    // test).
    const gate = released.finally(() => {
      if (this.lastStop === gate) this.lastStop = null;
    });
    this.lastStop = gate;
    await gate;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Called when a generation request starts. Deliberately does NOT clear the
   * armed idle timer: the timer keeps running and, if it fires mid-request,
   * armIdleTimer's callback POSTPONES (bounded by MAX_IDLE_POSTPONEMENTS).
   * Clearing here would make that branch unreachable — a missed endRequest()
   * would leave the counter pinned > 0 with no timer left to ever fire, and
   * the server could never idle-shutdown again (found by the postponement-cap
   * test). A legitimately very long generation can still be shut down after
   * ~4× idleTimeoutMs; that bounded risk is the documented trade-off.
   */
  beginRequest(): void {
    this.inFlight++;
  }

  /** Counterpart to beginRequest(): re-arms idle shutdown once nothing is
   *  in flight. Always safe to call, even without a matching begin. */
  endRequest(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.idlePostponements = 0;
    if (this.inFlight === 0 && this.statusValue === "ready") this.armIdleTimer();
  }

  /** Stop only if `proc` is still the owned process; otherwise kill just
   *  that stale handle so a newer start's server survives. */
  private async stopOwned(proc: SpawnedProcess): Promise<void> {
    if (this.process === proc) {
      await this.stop();
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.cfg.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      // Still generating? Postpone instead of killing an in-flight request.
      // Bounded, so a missing endRequest() can never pin the server forever.
      if (this.inFlight > 0 && this.idlePostponements < MAX_IDLE_POSTPONEMENTS) {
        this.idlePostponements++;
        this.armIdleTimer();
        return;
      }
      void this.stop();
    }, this.cfg.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private fail(message: string): void {
    this.lastError = message;
    this.statusValue = "error";
    this.clearIdleTimer();
  }

  private pushTail(chunk: string): void {
    this.stderrTail.push(chunk);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
  }

  private resolveWaiters(err: Error | null): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(err);
  }
}

/** Real spawner used by the plugin (node:child_process via Obsidian desktop). */
export function createNodeSpawner(): Spawner {
  // Lazy require keeps this module importable in unit tests (no node types
  // beyond the injected interface are used at module scope).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = (globalThis as any).process?.getBuiltinModule?.bind((globalThis as any).process);
  return (command, args) => {
    if (req) {
      const childProcess = req("node:child_process");
      return childProcess.spawn(command, args, { windowsHide: true }) as unknown as SpawnedProcess;
    }
    // Fallback for runtimes without process.getBuiltinModule (older Electron).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const childProcess = require("node:child_process") as typeof import("node:child_process");
    return childProcess.spawn(command, args, { windowsHide: true }) as unknown as SpawnedProcess;
  };
}
