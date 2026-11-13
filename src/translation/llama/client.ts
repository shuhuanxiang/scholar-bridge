import {
  ProviderError,
  type ChatMessage,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from "../provider";
import { createNodeFetchImpl, nodeFetchSupports } from "./node-fetch-impl";
import { buildTranslationMessages } from "../prompt";

/**
 * llama.cpp client, Phase A: connect to an already-running `llama-server`
 * (OpenAI-compatible endpoints, TECHNICAL_DESIGN.md §10.4).
 *
 * HTTP goes through Node's `http` module for loopback URLs so system proxy
 * tools cannot blackhole requests to a healthy local server; everything else
 * uses the platform `fetch`. An injected `fetchImpl` (tests) always wins.
 */

export interface LlamaClientOptions {
  baseUrl: string;
  model: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Invoked at the very top of every chat() so the caller can bump the
   * server's idle timer before generation starts (prevents an idle
   * shutdown from killing an in-flight request).
   */
  onRequestStart?: () => void;
  /**
   * Invoked once a chat() settles (success or failure) so the caller can
   * release the idle-timer suspension taken by onRequestStart.
   */
  onRequestEnd?: () => void;
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    body?: unknown;
  }>;
}

/** Minimal shape of a WHATWG ReadableStream we rely on for bounded reads. */
interface StreamLike {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
  };
}

/**
 * Default transport: Node's `http` stack for loopback URLs — the platform
 * fetch rides Chromium's network stack, where proxy tools (Clash Verge TUN,
 * stale system-proxy state) can make a healthy 127.0.0.1 server unreachable
 * and the start readiness poll kill it. Non-loopback endpoints and environments
 * without Node builtins keep the platform fetch.
 */
function loopbackFirstFetchImpl(): FetchLike {
  const platform = fetch as unknown as FetchLike;
  try {
    const nodeImpl = createNodeFetchImpl();
    return (url, init) => (nodeFetchSupports(url) ? nodeImpl(url, init) : platform(url, init));
  } catch {
    return platform;
  }
}

export class LlamaClient implements TranslationProvider {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private fetchImpl: FetchLike;
  private signal?: AbortSignal;

  /**
   * Invoked at the very top of every chat() so the caller can bump the
   * server's idle timer before generation starts (prevents an idle
   * shutdown from killing an in-flight request). Settable via the
   * constructor options or by direct assignment.
   */
  /** Upper bound on a single response body (8 MiB). A runaway or hostile
   *  server must not be able to grow the renderer's heap without limit. */
  static readonly MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

  onRequestStart?: () => void;

  /**
   * Invoked once a chat() settles (success or failure) so the caller can
   * release the idle-timer suspension taken in onRequestStart.
   */
  onRequestEnd?: () => void;

  constructor(opts: LlamaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? loopbackFirstFetchImpl();
    this.signal = opts.signal;
    this.onRequestStart = opts.onRequestStart;
    this.onRequestEnd = opts.onRequestEnd;
  }

