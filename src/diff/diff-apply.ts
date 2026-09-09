import type { ScholarBlockNode } from "../core/ir/nodes";
import { writeMarkdown } from "../core/writer/markdown/markdown-writer";
import type { BlockDiff } from "./structural-diff";

/**
 * Per-change accept/reject (TECHNICAL_DESIGN.md §17.3 "future accept/reject",
 * v0.3). The diff view compares an OLD file against a NEW file; accepting a
 * change applies that single block-level change to the OLD file.
 *
 * Safety contract (PRODUCT_REQUIREMENTS.md §5: never rewrite uncertain
 * source): a change is applied only when its old-side block can be located
 * VERBATIM in the old file — the block is re-serialized from the Scholar IR
 * and matched against the document with whitespace-insensitive comparison.
 * Changes whose old block cannot be located (hand-edited formatting, exotic
 * input) are skipped and reported; nothing else is touched. Unaccepted
 * content always stays byte-identical: only located regions are replaced,
 * everything between them is copied through unchanged.
 */

export interface DiffApplySkip {
  /** Index into the blocks array. */
  index: number;
  reason: string;
}

export interface DiffApplyResult {
  /** New content for the old file. */
  text: string;
  /** Indices of accepted changes that were applied. */
  applied: number[];
  /** Indices of accepted changes that could not be applied safely. */
  skipped: DiffApplySkip[];
}

interface LocatedRegion {
  /** First old line of the block (inclusive). */
  start: number;
  /** Last old line of the block (inclusive). */
  end: number;
}

interface LocatedBlock {
  index: number;
  block: BlockDiff;
  region: LocatedRegion | null;
  /** Serialized replacement (changed) or insertion (added). */
  newLines: string[];
}

/** Serialize one IR block to canonical Markdown lines (no blank edges). */
export function serializeBlockLines(node: ScholarBlockNode): string[] {
  const markdown = writeMarkdown({ type: "document", children: [node] });
  // writeMarkdown guarantees exactly one trailing newline for the document.
  return trimBlankEdges(markdown.replace(/\n$/, "").split("\n"));
}

const norm = (line: string): string => line.replace(/\s+/g, " ").trim();

/** Blocks serializing to more lines than this are treated as unlocatable
 *  (a safe skip): locating is O(document × pattern), and patterns this large
 *  are pathological (R3 P3-5 — same budget philosophy as the LCS guard). */
const MAX_PATTERN_LINES = 2_000;

/** Collapsed-window fallback costs O(size²) per candidate position and only
 *  ever fires for small blocks (a one-line $$…$$ against a three-line
 *  serialization); above this size, element-wise matching or nothing. */
const MAX_COLLAPSE_PATTERN = 32;

/**
 * Apply the accepted subset of block-level changes to the old document text.
 * `accepted` holds indices into `blocks`; everything not accepted (or not
 * safely locatable) is preserved verbatim.
 */
export function applyAcceptedChanges(
  oldText: string,
  blocks: BlockDiff[],
  accepted: Set<number>,
): DiffApplyResult {
  const { text, applied, skipped } = applyAcceptedChangesToLines(
    oldText.split("\n"),
    blocks,
    accepted,
  );
  return { text, applied, skipped };
}

