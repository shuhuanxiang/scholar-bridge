/**
 * Translation cache (TECHNICAL_DESIGN.md §15, IMPLEMENTATION_PLAN.md M9).
 *
 * Key: hash(normalized source + source language + target language + style +
 * temperature + model identity + prompt version + glossary version).
 * Value: the final, validated, placeholder-restored translation.
 *
 * Only validated output ever reaches `put()` — the cache is written from the
 * translation pipeline after protection validation, so malformed model output
 * can never be cached (Milestone 9 rule: do not cache invalid placeholder
 * outputs).
 */

/**
 * Local 64-bit key hash: FNV-1a and FNV-1 over the same ingredients,
 * concatenated (kept private to avoid a cycle with translator.ts). Two
 * 32-bit lanes put a collision across the 500-entry bound at ~1e-13 instead
 * of ~3e-5 for a single lane (R3 P3-2) — a collision here would silently
 * serve the WRONG translation, so the margin is worth two passes.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fnv1(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash, 0x01000193);
    hash ^= text.charCodeAt(i);
  }
  return hash >>> 0;
}

/** LRU bound on cached entries; keeps data.json from growing without limit. */
export const CACHE_MAX_ENTRIES = 500;

export interface CacheContext {
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  style: string;
  temperature?: number;
  /** Model identity: model file path, or endpoint for connect-only mode. */
  modelIdentity: string;
  promptVersion: string;
  glossaryVersion: string;
}

/** Deterministic cache key from the §15 key ingredients. */
export function cacheKey(ctx: CacheContext): string {
  const temperature =
    ctx.temperature === undefined ? "default" : Number(ctx.temperature).toFixed(2);
  const ingredients = [
    ctx.sourceText.trim(),
    ctx.sourceLanguage,
    ctx.targetLanguage,
    ctx.style,
    temperature,
    ctx.modelIdentity,
    ctx.promptVersion,
    ctx.glossaryVersion,
  ].join("\u0000");
  return `t_${fnv1a(ingredients).toString(16)}_${fnv1(ingredients).toString(16)}`;
}

export interface SerializedTranslationCache {
  /** Schema for future migrations. */
  version: 1;
  entries: Record<string, string>;
}

export class TranslationCache {
  private entries = new Map<string, string>();

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    // Map preserves insertion order: re-inserting on hit refreshes recency.
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  put(key: string, translation: string): void {
    if (!translation.trim()) return;
    this.entries.delete(key); // refresh position before the size check
    this.entries.set(key, translation);
    while (this.entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  toJSON(): SerializedTranslationCache {
    return { version: 1, entries: Object.fromEntries(this.entries) };
  }

  /** Load persisted entries; non-string garbage from a hand-edited file is dropped. */
  static fromJSON(data: unknown): TranslationCache {
    const cache = new TranslationCache();
    const raw = (data as SerializedTranslationCache | null | undefined)?.entries;
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") cache.entries.set(key, value);
        if (cache.entries.size >= CACHE_MAX_ENTRIES) break;
      }
    }
    return cache;
  }
}