  static fromBaseUrl(host: string, port: number, model: string, timeoutMs?: number, signal?: AbortSignal): LlamaClient {
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return new LlamaClient({ baseUrl: `http://${hostname}:${port}`, model, timeoutMs, signal });
  }
  /** GET /health — llama-server returns 200 when the model is loaded. */
  async health(): Promise<boolean> {
    try {
      const res = await this.request(`${this.baseUrl}/health`, { method: "GET" }, 5_000);
      return res.ok;
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === "unavailable" || err.kind === "timeout" || err.kind === "http")) {
        return false;
      }
      throw err;
    }
  }

  async chat(
    messages: ChatMessage[],
    temperature: number,
    signal?: AbortSignal,
    sampling: Pick<TranslationRequest, "topP" | "topK" | "maxTokens"> = {},
  ): Promise<{ content: string; model: string }> {
    this.onRequestStart?.();
    try {
      return await this.chatOnce(messages, temperature, signal, sampling);
    } finally {
      // Always release the idle-timer suspension, even on error/abort —
      // otherwise one failed request would keep the server alive forever.
      this.onRequestEnd?.();
    }
  }

  private async chatOnce(
    messages: ChatMessage[],
    temperature: number,
    signal: AbortSignal | undefined,
    sampling: Pick<TranslationRequest, "topP" | "topK" | "maxTokens">,
  ): Promise<{ content: string; model: string }> {
    const res = await this.request(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature,
          top_p: sampling.topP,
          top_k: sampling.topK,
          ...(sampling.maxTokens && sampling.maxTokens > 0 ? { max_tokens: sampling.maxTokens } : {}),
          stream: false,
        }),
        signal,
      },
      this.timeoutMs,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new ProviderError("malformed", "chat completion returned non-JSON body");
    }
    const obj = parsed as { choices?: { message?: { content?: string }; finish_reason?: string }[]; model?: string } | null;
    const content = obj?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderError("malformed", "chat completion missing choices[0].message.content");
    }
    if (obj?.choices?.[0]?.finish_reason === "length") {
      throw new ProviderError("malformed", "generation reached its token limit; increase the output limit or context size, or translate less text");
    }
    return { content, model: typeof obj?.model === "string" ? obj.model : this.model };
  }

  /**
   * Translate a batch: one chat request carrying every protected block, with
   * a JSON response contract validated by the caller (translation.ts).
   */
  async translate(req: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult> {
    const { content, model } = await this.chat(
      buildTranslationMessages(req),
      req.temperature ?? 0.2,
      signal,
      req,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(content));
    } catch {
      throw new ProviderError("malformed", "translation response is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || !("blocks" in parsed) || !Array.isArray(parsed.blocks)) {
      throw new ProviderError("malformed", "translation response missing blocks array");
    }
    const blocks = parsed.blocks.map((block: unknown) => {
      if (!block || typeof block !== "object" || !("id" in block) || typeof block.id !== "string" ||
        !block.id.trim() || !("translation" in block) || typeof block.translation !== "string") {
        throw new ProviderError("malformed", "translation response blocks require string ids and translations");
      }
      return { id: block.id, translation: block.translation };
    });
    return { blocks, raw: content, model };
  }

  /**
   * Fetch + full body read under one timeout/abort scope: the response body
   * is consumed here so a post-header stall hits the same deadline instead
   * of hanging forever after the timer was cleared.
   */
  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const outers = [...new Set([init.signal, this.signal].filter((signal): signal is AbortSignal => Boolean(signal)))];
    if (outers.some((signal) => signal.aborted)) {
      throw new ProviderError("aborted", "request aborted before it was sent");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("timeout", "TimeoutError"));
    }, timeoutMs);
    const onOuterAbort = () => controller.abort(new DOMException("aborted", "AbortError"));
    for (const signal of outers) signal.addEventListener("abort", onOuterAbort);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        // Drain before throwing: an unconsumed body keeps the socket out of
        // the pool, and health() polls every 500ms would leak one each time.
        await this.safeDrain(res);
        throw new ProviderError("http", `llama-server HTTP ${res.status} for ${url}`, res.status);
      }
      const text = await this.readBounded(res);
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // Distinguish the abort causes: a caller cancel is not a server fault.
      if (outers.some((signal) => signal.aborted)) {
        throw new ProviderError("aborted", "request aborted");
      }
      if (timedOut) {
        throw new ProviderError("timeout", `llama-server request timed out after ${timeoutMs}ms`);
      }
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderError("timeout", `llama-server request timed out after ${timeoutMs}ms`);
      }
      throw new ProviderError("unavailable", `cannot reach llama-server at ${this.baseUrl}: ${String(err)}`);
    } finally {
      window.clearTimeout(timer);
      for (const signal of outers) signal.removeEventListener("abort", onOuterAbort);
    }
  }

  /** Release a discarded response body; never throws. */
  private async safeDrain(res: { text(): Promise<string> }): Promise<void> {
    try {
      await res.text();
    } catch {
      /* aborted or already consumed — nothing to release */
    }
  }

  /**
   * Read the body with a hard size ceiling. Streams when the platform
   * exposes a ReadableStream so an oversized response is cut off mid-flight
   * instead of being materialised in full; falls back to text() otherwise.
   */
  private async readBounded(res: { text(): Promise<string>; body?: unknown }): Promise<string> {
    const limit = LlamaClient.MAX_RESPONSE_BYTES;
    const stream = res.body as StreamLike | null | undefined;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      let out = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength ?? 0;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new ProviderError("malformed", `llama-server response exceeded ${limit} bytes`);
        }
        out += decoder.decode(value, { stream: true });
      }
      return out + decoder.decode();
    }
    const text = await res.text();
    if (text.length > limit) {
      throw new ProviderError("malformed", `llama-server response exceeded ${limit} bytes`);
    }
    return text;
  }
}

/**
 * Tolerate models that wrap JSON in ```json fences or add prose around it.
 * Prefers an already-valid body, then a fence, then the FIRST BALANCED {…}
 * object — first{…last} alone breaks when trailing prose contains a "}"
 * (CODE_REVIEW_R2 P3-2).
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();
  try {
    JSON.parse(trimmed);
    return trimmed; // already valid JSON — no slicing needed
  } catch {
    /* keep extracting */
  }
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fence) return fence[1].trim();
  const balanced = firstBalancedObject(trimmed);
  if (balanced) return balanced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** First brace-balanced {…} span, ignoring braces inside JSON strings. */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
