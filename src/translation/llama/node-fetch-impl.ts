import type { FetchLike } from "./client";

/**
 * Node-backed FetchLike for llama-server calls.
 *
 * The platform `fetch` runs on Chromium's network stack, which honours the OS
 * proxy configuration. Proxy tools (Clash Verge, v2rayN, TUN adapters) — even
 * toggled off mid-session or with a stale "bypass list" — can blackhole
 * loopback requests so a healthy local llama-server looks unreachable and the
 * readiness poll kills it after the start timeout. Node's `http` module never
 * consults a proxy, so localhost traffic is immune by construction.
 */

/** Mirrors LlamaClient.MAX_RESPONSE_BYTES; kept local to avoid an import cycle. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type HttpModule = typeof import("node:http");
type IncomingMessage = import("node:http").IncomingMessage;

function builtin(name: "node:http" | "node:https"): HttpModule {
  if (
    typeof process !== "undefined" &&
    typeof process.getBuiltinModule === "function"
  ) {
    return process.getBuiltinModule(name) as HttpModule;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name) as HttpModule;
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1");
}

/** True when this adapter should be used (Node builtins reachable, plain-HTTP loopback URL). */
export function nodeFetchSupports(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") return false;
    if (!isLoopbackUrl(parsed)) return false;
    builtin("node:http");
    return true;
  } catch {
    return false;
  }
}

function abortableError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function readMessage(res: IncomingMessage, reject: (err: Error) => void, settle: (body: string) => void): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let settled = false;
  res.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) {
      if (!settled) {
        settled = true;
        res.destroy();
        reject(abortableError("Error", `response body exceeded ${MAX_RESPONSE_BYTES} bytes`));
      }
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    if (settled) return;
    settled = true;
    settle(Buffer.concat(chunks).toString("utf-8"));
  });
  res.on("error", (err) => {
    if (settled) return;
    settled = true;
    reject(err);
  });
}

/**
 * Build a FetchLike backed by Node's http/https modules. Throws when the
 * Node builtins are unavailable so the caller can fall back to platform fetch.
 */
export function createNodeFetchImpl(): FetchLike {
  const http = builtin("node:http");
  const https = builtin("node:https");

  const impl: FetchLike = (url, init) =>
    new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(err as Error);
        return;
      }
      const mod = parsed.protocol === "https:" ? https : http;
      const signal = init?.signal;

      let req: import("node:http").ClientRequest;
      try {
        req = mod.request(parsed, {
          method: init?.method ?? "GET",
          headers: init?.headers ?? {},
        }, (res) => {
          const status = res.statusCode ?? 0;
          readMessage(
            res,
            reject,
            (body) => {
              resolve({
                ok: status >= 200 && status < 300,
                status,
                text: async () => body,
              });
            },
          );
        });
      } catch (err) {
        reject(err as Error);
        return;
      }

      req.on("error", reject);
      if (signal) {
        const onAbort = (): void => {
          req.destroy(abortableError("AbortError", "request aborted"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }
      if (init?.body != null) req.write(init.body);
      req.end();
    });

  return impl;
}
