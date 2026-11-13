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
  writeMode?: "insert-below" | "replace" | "translated-copy" | "bilingual";
  sourceLineCount?: number;
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
  const payload = commentPayload({ schemaVersion: SCHEMA_VERSION, ...meta });
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
  return `<!-- ${TRANSLATION_START}\n${commentPayload(meta)}\n-->`;
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
    if (!parsed || typeof parsed !== "object") return null;
    for (const key of [
      "sourceNodeId", "sourceLanguage", "targetLanguage", "sourceHash",
      "model", "glossaryVersion", "promptVersion",
    ] as const) {
      if (typeof parsed[key] !== "string") return null;
    }
    if (typeof parsed.schemaVersion !== "number") return null;
    if (!["fresh", "stale", "pending"].includes(parsed.status)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isTranslationEnd(commentBody: string): boolean {
  return commentBody.trim() === TRANSLATION_END;
}

export function encodeInlineLatex(raw: string, keys?: string[]): string {
  const payload = commentPayload({ raw, ...(keys ? { keys } : {}) });
  return `<!-- scholarbridge:inline-latex ${payload} -->`;
}

function commentPayload(value: unknown): string {
  return stableStringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function decodeInlineLatex(comment: string): { raw: string; keys?: string[] } | null {
  const match = /^<!-- scholarbridge:inline-latex ([\s\S]+) -->$/.exec(comment);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as { raw?: unknown; keys?: unknown };
    if (typeof value.raw !== "string") return null;
    if (value.keys !== undefined && (!Array.isArray(value.keys) || !value.keys.every((key) => typeof key === "string"))) return null;
    return { raw: value.raw, ...(value.keys ? { keys: value.keys as string[] } : {}) };
  } catch {
    return null;
  }
}

export interface TranslationMarker {
  startLine: number;
  contentStartLine: number;
  endLine: number;
  meta: TranslationMeta;
}

/** Only complete, unnested marker pairs outside code fences are writable. */
export function scanTranslationMarkers(lines: string[]): {
  markers: TranslationMarker[];
  invalidStartLines: number[];
} {
  const markers: TranslationMarker[] = [];
  const invalidStartLines: number[] = [];
  const isStart = (line: string): boolean =>
    /^<!--\s*scholarbridge:translation:start(?:\s|$)/.test(line.trim());
  const isEnd = (line: string): boolean =>
    /^<!--\s*scholarbridge:translation:end\s*-->$/.test(line.trim());
  let fence: { char: string; length: number } | null = null;
  const updateFence = (line: string): boolean => {
    const trimmed = line.trim();
    if (fence) {
      if (new RegExp(`^${fence.char}{${fence.length},}$`).test(trimmed)) fence = null;
      return true;
    }
    const match = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (!match || (match[1][0] === "`" && match[2].includes("`"))) return false;
    fence = { char: match[1][0], length: match[1].length };
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    if (updateFence(lines[i]) || !isStart(lines[i])) continue;
    let comment = lines[i];
    let tail = i;
    while (!comment.includes("-->") && tail + 1 < lines.length && !isStart(lines[tail + 1])) {
      comment += "\n" + lines[++tail];
    }
    const meta = comment.includes("-->")
      ? decodeTranslationStart(comment.replace(/^\s*<!--/, "").replace(/-->\s*$/, ""))
      : null;
    if (!meta) {
      invalidStartLines.push(i);
      continue;
    }
    let end = tail + 1;
    for (; end < lines.length; end++) {
      if (updateFence(lines[end])) continue;
      if (isStart(lines[end]) || isEnd(lines[end])) break;
    }
    if (end >= lines.length || !isEnd(lines[end])) {
      invalidStartLines.push(i);
      fence = null;
      continue;
    }
    markers.push({ startLine: i, contentStartLine: tail + 1, endLine: end, meta });
    i = end;
  }
  return { markers, invalidStartLines };
}
