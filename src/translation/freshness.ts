import {
  decodeTranslationStart,
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
}

interface Markers {
  startLine: number;
  endLine: number;
  meta: TranslationMeta;
}

const START_RE = /^<!--\s*scholarbridge:translation:start\s*$/;
const START_INLINE_RE = /^<!--\s*scholarbridge:translation:start\s*(\{.*\})\s*-->\s*$/;
const END_RE = /^<!--\s*scholarbridge:translation:end\s*-->\s*$/;

export function scanFreshness(docText: string): FreshnessReport {
  const lines = docText.split("\n");
  const markers: Markers[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = START_INLINE_RE.exec(line);
    if (inline) {
      const meta = decodeTranslationStart(`scholarbridge:translation:start ${inline[1]}`);
      if (meta) {
        let end = i + 1;
        while (end < lines.length && !END_RE.test(lines[end])) end++;
        if (end >= lines.length) {
          // Unclosed marker: skip only its own line and keep scanning, so a
          // malformed marker cannot swallow the rest of the document (same
          // guard the multi-line branch applies).
          continue;
        }
        markers.push({ startLine: i, endLine: end, meta });
        i = end;
      }
      continue;
    }
    if (START_RE.test(line)) {
      // multi-line form: JSON until -->
      let jsonBody = "";
      let j = i + 1;
      while (j < lines.length && !lines[j].includes("-->")) {
        jsonBody += lines[j] + "\n";
        j++;
      }
      if (j >= lines.length) {
        // Unclosed marker: skip only its own line(s) and keep scanning, so a
        // malformed marker cannot swallow the rest of the document.
        continue;
      }
      const meta = decodeTranslationStart(`scholarbridge:translation:start ${jsonBody}`);
      if (!meta) {
        // Malformed payload: treat as a plain comment and scan on.
        continue;
      }
      const end = (() => {
        let k = j;
        while (k < lines.length && !END_RE.test(lines[k])) k++;
        return Math.min(k, lines.length - 1);
      })();
      markers.push({ startLine: i, endLine: end, meta });
      i = end;
    }
  }

  const entries: FreshnessEntry[] = markers.map((marker) => {
    const source = recoverSource(lines, marker.startLine, marker.meta.sourceHash);
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
  };
}

/** Walk upwards from a translation block to its source paragraph. */
function recoverSource(
  lines: string[],
  translationStartLine: number,
  storedHash: string,
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
  while (top > 0 && lines[top - 1].trim() && !isCommentLine(lines[top - 1])) top--;

  // Hash-guided recovery (CODE_REVIEW_R2 P3-1): contiguous non-blank lines
  // may hold SEVERAL source blocks (translate-selection/section ranges do not
  // span the whole paragraph run). Try every suffix ending at `end`, longest
  // first — the one matching the stored hash is the true source; a mismatch
  // in the long extension used to produce a false stale.
  for (let start = top; start <= end; start++) {
    const raw = lines.slice(start, end + 1).join("\n").trim();
    if (raw && freshnessStatus(raw, storedHash) === "fresh") {
      return { raw, startLine: start, endLine: end };
    }
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
  return /^\s*<\!--/.test(line) && line.includes("-->");
}

function isCommentLine(line: string): boolean {
  return /^\s*<\!--/.test(line) || /^\s*-->/.test(line);
}

/** Index of the `<!--` opener for a comment whose tail is at `tailIndex`. */
function walkToCommentOpen(lines: string[], tailIndex: number): number {
  for (let i = tailIndex; i >= 0; i--) {
    if (/^\s*<\!--/.test(lines[i])) return i;
  }
  return -1;
}
