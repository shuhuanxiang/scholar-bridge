import type { ScholarBlockNode, ScholarDocument } from "../core/ir/nodes";
import { blockComparableText } from "../diff/node-text";
import type { TranslationProvider, TranslationRequest } from "./provider";
import { ProviderError } from "./provider";
import { cacheKey, type TranslationCache } from "./cache";
import {
  protectBlock,
  relevantGlossary,
  restorePlaceholders,
  validateProtection,
  type PlaceholderInfo,
  type ProtectionResult,
} from "./protector";

/**
 * Translation orchestration (TECHNICAL_DESIGN.md §11–§12, §16).
 *
 * Flow per batch: pick translatable blocks → protect spans → send → validate
 * structured output → restore placeholders. Invalid output never reaches the
 * note (TEST_PLAN §10–§11).
 */

export const PROMPT_VERSION = "v1";

export interface TranslatableBlock {
  nodeId: string;
  type: string;
  sourceText: string;
}

/** Blocks that contain prose worth translating; code/raw blocks never sent. */
export function collectTranslatableBlocks(doc: ScholarDocument): TranslatableBlock[] {
  const out: TranslatableBlock[] = [];
  for (const node of doc.children) {
    if (node.type === "paragraph" || node.type === "heading") {
      const text = blockComparableText(node, {
        ignoreWhitespace: true,
        ignoreWrappers: false,
        ignoreCitations: false,
        caseSensitive: true,
      }).trim();
      if (hasTranslatableProse(text)) {
        out.push({ nodeId: node.id, type: node.type, sourceText: text });
      }
    }
  }
  return out;
}

