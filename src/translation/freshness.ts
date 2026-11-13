import {
  scanTranslationMarkers,
  TRANSLATION_END,
  TRANSLATION_START,
  type TranslationMeta,
} from "../core/ir/metadata";
import { freshnessStatus } from "./reinsertion";

/**
 * Stale translation detection over raw note text (TECHNICAL_DESIGN.md §14).
 *
 * Scans `scholarbridge:translation:start/end` blocks, recovers the source
 * block that precedes each translation, recomputes its hash and compares it
 * with the stored `sourceHash`. Textual scanning keeps hash inputs identical
 * to what was stored at translation time.
 */

export interface FreshnessEntry {
  sourceNodeId: string;
  storedHash: string;
  /** Recovered raw source text above the translation block. */
  sourceRaw: string;
  sourceStartLine: number;
  sourceEndLine: number;
  translationStartLine: number;
  translationEndLine: number;
  status: "fresh" | "stale" | "orphan";
  meta: TranslationMeta;
}

export interface FreshnessReport {
  entries: FreshnessEntry[];
  staleEntries: FreshnessEntry[];
  invalidStartLines: number[];
}

export function scanFreshness(docText: string): FreshnessReport {
  const lines = docText.split("\n");
  const { markers, invalidStartLines } = scanTranslationMarkers(lines);

  const entries: FreshnessEntry[] = markers.map((marker) => {
    const source = marker.meta.writeMode === "replace"
      ? null
      : recoverSource(lines, marker.startLine, marker.meta.sourceHash, marker.meta.sourceLineCount);
    const status = source
      ? freshnessStatus(source.raw, marker.meta.sourceHash)
      : "orphan";
    return {
      sourceNodeId: marker.meta.sourceNodeId,
      storedHash: marker.meta.sourceHash,
      sourceRaw: source?.raw ?? "",
      sourceStartLine: source?.startLine ?? -1,
      sourceEndLine: source?.endLine ?? -1,
      translationStartLine: marker.startLine,
      translationEndLine: marker.endLine,
      status,
      meta: marker.meta,
    };
  });

  return {
    entries,
    staleEntries: entries.filter((e) => e.status === "stale"),
    invalidStartLines,
  };
}

/** Walk upwards from a translation block to its source paragraph. */
function recoverSource(
  lines: string[],
  translationStartLine: number,
  storedHash: string,
  sourceLineCount?: number,
): { raw: string; startLine: number; endLine: number } | null {
  let end = translationStartLine - 1;
  // Skip blank lines and whole comment blocks (scholarbridge metadata,
  // foreign comments, previous translation markers) so the source paragraph
  // above them is found.
  while (end >= 0) {
    const line = lines[end];
    if (!line.trim()) {
      end--;
      continue;
    }
    // In replace mode blocks sit back-to-back: the previous block's end
    // marker must jump to ABOVE its start marker, otherwise the translated
    // text between them would be recovered as the "source" (false stale and
    // a re-translation cascade).
    if (line.includes(TRANSLATION_END)) {
      const startIdx = findTranslationStartAbove(lines, end);
      if (startIdx === -1) return null; // end marker without start: orphaned
      end = startIdx - 1;
      continue;
    }
    if (isCommentTail(line)) {
      const open = walkToCommentOpen(lines, end);
      if (open === -1) return null; // malformed comment: no recoverable source
      end = open - 1;
      continue;
    }
    if (isCommentOpener(line)) {
      end--; // stray single-line comment / marker
      continue;
    }
    break;
  }
  if (end < 0) return null;

  let top = end;
  while (
    top > 0 && lines[top - 1].trim() &&
    !isCommentLine(lines[top - 1]) && !/^#{1,6}\s/.test(lines[top - 1])
  ) top--;

  if (sourceLineCount !== undefined && Number.isSafeInteger(sourceLineCount) && sourceLineCount > 0 && sourceLineCount <= end - top + 1) {
    const start = end - sourceLineCount + 1;
    const raw = lines.slice(start, end + 1).join("\n").trim();
    if (freshnessStatus(raw, storedHash) === "fresh") return { raw, startLine: start, endLine: end };
  }

  // The hash includes normalized length. Only one non-empty suffix can have
  // that length, so legacy blocks need at most one hash instead of O(n^2).
  const lengthMatch = /_([0-9a-f]+)$/i.exec(storedHash);
  const expectedLength = lengthMatch ? Number.parseInt(lengthMatch[1], 16) : -1;
  let length = 0;
  for (let start = end; start >= top; start--) {
    const normalized = lines[start].replace(/\s+/g, " ").trim();
    length += normalized.length + (start < end ? 1 : 0);
    if (length === expectedLength) {
      const raw = lines.slice(start, end + 1).join("\n").trim();
      if (freshnessStatus(raw, storedHash) === "fresh") {
        return { raw, startLine: start, endLine: end };
      }
    }
    if (length >= expectedLength) break;
  }

  // No candidate matches: the source really changed (or never matched).
  // Fall back to the full extension so stale entries still report what is
  // actually there.
  const raw = lines.slice(top, end + 1).join("\n").trim();
  return raw ? { raw, startLine: top, endLine: end } : null;
}

/** Index of the nearest `scholarbridge:translation:start` line at/below `from`. */
function findTranslationStartAbove(lines: string[], from: number): number {
  for (let i = from; i >= 0; i--) {
    if (lines[i].includes(TRANSLATION_START)) return i;
  }
  return -1;
}

function isCommentTail(line: string): boolean {
  return /^\s*-->/.test(line);
}

function isCommentOpener(line: string): boolean {
  return /^\s*<!--/.test(line) && line.includes("-->");
}

function isCommentLine(line: string): boolean {
  return /^\s*<!--/.test(line) || /^\s*-->/.test(line);
}

/** Index of the `<!--` opener for a comment whose tail is at `tailIndex`. */
function walkToCommentOpen(lines: string[], tailIndex: number): number {
  for (let i = tailIndex; i >= 0; i--) {
    if (/^\s*<!--/.test(lines[i])) return i;
  }
  return -1;
}
