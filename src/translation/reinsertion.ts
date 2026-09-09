import {
  encodeTranslationEnd,
  encodeTranslationStart,
  type TranslationMeta,
} from "../core/ir/metadata";
import { fnv1a } from "./translator";

/**
 * Translation reinsertion (PRODUCT_REQUIREMENTS.md FR-6, PRD §3.8).
 *
 * Write modes:
 *   insert-below    — default: translation block added under the source
 *   replace         — source replaced by the translation (hash preserved)
 *   translated-copy — whole-document translated variant (new note)
 *   bilingual       — per-block interleave (same shape as insert-below)
 *
 * Only the preview Apply path ever calls these on a real editor.
 */

export interface SourceRange {
  /** Raw source text exactly as it appears in the note. */
  raw: string;
  /** 0-based line numbers in the note (inclusive). */
  startLine: number;
  endLine: number;
}

export interface ReinsertionInput {
  nodeId: string;
  translation: string;
  range: SourceRange;
  meta: {
    sourceLanguage: string;
    targetLanguage: string;
    model: string;
    glossaryVersion: string;
    promptVersion: string;
  };
  /**
   * Exact text expected at range.startLine..endLine when Apply runs (R2 P1-1).
   * Command paths that know it set this; applyTranslationJob aborts the whole
   * job when the live editor no longer matches — the guard that makes writing
   * into a different note (or a concurrently edited one) impossible. Note:
   * for stale-block retranslation the range covers the translation block, so
   * this is the block text, NOT the source.
   */
  verifyRaw?: string;
}

/**
 * Stable hash over normalized source text (TECHNICAL_DESIGN.md §14).
 *
 * Collision bound: 32-bit FNV-1a plus a length suffix. Same-length inputs
 * collide with ~50% probability after ~2^16 distinct texts (birthday bound),
 * and a collision merely suppresses one stale-translation notice —
 * acceptable for personal-note freshness hints; not a security hash.
 */
export function sourceHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const h = fnv1a(normalized).toString(16).padStart(8, "0");
  return `${h}_${normalized.length.toString(16)}`;
}

export function buildTranslationMeta(input: ReinsertionInput): TranslationMeta {
  return {
    schemaVersion: 1,
    sourceNodeId: input.nodeId,
    sourceLanguage: input.meta.sourceLanguage,
    targetLanguage: input.meta.targetLanguage,
    sourceHash: sourceHash(input.range.raw),
    model: input.meta.model,
    glossaryVersion: input.meta.glossaryVersion,
    promptVersion: input.meta.promptVersion,
    status: "fresh",
  };
}

export function buildTranslationBlock(input: ReinsertionInput): string {
  const meta = buildTranslationMeta(input);
  return [
    encodeTranslationStart(meta),
    input.translation,
    encodeTranslationEnd(),
  ].join("\n");
}

export type WriteMode = "insert-below" | "replace" | "translated-copy" | "bilingual";

/** Editor lines after applying one block in the given mode. */
export function applyToLines(lines: string[], input: ReinsertionInput, mode: WriteMode): string[] {
  const block = buildTranslationBlock(input);
  const before = lines.slice(0, input.range.startLine);
  const after = lines.slice(input.range.endLine + 1);
  const source = input.range.raw;
  switch (mode) {
    case "insert-below":
    case "bilingual":
      return [...before, source, "", block, ...after];
    case "replace":
      return [...before, block, ...after];
    case "translated-copy":
      // Per-block this behaves like replace; createTranslatedCopy composes it.
      return [...before, input.translation, ...after];
    default:
      return lines;
  }
}

/** Produce a fully translated variant of the note (mode: translated-copy). */
export function createTranslatedCopy(
  lines: string[],
  inputs: ReinsertionInput[],
): string[] {
  // Apply bottom-up so line numbers stay valid.
  const sorted = [...inputs].sort((a, b) => b.range.startLine - a.range.startLine);
  let out = [...lines];
  for (const input of sorted) {
    const before = out.slice(0, input.range.startLine);
    const after = out.slice(input.range.endLine + 1);
    out = [...before, input.translation, ...after];
  }
  return out;
}

/**
 * Recompute freshness of a stored translation (TECHNICAL_DESIGN.md §14):
 * returns "stale" when the current source text hashes differently.
 */
export function freshnessStatus(currentSourceText: string, storedHash: string): "fresh" | "stale" {
  return sourceHash(currentSourceText) === storedHash ? "fresh" : "stale";
}
