import { parseDocument, type DocumentFormat } from "../core/parser";
import type { ScholarBlockNode, ScholarDocument, ScholarInlineNode } from "../core/ir/nodes";
import { blockComparableText, inlineToComparable, normalizeWhitespace } from "./node-text";
import { diffSequences, type DiffOp } from "./lcs";
import {
  tokenizeText,
  tokenKey,
  type TextDiffOptions,
} from "./text-tokenizer";
import { formulaTokenKey, formulaDiffTokens, type FormulaToken } from "./formula-tokenizer";
import { diffTables, type CellChange } from "./table-diff";

/**
 * Semantic document diff (TECHNICAL_DESIGN.md §9).
 *
 * Pipeline: parse both sides to Scholar IR → align blocks by signature →
 * node-specific diff (prose tokens / formula tokens / table cells).
 */

export interface DiffOptions extends TextDiffOptions {
  ignoreWhitespace: boolean;
  ignoreWrappers: boolean;
  ignoreCitations: boolean;
  caseSensitive: boolean;
  /** Terms that must stay atomic (e.g. glossary names like FedContra). */
  atomicTerms?: string[];
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  ignoreWhitespace: true,
  ignoreWrappers: true,
  ignoreCitations: false,
  caseSensitive: true,
};

export interface InlineChange {
  op: DiffOp;
  text: string;
  oldText?: string;
  /** true when the change is inside a formula token region */
  formula?: boolean;
}

export interface BlockDiff {
  status: "equal" | "changed" | "added" | "removed";
  type: string;
  oldNode?: ScholarBlockNode;
  newNode?: ScholarBlockNode;
  changes?: InlineChange[];
  tableChanges?: CellChange[];
}

export interface DocumentDiff {
  blocks: BlockDiff[];
  stats: { equal: number; changed: number; added: number; removed: number };
}

export function diffDocuments(
  oldInput: string,
  newInput: string,
  format: DocumentFormat = "markdown",
  options: Partial<DiffOptions> = {},
): DocumentDiff {
  const opts: DiffOptions = { ...DEFAULT_DIFF_OPTIONS, ...options };
  const oldDoc = parseDocument(oldInput, format);
  const newDoc = parseDocument(newInput, format);
  return diffDocumentsIR(oldDoc, newDoc, opts);
}

export function diffDocumentsIR(oldDoc: ScholarDocument, newDoc: ScholarDocument, opts: DiffOptions): DocumentDiff {
  const oldBlocks = oldDoc.children;
  const newBlocks = newDoc.children;
  const oldSigs = oldBlocks.map((b) => signature(b, opts));
  const newSigs = newBlocks.map((b) => signature(b, opts));
  const spans = diffSequences(oldSigs, newSigs);

  const blocks: BlockDiff[] = [];
  for (const span of spans) {
    if (span.op === "equal") {
      for (let k = 0; k < span.aLen; k++) {
        const node = oldBlocks[span.aStart + k];
        blocks.push({ status: "equal", type: node.type, oldNode: node, newNode: newBlocks[span.bStart + k] });
      }
      continue;
    }
    if (span.op === "insert") {
      for (let k = 0; k < span.bLen; k++) {
        const node = newBlocks[span.bStart + k];
        blocks.push({ status: "added", type: node.type, newNode: node });
      }
      continue;
    }
    if (span.op === "delete") {
      for (let k = 0; k < span.aLen; k++) {
        const node = oldBlocks[span.aStart + k];
        blocks.push({ status: "removed", type: node.type, oldNode: node });
      }
      continue;
    }
    // replace: pair up in order, leftover becomes added/removed
    const oldSlice = oldBlocks.slice(span.aStart, span.aStart + span.aLen);
    const newSlice = newBlocks.slice(span.bStart, span.bStart + span.bLen);
    const pairCount = Math.min(oldSlice.length, newSlice.length);
    for (let k = 0; k < pairCount; k++) {
      blocks.push(diffBlockPair(oldSlice[k], newSlice[k], opts));
    }
    for (let k = pairCount; k < oldSlice.length; k++) {
      blocks.push({ status: "removed", type: oldSlice[k].type, oldNode: oldSlice[k] });
    }
    for (let k = pairCount; k < newSlice.length; k++) {
      blocks.push({ status: "added", type: newSlice[k].type, newNode: newSlice[k] });
    }
  }

  const stats = { equal: 0, changed: 0, added: 0, removed: 0 };
  for (const b of blocks) stats[b.status]++;
  return { blocks, stats };
}