/** Line-array core (kept separate for unit testing). */
export function applyAcceptedChangesToLines(
  lines: string[],
  blocks: BlockDiff[],
  accepted: Set<number>,
): DiffApplyResult {
  // Index of every non-empty line, in order — the matching substrate.
  const nonEmpty: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) nonEmpty.push({ line: i, text: norm(lines[i]) });
  }

  const applied: number[] = [];
  const skipped: DiffApplySkip[] = [];
  const located: LocatedBlock[] = [];

  // Walk blocks in document order with a moving cursor over nonEmpty. Every
  // block with an old side must be located (even equal ones) to keep the
  // cursor in sync; a miss only affects that block — later blocks search on.
  let cursor = 0; // index into nonEmpty
  // Actual line number where the last located region ended. A later block
  // matching AT OR BEFORE it would anchor to the wrong occurrence when the
  // document contains repeated paragraphs (R2 P2-5) — treat that as a miss.
  let lastEndLine = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let region: LocatedRegion | null = null;
    if (block.oldNode) {
      const pattern = serializeBlockLines(block.oldNode).map(norm).filter((s) => s.length > 0);
      if (pattern.length > 0 && pattern.length <= MAX_PATTERN_LINES) {
        const found = locatePattern(nonEmpty, cursor, pattern);
        if (found && found.region.start > lastEndLine) {
          region = found.region;
          cursor = Math.max(cursor, found.cursorAfter);
          lastEndLine = found.region.end;
        } else if (!found) {
          // The block cannot be located. Consume its first candidate opening
          // line so a LATER block cannot anchor to that same occurrence
          // (CODE_REVIEW_R2 P2-5): an over-advance only ever causes a safe
          // skip, while not advancing could mis-apply onto a duplicate.
          const first = nonEmpty.findIndex(
            (e, idx) => idx >= cursor && e.text === pattern[0],
          );
          if (first !== -1) cursor = first + 1;
        }
      } else if (pattern.length > MAX_PATTERN_LINES) {
        // Same miss treatment, so the cursor keeps moving past the giant block.
        const first = nonEmpty.findIndex(
          (e, idx) => idx >= cursor && e.text === pattern[0],
        );
        if (first !== -1) cursor = first + 1;
      }
    }
    located.push({
      index: i,
      block,
      region,
      newLines: block.status === "removed" || !block.newNode
        ? []
        : serializeBlockLines(block.newNode),
    });
    if (accepted.has(i) && block.status !== "equal" && block.status !== "added" && !region) {
      skipped.push({
        index: i,
        reason: "the original block could not be located verbatim in the old note",
      });
    }
  }

  // Rebuild the document: untouched gaps are copied; located regions are
  // emitted (or replaced/deleted) in order; accepted adds are inserted
  // between their neighbours in block order.
  const out: string[] = [];
  let copyFrom = 0; // next old line to copy verbatim
  let pendingAdds: LocatedBlock[] = [];

  const emitAdd = (add: LocatedBlock): void => {
    if (accepted.has(add.index)) applied.push(add.index);
    if (add.newLines.length === 0) return;
    // Blank-line separation from whatever precedes (the gap copy or a
    // previously emitted add).
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(...add.newLines);
  };

  for (const lb of located) {
    if (lb.region) {
      const isDelete = accepted.has(lb.index) && lb.block.status === "removed";
      let rStart = lb.region.start;
      let rEnd = lb.region.end;
      if (isDelete) {
        // Consume ONE adjacent blank separator so the delete does not leave a
        // doubled/trailing blank run (prefer the blank below, fall back to
        // the one above; at most one). Done BEFORE the gap copy so the
        // consumed blank is never emitted.
        if (lines[rEnd + 1] !== undefined && !lines[rEnd + 1].trim()) rEnd++;
        else if (rStart > 0 && !lines[rStart - 1].trim()) rStart--;
      }
      // Copy the untouched gap in front of this block, then any adds queued
      // for that gap, then the block itself.
      for (let i = copyFrom; i < rStart; i++) out.push(lines[i]);
      for (const add of pendingAdds) emitAdd(add);
      pendingAdds = [];

      if (accepted.has(lb.index) && lb.block.status === "changed") {
        out.push(...lb.newLines);
        applied.push(lb.index);
      } else if (isDelete) {
        // delete: emit nothing
        applied.push(lb.index);
      } else {
        for (let i = rStart; i <= rEnd; i++) out.push(lines[i]);
      }
      copyFrom = rEnd + 1;
    } else if (lb.block.status === "added") {
      pendingAdds.push(lb);
    }
    // Region-less non-add blocks were never located; they simply stay inside
    // the untouched gaps copied above.
  }

  // Tail: remaining untouched lines, then any trailing accepted adds.
  for (let i = copyFrom; i < lines.length; i++) out.push(lines[i]);
  for (const add of pendingAdds) emitAdd(add);

  // Cosmetic cleanup: a deletion can leave a run of blank lines at EOF;
  // collapse it to the single trailing newline marker ("" as last element).
  while (out.length > 1 && !out[out.length - 1].trim() && !out[out.length - 2].trim()) {
    out.pop();
  }

  return { text: out.join("\n"), applied, skipped };
}

/**
 * Find the first position >= cursor where the old document matches `pattern`.
 * Primary match: one pattern line per non-empty old line, element-wise.
 * Fallback: a whitespace-free joined comparison over a smaller window of old
 * lines (handles e.g. `$$x=y$$` written on one line where the writer emits
 * `$$`, `x=y`, `$$`). Returns the region in actual line numbers plus the next
 * cursor position.
 */
function locatePattern(
  nonEmpty: { line: number; text: string }[],
  cursor: number,
  pattern: string[],
): { region: LocatedRegion; cursorAfter: number } | null {
  const joinedLoose = pattern.join("").replace(/\s+/g, "");
  for (let start = cursor; start < nonEmpty.length; start++) {
    // Element-wise match at the full pattern size.
    if (start + pattern.length <= nonEmpty.length) {
      let ok = true;
      for (let k = 0; k < pattern.length; k++) {
        if (nonEmpty[start + k].text !== pattern[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return {
          region: { start: nonEmpty[start].line, end: nonEmpty[start + pattern.length - 1].line },
          cursorAfter: start + pattern.length,
        };
      }
    }
    // Collapsed windows: fewer old lines carrying the same content. Only for
    // small patterns — the O(size²) probe per position is not worth its cost
    // on large blocks, which match element-wise or are skipped (R3 P3-5).
    if (pattern.length <= MAX_COLLAPSE_PATTERN) {
      for (let size = 1; size < pattern.length; size++) {
        if (start + size > nonEmpty.length) break;
        let window = "";
        for (let k = 0; k < size; k++) window += nonEmpty[start + k].text;
        if (window.replace(/\s+/g, "") === joinedLoose) {
          return {
            region: { start: nonEmpty[start].line, end: nonEmpty[start + size - 1].line },
            cursorAfter: start + size,
          };
        }
      }
    }
  }
  return null;
}

function trimBlankEdges(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[0].trim()) copy.shift();
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}
