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
  topP: number;
  topK: number;
  /** Maximum generated tokens per request; 0 uses the server default. */
  maxTokens: number;
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
  /** Custom translator instructions; empty uses the default prompt. */
  customPrompt: string;
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
    topP: 0.95,
    topK: 40,
    maxTokens: 0,
    idleShutdownMinutes: 10,
    requestTimeoutMs: 120_000,
    confirmSpawn: true,
  },
  sourceLanguage: "zh",
  targetLanguage: "en",
  translationStyle: "academic",
  customPrompt: "",
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

export const LLAMA_NUMBER_RULES = {
  port: { min: 1, max: 65535, integer: true },
  gpuLayers: { min: 0, max: 1000, integer: true },
  contextSize: { min: 256, max: 1_000_000, integer: true },
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false },
  topK: { min: 0, max: 1_000_000, integer: true },
  maxTokens: { min: 0, max: 1_000_000, integer: true },
  idleShutdownMinutes: { min: 0, max: 1440, integer: true },
  requestTimeoutMs: { min: 1000, max: 3_600_000, integer: true },
} as const;
export type LlamaNumberKey = keyof typeof LLAMA_NUMBER_RULES;

export function parseLlamaNumber(key: LlamaNumberKey, text: string): number | null {
  const value = Number(text);
  const rule = LLAMA_NUMBER_RULES[key];
  return text.trim() && Number.isFinite(value) && (!rule.integer || Number.isSafeInteger(value)) &&
    value >= rule.min && value <= rule.max ? value : null;
}

export function validateLlamaSettings(llama: LlamaSettings): void {
  for (const key of Object.keys(LLAMA_NUMBER_RULES) as LlamaNumberKey[]) {
    if (typeof llama[key] !== "number" || parseLlamaNumber(key, String(llama[key])) === null) {
      const rule = LLAMA_NUMBER_RULES[key];
      throw new Error(`${key} must be ${rule.integer ? "an integer" : "a number"} between ${rule.min} and ${rule.max}`);
    }
  }
  if (typeof llama.host !== "string" || !llama.host.trim() || /[\s/\\?#@]/.test(llama.host)) {
    throw new Error("host must be a hostname or IP address");
  }
}

/**
 * Clamp numeric llama settings coming from disk. A hand-edited or corrupted
 * data.json must not be able to push an out-of-range port into the spawn
 * arguments, a negative timeout into the request path, or an empty host into
 * the URL the client builds.
 */
export function sanitizeLlamaSettings(llama: LlamaSettings): LlamaSettings {
  const d = DEFAULT_SETTINGS.llama;
  const result = {
    ...d, ...llama,
    executablePath: typeof llama.executablePath === "string" ? llama.executablePath.trim() : "",
    modelPath: typeof llama.modelPath === "string" ? llama.modelPath.trim() : "",
    confirmSpawn: typeof llama.confirmSpawn === "boolean" ? llama.confirmSpawn : d.confirmSpawn,
    host: typeof llama.host === "string" && llama.host.trim() ? llama.host.trim() : d.host,
  };
  for (const key of Object.keys(LLAMA_NUMBER_RULES) as LlamaNumberKey[]) {
    const rule = LLAMA_NUMBER_RULES[key];
    let value = typeof llama[key] === "number" && Number.isFinite(llama[key]) ? llama[key] : d[key];
    if (rule.integer) value = Math.round(value);
    result[key] = Math.min(rule.max, Math.max(rule.min, value));
  }
  if (/[\s/\\?#@]/.test(result.host)) result.host = d.host;
  return result;
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