/** True when the text contains letters beyond math/code-only content. */
export function hasTranslatableProse(text: string): boolean {
  const stripped = text
    .replace(/\$[^$]*\$/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/https?:\/\/\S+/g, "");
  return /[A-Za-z\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(stripped);
}

export interface TranslateBlocksOptions {
  glossary?: Record<string, string>;
  glossaryVersion?: string;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Overrides the per-request source-character budget used to split the
   * batch into sequential provider requests (tests force small budgets).
   */
  chunkCharBudget?: number;
  /**
   * Persistent translation cache (TECHNICAL_DESIGN.md §15). When set, blocks
   * whose cache key hits are served without a provider request; validated
   * results are stored for next time. Retry flows should omit the cache to
   * force a fresh translation.
   */
  cache?: TranslationCache;
  /** Model identity participating in the cache key (model file or endpoint). */
  modelIdentity?: string;
  /** Called once when the run stored new cache entries (persist hook). */
  onCacheDirty?: () => void;
}

/**
 * Protected-source characters per provider request (~750–1000 tokens against
 * the default 4096-token context). One overflowing batch must not get the
 * whole job rejected, so large batches are split and sent sequentially.
 */
export const DEFAULT_CHUNK_CHAR_BUDGET = 3000;

export interface TranslatedBlock {
  nodeId: string;
  sourceText: string;
  translation: string;
  glossaryVersion: string;
}

export class TranslationValidationError extends ProviderError {
  problems: string[];

  constructor(problems: string[]) {
    super("malformed", `translation output rejected: ${problems.join("; ")}`);
    this.name = "TranslationValidationError";
    this.problems = problems;
  }
}

interface PreparedBlock {
  block: TranslatableBlock;
  protection: ProtectionResult;
  relevant: Record<string, string>;
}

/** Translate a batch of blocks; throws before returning anything if a chunk
 *  fails and no chunk succeeded. With multiple chunks, a failed chunk fails
 *  only its own blocks: they are omitted from the result and reported in
 *  `problems`. Cache hits (opts.cache) skip the provider entirely; only
 *  provider-validated output is written back to the cache. */
export async function translateBlocks(
  provider: TranslationProvider,
  blocks: TranslatableBlock[],
  opts: TranslateBlocksOptions & { sourceLanguage: string; targetLanguage: string; style: string },
): Promise<{ blocks: TranslatedBlock[]; model: string; problems?: string[] }> {
  if (blocks.length === 0) return { blocks: [], model: "none" };

  const glossary = opts.glossary ?? {};
  const resolvedGlossaryVersion = opts.glossaryVersion ?? glossaryVersion(glossary);

  // Cache lookup (§15): a hit serves the final translation with no request.
  const cached = new Map<string, TranslatedBlock>();
  let pending = blocks;
  if (opts.cache) {
    pending = [];
    for (const b of blocks) {
      const key = cacheKey({
        sourceText: b.sourceText,
        sourceLanguage: opts.sourceLanguage,
        targetLanguage: opts.targetLanguage,
        style: opts.style,
        temperature: opts.temperature,
        modelIdentity: opts.modelIdentity ?? "",
        promptVersion: PROMPT_VERSION,
        glossaryVersion: resolvedGlossaryVersion,
      });
      const hit = opts.cache.get(key);
      if (hit === undefined) pending.push(b);
      else {
        cached.set(b.nodeId, {
          nodeId: b.nodeId,
          sourceText: b.sourceText,
          translation: hit,
          glossaryVersion: resolvedGlossaryVersion,
        });
      }
    }
    if (pending.length === 0) {
      return {
        blocks: blocks.map((b) => cached.get(b.nodeId)!),
        model: opts.modelIdentity || "cache",
      };
    }
  }

  const prepared = pending.map((b) => {
    const protection = protectBlock(b.sourceText, { glossary });
    const relevant = relevantGlossary(b.sourceText, glossary, { placeholders: protection.placeholders });
    return { block: b, protection, relevant };
  });

  // Greedy sequential chunking bounded by protected source characters keeps
  // request count minimal while bounding context use per request.
  const budget = Math.max(1, opts.chunkCharBudget ?? DEFAULT_CHUNK_CHAR_BUDGET);
  const chunks: PreparedBlock[][] = [];
  let current: PreparedBlock[] = [];
  let size = 0;
  for (const p of prepared) {
    const len = p.protection.protectedText.length;
    if (current.length > 0 && size + len > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += len;
  }
  if (current.length > 0) chunks.push(current);

  const blocksOut: TranslatedBlock[] = [];
  const problems: string[] = [];
  let model = "none";
  let cacheDirty = false;
  const runChunk = async (chunk: PreparedBlock[]): Promise<void> => {
    const res = await translateOneChunk(provider, chunk, glossary, opts, resolvedGlossaryVersion);
    blocksOut.push(...res.blocks);
    model = res.model;
    if (opts.cache && res.stored) {
      for (const b of res.blocks) {
        const key = cacheKey({
          sourceText: b.sourceText,
          sourceLanguage: opts.sourceLanguage,
          targetLanguage: opts.targetLanguage,
          style: opts.style,
          temperature: opts.temperature,
          modelIdentity: opts.modelIdentity ?? "",
          promptVersion: PROMPT_VERSION,
          glossaryVersion: resolvedGlossaryVersion,
        });
        opts.cache.put(key, b.translation);
      }
      cacheDirty = true;
    }
  };
  for (const chunk of chunks) {
    try {
      await runChunk(chunk);
    } catch (err) {
      if (chunk.length > 1 && err instanceof TranslationValidationError) {
        // Multi-block batches hinge on the model echoing one JSON entry per
        // block id; as the batch grows, small translation models drop or
        // merge ids (or mangle a placeholder), and validation then rejects
        // the whole chunk all-or-nothing. Retry each block on its own — the
        // shape small models handle reliably — so one slip costs one extra
        // request instead of the entire batch.
        for (const p of chunk) {
          try {
            await runChunk([p]);
          } catch (blockErr) {
            const message = blockErr instanceof Error ? blockErr.message : String(blockErr);
            problems.push(`blocks ${p.block.nodeId}: ${message}`);
          }
        }
        continue;
      }
      if (chunks.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`blocks ${chunk.map((p) => p.block.nodeId).join(", ")}: ${message}`);
    }
  }
  if (cacheDirty) opts.onCacheDirty?.();
  const all = [...cached.values(), ...blocksOut].sort(
    (a, b) => blocks.findIndex((b0) => b0.nodeId === a.nodeId) - blocks.findIndex((b0) => b0.nodeId === b.nodeId),
  );
  return problems.length > 0 ? { blocks: all, model, problems } : { blocks: all, model };
}

/** Validate and translate one chunk (the pre-chunking whole-batch logic).
 *  `stored: true` marks provider-translated output eligible for the cache. */
async function translateOneChunk(
  provider: TranslationProvider,
  prepared: PreparedBlock[],
  glossary: Record<string, string>,
  opts: TranslateBlocksOptions & { sourceLanguage: string; targetLanguage: string; style: string },
  resolvedGlossaryVersion: string,
): Promise<{ blocks: TranslatedBlock[]; model: string; stored: boolean }> {
  const request: TranslationRequest = {
    blocks: prepared.map((p) => ({ id: p.block.nodeId, text: p.protection.protectedText })),
    sourceLanguage: opts.sourceLanguage,
    targetLanguage: opts.targetLanguage,
    style: opts.style,
    temperature: opts.temperature,
  };

  const result = await provider.translate(request, opts.signal);

  // §12 validation: same ids, no unknowns, same count.
  const requestedIds = new Set(request.blocks.map((b) => b.id));
  const returnedIds = new Set(result.blocks.map((b) => b.id));
  const problems: string[] = [];
  for (const id of requestedIds) if (!returnedIds.has(id)) problems.push(`missing block ${id}`);
  for (const id of returnedIds) if (!requestedIds.has(id)) problems.push(`unknown block ${id}`);
  if (result.blocks.length !== request.blocks.length && problems.length === 0) {
    problems.push(`expected ${request.blocks.length} blocks, got ${result.blocks.length}`);
  }
  if (problems.length) throw new TranslationValidationError(problems);

  const byId = new Map(result.blocks.map((b) => [b.id, b.translation]));
  const blocksOut: TranslatedBlock[] = prepared.map((p) => {
    const translated = byId.get(p.block.nodeId) ?? "";
    if (p.block.sourceText.trim() && !translated.trim()) {
      throw new TranslationValidationError([
        `${p.block.nodeId}: empty translation for non-empty source`,
      ]);
    }
    const validation = validateProtection(translated, p.protection.placeholders);
    if (!validation.ok) {
      throw new TranslationValidationError(
        validation.problems.map((prob) => `${p.block.nodeId}: ${prob}`),
      );
    }
    return {
      nodeId: p.block.nodeId,
      sourceText: p.block.sourceText,
      translation: restorePlaceholders(translated, p.protection.placeholders).trim(),
      glossaryVersion: resolvedGlossaryVersion,
    };
  });
  return { blocks: blocksOut, model: result.model, stored: true };
}

/** Deterministic glossary version from sorted entries. */
export function glossaryVersion(glossary: Record<string, string>): string {
  const entries = Object.entries(glossary)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
  return `g_${fnv1a(entries).toString(16)}`;
}

/** Small deterministic hash (FNV-1a) — also used for source hashing. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function collectBlockTextForHash(node: ScholarBlockNode): string {
  return blockComparableText(node, {
    ignoreWhitespace: true,
    ignoreWrappers: false,
    ignoreCitations: false,
    caseSensitive: true,
  }).trim();
}

export type { PlaceholderInfo };
