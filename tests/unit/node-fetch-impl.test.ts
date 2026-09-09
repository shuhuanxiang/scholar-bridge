import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createNodeFetchImpl, nodeFetchSupports } from "../../src/translation/llama/node-fetch-impl";
import { LlamaClient } from "../../src/translation/llama/client";

/**
 * The Node-backed loopback transport (node-fetch-impl.ts): the platform fetch
 * rides Chromium's network stack where proxy tools can blackhole 127.0.0.1,
 * which made a healthy llama-server look unreachable and got it killed by the
 * readiness poll. These tests pin the adapter's contract.
 */

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === "/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ got: Buffer.concat(chunks).toString("utf-8") }));
      });
      return;
    }
    if (req.url === "/boom") {
      res.writeHead(500);
      res.end('{"error":"nope"}');
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200);
      res.end("x".repeat(9 * 1024 * 1024));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("nodeFetchSupports", () => {
  it("accepts plain-http loopback URLs", () => {
    expect(nodeFetchSupports(`http://127.0.0.1:${port}/health`)).toBe(true);
    expect(nodeFetchSupports("http://localhost:8080/v1/chat/completions")).toBe(true);
  });

  it("rejects non-loopback and non-http URLs", () => {
    expect(nodeFetchSupports("http://192.168.1.10:8080/health")).toBe(false);
    expect(nodeFetchSupports(`https://127.0.0.1:${port}/health`)).toBe(false);
    expect(nodeFetchSupports("not a url")).toBe(false);
  });
});

describe("createNodeFetchImpl", () => {
  const impl = createNodeFetchImpl();

  it("performs a GET and returns status/ok/text", async () => {
    const res = await impl(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ status: "ok" });
  });

  it("delivers a POST body", async () => {
    const res = await impl(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"blocks":[{"id":"b1"}]}',
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(await res.text())).toEqual({ got: '{"blocks":[{"id":"b1"}]}' });
  });

  it("surfaces non-2xx statuses with the body intact", async () => {
    const res = await impl(`http://127.0.0.1:${port}/boom`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("nope");
  });

  it("rejects a pre-aborted signal instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      impl(`http://127.0.0.1:${port}/health`, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("rejects when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const pending = impl(`http://127.0.0.1:${port}/big`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrow();
  });

  it("rejects an oversized response instead of buffering it", async () => {
    await expect(impl(`http://127.0.0.1:${port}/big`)).rejects.toThrow(/exceeded/);
  });
});

describe("LlamaClient default transport", () => {
  it("health() succeeds over the loopback transport with no injected fetch", async () => {
    const client = LlamaClient.fromBaseUrl("127.0.0.1", port, "m", 5_000);
    await expect(client.health()).resolves.toBe(true);
  });

  it("health() returns false when nothing listens", async () => {
    const client = LlamaClient.fromBaseUrl("127.0.0.1", 1, "m", 2_000);
    await expect(client.health()).resolves.toBe(false);
  });
});
