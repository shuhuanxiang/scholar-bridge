/**
 * Plugin settings types and defaults.
 *
 * Binding constraints (PRODUCT_REQUIREMENTS.md §5):
 * - Local translation defaults to 127.0.0.1.
 * - The model is never started as a side effect of plugin load by default;
 *   the opt-in `autoStartTranslator` convenience brings it up after the
 *   workspace layout is ready — on explicit user configuration, still
 *   honouring the confirm-spawn dialog.
 */

export type PasteMode = "auto" | "ask" | "never";

export type TranslationWriteMode =
  | "insert-below"
  | "replace"
  | "translated-copy"
  | "bilingual";

export interface LlamaSettings {
  /** Path to the llama.cpp `llama-server` executable. Empty = connect-only mode. */
  executablePath: string;
  /** Path to the GGUF model file. */
  modelPath: string;
  host: string;
  port: number;
  gpuLayers: number;
  contextSize: number;
  temperature: number;
  /** Idle shutdown timeout in minutes; 0 disables idle shutdown. */
  idleShutdownMinutes: number;
  /** Per-request translation timeout in ms (minimum 1000). */
  requestTimeoutMs: number;
  /** Ask before spawning the local server process. */
  confirmSpawn: boolean;
}

export interface ScholarBridgeSettings {
  pasteMode: PasteMode;
  llama: LlamaSettings;
  sourceLanguage: string;
  targetLanguage: string;
  translationStyle: "academic" | "plain" | "literal";
  writeMode: TranslationWriteMode;
  /** Bring the local translator up after Obsidian opens (opt-in convenience). */
  autoStartTranslator: boolean;
  /** Glossary entries: term -> fixed translation, or "preserve" to keep verbatim. */
  glossary: Record<string, string>;
  diff: {
    ignoreWhitespace: boolean;
    ignoreWrappers: boolean;
    ignoreCitations: boolean;
    caseSensitive: boolean;
  };
}

export const DEFAULT_SETTINGS: ScholarBridgeSettings = {
  pasteMode: "ask",
  llama: {
    executablePath: "",
    modelPath: "",
    host: "127.0.0.1",
    port: 8080,
    gpuLayers: 0,
    contextSize: 4096,
    temperature: 0.2,
    idleShutdownMinutes: 10,
    requestTimeoutMs: 120_000,
    confirmSpawn: true,
  },
  sourceLanguage: "zh",
  targetLanguage: "en",
  translationStyle: "academic",
  writeMode: "insert-below",
  autoStartTranslator: false,
  glossary: {},
  diff: {
    ignoreWhitespace: true,
    ignoreWrappers: true,
    ignoreCitations: false,
    caseSensitive: true,
  },
};

/**
 * Clamp numeric llama settings coming from disk. A hand-edited or corrupted
 * data.json must not be able to push an out-of-range port into the spawn
 * arguments, a negative timeout into the request path, or an empty host into
 * the URL the client builds.
 */
export function sanitizeLlamaSettings(llama: LlamaSettings): LlamaSettings {
  const d = DEFAULT_SETTINGS.llama;
  const int = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const temperature =
    typeof llama.temperature === "number" && Number.isFinite(llama.temperature)
      ? Math.min(2, Math.max(0, llama.temperature))
      : d.temperature;
  return {
    ...llama,
    host: typeof llama.host === "string" && llama.host.trim() ? llama.host.trim() : d.host,
    port: int(llama.port, d.port, 1, 65535),
    gpuLayers: int(llama.gpuLayers, d.gpuLayers, 0, 1000),
    contextSize: int(llama.contextSize, d.contextSize, 256, 1_000_000),
    temperature,
    idleShutdownMinutes: int(llama.idleShutdownMinutes, d.idleShutdownMinutes, 0, 1440),
    requestTimeoutMs: int(llama.requestTimeoutMs, d.requestTimeoutMs, 1_000, 3_600_000),
  };
}

/**
 * Keep only well-formed glossary entries (string term -> string action). The
 * glossary lives in user-editable data.json; a corrupted value (string,
 * array, nested object) previously degraded into a char-indexed object that
 * then fed garbage terms into the protector and diff atomicTerms.
 */
export function sanitizeGlossary(stored: unknown): Record<string, string> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const out: Record<string, string> = {};
  for (const [term, action] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof action === "string") out[term] = action;
  }
  return out;
}
