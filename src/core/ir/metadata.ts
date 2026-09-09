/**
 * ScholarBridge hidden metadata comments (TECHNICAL_DESIGN.md §7).
 *
 * Visible form in the note:
 *
 *   <!-- scholarbridge
 *   {"schemaVersion":1,"type":"equation","label":"eq:loss"}
 *   -->
 *
 * Translation blocks use paired markers:
 *
 *   <!-- scholarbridge:translation:start {json} -->
 *   translated text
 *   <!-- scholarbridge:translation:end -->
 *
 * JSON payloads are stringified with sorted keys so serialization is
 * byte-deterministic. If a payload is not valid JSON the comment is treated
 * as a plain comment and never destroys surrounding content.
 */

export const SCHEMA_VERSION = 1;

export const META_PREFIX = "scholarbridge";
export const TRANSLATION_START = "scholarbridge:translation:start";
export const TRANSLATION_END = "scholarbridge:translation:end";

export interface ScholarBridgeMeta {
  schemaVersion: number;
  /** IR type of the annotated block ("equation", "figure", "table", …). */
  type: string;
  /** Free-form, schema-versioned attributes (label, environment, …). */
  [key: string]: unknown;
}

export interface TranslationMeta {
  schemaVersion: number;
  sourceNodeId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceHash: string;
  model: string;
  glossaryVersion: string;
  promptVersion: string;
  status: "fresh" | "stale" | "pending";
  translatedAt?: string;
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(source).sort()) {
      out[k] = sortValue(source[k]);
    }
    return out;
  }
  return value;
}

export function encodeMetaComment(meta: Record<string, unknown>): string {
  const payload = stableStringify({ schemaVersion: SCHEMA_VERSION, ...meta });
  return `<!-- ${META_PREFIX}\n${payload}\n-->`;
}

/**
 * Parse the JSON body of a `scholarbridge` comment.
 * Returns null for any non-scholarbridge or malformed comment.
 */
export function decodeMetaComment(commentBody: string): ScholarBridgeMeta | null {
  const trimmed = commentBody.trim();
  if (!trimmed.startsWith(META_PREFIX)) return null;
  const json = trimmed.slice(META_PREFIX.length).trim();
  if (!json.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const { schemaVersion, type, ...rest } = parsed;
    if (typeof schemaVersion !== "number") return null;
    return {
      schemaVersion,
      type: typeof type === "string" ? type : "unknown",
      ...rest,
    };
  } catch {
    return null;
  }
}

export function encodeTranslationStart(meta: TranslationMeta): string {
  return `<!-- ${TRANSLATION_START}\n${stableStringify(meta)}\n-->`;
}

export function encodeTranslationEnd(): string {
  return `<!-- ${TRANSLATION_END} -->`;
}

export function decodeTranslationStart(commentBody: string): TranslationMeta | null {
  const trimmed = commentBody.trim();
  if (!trimmed.startsWith(TRANSLATION_START)) return null;
  const json = trimmed.slice(TRANSLATION_START.length).trim();
  if (!json.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(json) as TranslationMeta;
    if (typeof parsed.sourceNodeId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isTranslationEnd(commentBody: string): boolean {
  return commentBody.trim() === TRANSLATION_END;
}