function diffBlockPair(oldNode: ScholarBlockNode, newNode: ScholarBlockNode, opts: DiffOptions): BlockDiff {
  if (oldNode.type !== newNode.type) {
    return { status: "changed", type: newNode.type, oldNode, newNode };
  }
  switch (oldNode.type) {
    case "paragraph":
    case "heading": {
      const newNode2 = newNode as typeof oldNode;
      const changes = diffInline(oldNode.children, newNode2.children, opts);
      // Heading level is part of the change even when the text is identical.
      const levelChanged =
        oldNode.type === "heading" && newNode2.type === "heading" && newNode2.level !== oldNode.level;
      return {
        status: levelChanged || changes.some((c) => c.op !== "equal") ? "changed" : "equal",
        type: oldNode.type,
        oldNode,
        newNode,
        changes,
      };
    }
    case "math": {
      const oldMath = oldNode;
      const newMath = newNode as typeof oldNode;
      if (oldMath.latex === newMath.latex && oldMath.environment === newMath.environment) {
        return { status: "equal", type: "math", oldNode, newNode };
      }
      const oldTokens = formulaDiffTokens(oldMath.latex);
      const newTokens = formulaDiffTokens(newMath.latex);
      const spans = diffSequences(oldTokens, newTokens, (a, b) => formulaTokenKey(a) === formulaTokenKey(b));
      const changes: InlineChange[] = spans.map((s) => {
        if (s.op === "equal") return { op: "equal", text: s.items.map((t) => t.text).join("") };
        if (s.op === "insert") return { op: "insert", text: s.items.map((t) => t.text).join(""), formula: true };
        if (s.op === "delete") return { op: "delete", text: (s.oldItems ?? []).map((t) => t.text).join(""), formula: true };
        return {
          op: "replace",
          text: s.items.map((t) => t.text).join(""),
          oldText: (s.oldItems ?? []).map((t) => t.text).join(""),
          formula: true,
        };
      });
      return {
        status:
          oldMath.environment !== newMath.environment || changes.some((c) => c.op !== "equal")
            ? "changed"
            : "equal",
        type: "math",
        oldNode,
        newNode,
        changes,
      };
    }
    case "table": {
      const result = diffTables(oldNode, newNode as typeof oldNode, opts);
      return {
        status: result.hasChanges ? "changed" : "equal",
        type: "table",
        oldNode,
        newNode,
        tableChanges: result.changes,
      };
    }
    case "code": {
      const oldCode = oldNode.code;
      const newCode = (newNode as typeof oldNode).code;
      return oldCode === newCode
        ? { status: "equal", type: "code", oldNode, newNode }
        : { status: "changed", type: "code", oldNode, newNode, changes: [{ op: "replace", text: newCode, oldText: oldCode }] };
    }
    default: {
      // Lists and quotes get word-level detail over their comparable text;
      // figure/algorithm keep the coarse whole-block comparison.
      if (oldNode.type === "list" || oldNode.type === "quote") {
        const normalize = (s: string) => (opts.ignoreWhitespace ? normalizeWhitespace(s) : s);
        const changes = diffComparableText(
          normalize(blockComparableText(oldNode, opts)),
          normalize(blockComparableText(newNode as ScholarBlockNode, opts)),
          opts,
        );
        return {
          status: changes.some((c) => c.op !== "equal") ? "changed" : "equal",
          type: oldNode.type,
          oldNode,
          newNode,
          changes,
        };
      }
      const same = signature(oldNode, opts) === signature(newNode, opts);
      return same
        ? { status: "equal", type: oldNode.type, oldNode, newNode }
        : { status: "changed", type: oldNode.type, oldNode, newNode };
    }
  }
}

/** Token diff over two comparable strings (shared by inline and block text). */
/**
 * Main-thread diff budget. Beyond these sizes a block is reported as one
 * whole-block replace: the alignment is O(n·m) and would otherwise freeze the
 * editor on long sections.
 */
const MAX_INLINE_CHARS = 100_000;
const MAX_INLINE_TOKENS = 5_000;

function diffComparableText(oldText: string, newText: string, opts: DiffOptions): InlineChange[] {
  if (oldText === newText) return [{ op: "equal", text: newText }];
  // Cheap bail-outs before tokenising: an empty side is a plain insert/delete.
  if (!oldText) return [{ op: "insert", text: newText }];
  if (!newText) return [{ op: "delete", text: oldText }];
  // Diffing runs on the main thread. Past this size the alignment cost stops
  // paying for itself, so report one whole-block replace rather than freezing
  // Obsidian on a long section.
  if (oldText.length > MAX_INLINE_CHARS || newText.length > MAX_INLINE_CHARS) {
    return [{ op: "replace", text: newText, oldText }];
  }
  const oldTokens = tokenizeText(oldText, opts);
  const newTokens = tokenizeText(newText, opts);
  if (oldTokens.length > MAX_INLINE_TOKENS || newTokens.length > MAX_INLINE_TOKENS) {
    return [{ op: "replace", text: newText, oldText }];
  }
  const spans = diffSequences(oldTokens, newTokens, (a, b) => tokenKey(a, opts) === tokenKey(b, opts));
  const changes: InlineChange[] = [];
  for (const s of spans) {
    if (s.op === "equal") {
      changes.push({ op: "equal", text: s.items.map((t) => t.text).join("") });
    } else if (s.op === "insert") {
      changes.push({ op: "insert", text: s.items.map((t) => t.text).join("") });
    } else if (s.op === "delete") {
      changes.push({ op: "delete", text: (s.oldItems ?? []).map((t) => t.text).join("") });
    } else {
      changes.push({
        op: "replace",
        text: s.items.map((t) => t.text).join(""),
        oldText: (s.oldItems ?? []).map((t) => t.text).join(""),
      });
    }
  }
  return changes;
}

export function diffInline(oldChildren: ScholarInlineNode[], newChildren: ScholarInlineNode[], opts: DiffOptions): InlineChange[] {
  const normalize = (s: string) => (opts.ignoreWhitespace ? normalizeWhitespace(s) : s);
  return diffComparableText(
    normalize(inlineToComparable(oldChildren, opts)),
    normalize(inlineToComparable(newChildren, opts)),
    opts,
  );
}

/** Alignment signature: type (+ heading level / math environment) + normalized comparable content. */
function signature(node: ScholarBlockNode, opts: DiffOptions): string {
  // A heading level or math environment change must not align the two blocks
  // as identical; keep it in the key so it pairs as remove+add/replace.
  const kind =
    node.type === "heading"
      ? `heading:${node.level}`
      : node.type === "math"
        ? `math:${node.environment ?? ""}`
        : node.type;
  const content = blockComparableText(node, opts);
  const normalized = opts.ignoreWhitespace ? normalizeWhitespace(content) : content;
  const key = opts.caseSensitive ? normalized : normalized.toLowerCase();
  return `${kind}:${key}`;
}

export type { FormulaToken };
