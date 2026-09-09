/**
 * Token-level sequence diff (TECHNICAL_DESIGN.md §9).
 *
 * LCS-based; contiguous non-equal runs are grouped into `replace` spans so a
 * single word/token swap shows as one focused change.
 */

export type DiffOp = "equal" | "insert" | "delete" | "replace";

export interface Span<T> {
  op: DiffOp;
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  items: T[]; // equal: a items; insert: b items; replace: b items
  oldItems?: T[]; // replace: a items
}

// Alignment is O(n·m): 4M cells was enough for a single call to freeze the
// UI for seconds, and diffDocumentsIR runs it once per changed block. The
// guard is deliberately tight — an oversized pair degrades to one coarse
// replace, which is still an accurate (if less granular) diff.
const MAX_CELLS = 500_000;

export function diffSequences<T>(
  a: T[],
  b: T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y,
): Span<T>[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ op: "insert", aStart: 0, aLen: 0, bStart: 0, bLen: m, items: [...b] }];
  if (m === 0) return [{ op: "delete", aStart: 0, aLen: n, bStart: 0, bLen: 0, items: [], oldItems: [...a] }];

  // Trim the common prefix/suffix first: large documents usually differ in a
  // small middle, and trimming keeps the MAX_CELLS guard below from collapsing
  // the whole diff into one unaligned replace.
  let start = 0;
  while (start < n && start < m && eq(a[start], b[start])) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }

  const spans: Span<T>[] = [];
  if (start > 0) {
    spans.push({ op: "equal", aStart: 0, aLen: start, bStart: 0, bLen: start, items: a.slice(0, start) });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) {
    // fully equal
  } else if (midA.length === 0) {
    spans.push({
      op: "insert",
      aStart: start,
      aLen: 0,
      bStart: start,
      bLen: midB.length,
      items: [...midB],
    });
  } else if (midB.length === 0) {
    spans.push({
      op: "delete",
      aStart: start,
      aLen: midA.length,
      bStart: start,
      bLen: 0,
      items: [],
      oldItems: [...midA],
    });
  } else if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    // Guard for pathological inputs: coarse whole-middle replace.
    spans.push({
      op: "replace",
      aStart: start,
      aLen: midA.length,
      bStart: start,
      bLen: midB.length,
      items: [...midB],
      oldItems: [...midA],
    });
  } else {
    for (const s of lcsCore(midA, midB, eq)) {
      s.aStart += start;
      s.bStart += start;
      spans.push(s);
    }
  }

  if (n - endA > 0) {
    spans.push({
      op: "equal",
      aStart: endA,
      aLen: n - endA,
      bStart: endB,
      bLen: m - endB,
      items: a.slice(endA, n),
    });
  }
  return mergeAdjacents(spans);
}

/** LCS over the divergent middle; assumes both inputs are non-empty. */
function lcsCore<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Span<T>[] {
  const n = a.length;
  const m = b.length;

  // LCS lengths
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk to raw ops
  const raw: { op: "equal" | "insert" | "delete"; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      raw.push({ op: "equal", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ op: "delete", ai: i, bi: j });
      i++;
    } else {
      raw.push({ op: "insert", ai: i, bi: j });
      j++;
    }
  }
  while (i < n) {
    raw.push({ op: "delete", ai: i, bi: j });
    i++;
  }
  while (j < m) {
    raw.push({ op: "insert", ai: i, bi: j });
    j++;
  }

  // Group contiguous delete+insert runs into replace spans
  const spans: Span<T>[] = [];
  let k = 0;
  while (k < raw.length) {
    const r = raw[k];
    if (r.op === "equal") {
      spans.push({
        op: "equal",
        aStart: r.ai,
        aLen: 1,
        bStart: r.bi,
        bLen: 1,
        items: [a[r.ai]],
      });
      k++;
      continue;
    }
    const delStart = k;
    while (k < raw.length && raw[k].op === "delete") k++;
    const delEnd = k;
    const insStart = k;
    while (k < raw.length && raw[k].op === "insert") k++;
    const insEnd = k;

    const aStart = raw[delStart].ai;
    const aLen = delEnd - delStart;
    const bStart = delEnd < raw.length ? raw[insStart].bi : m - (insEnd - insStart);
    const bLen = insEnd - insStart;
    if (aLen > 0 && bLen > 0) {
      spans.push({
        op: "replace",
        aStart,
        aLen,
        bStart,
        bLen,
        items: b.slice(bStart, bStart + bLen),
        oldItems: a.slice(aStart, aStart + aLen),
      });
    } else if (aLen > 0) {
      spans.push({
        op: "delete",
        aStart,
        aLen,
        bStart,
        bLen: 0,
        items: [],
        oldItems: a.slice(aStart, aStart + aLen),
      });
    } else if (bLen > 0) {
      spans.push({ op: "insert", aStart, aLen: 0, bStart, bLen, items: b.slice(bStart, bStart + bLen) });
    }
  }
  return spans;
}

/** Merge neighboring equal spans to reduce fragment count. */
function mergeAdjacents<T>(spans: Span<T>[]): Span<T>[] {
  const out: Span<T>[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && prev.op === "equal" && s.op === "equal") {
      prev.items.push(...s.items);
      prev.aLen += s.aLen;
      prev.bLen += s.bLen;
    } else {
      out.push(s);
    }
  }
  return out;
}
