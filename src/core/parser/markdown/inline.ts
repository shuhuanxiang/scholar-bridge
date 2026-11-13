import { IdAllocator, inline } from "../../ir/document";
import type { ScholarInlineNode } from "../../ir/nodes";
import { decodeInlineLatex } from "../../ir/metadata";

/** Match a complete code span with an exact-length closing backtick run. */
export function readCodeSpan(input: string, start: number): { code: string; end: number } | null {
  if (input[start] !== "`") return null;
  const ticks = /^`+/.exec(input.slice(start))![0];
  let cursor = start + ticks.length;
  while (cursor < input.length) {
    const close = input.indexOf("`", cursor);
    if (close === -1) return null;
    const run = /^`+/.exec(input.slice(close))![0];
    if (run.length === ticks.length) {
      let code = input.slice(start + ticks.length, close);
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      return { code, end: close + ticks.length };
    }
    cursor = close + run.length;
  }
  return null;
}

/** Read complete labels and balanced destinations for parsing and protection. */
export function readMarkdownLink(input: string, start: number): {
  label: string; target: string; title?: string; end: number;
} | null {
  if (input[start] !== "[" || input[start + 1] === "[") return null;
  let depth = 1;
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input.startsWith("<!--", i)) {
      const close = input.indexOf("-->", i + 4);
      if (close !== -1) { i = close + 2; continue; }
    }
    if (input[i] === "`") {
      const span = readCodeSpan(input, i);
      if (span) { i = span.end - 1; continue; }
    }
    if (input[i] === "[") { depth++; continue; }
    if (input[i] !== "]") continue;
    depth--;
    if (depth > 0) continue;
    if (input[i + 1] !== "(") return null;
    const close = matchParen(input, i + 1);
    if (close === -1) return null;
    return {
      label: input.slice(start + 1, i),
      ...splitLinkDestination(input.slice(i + 2, close)),
      end: close + 1,
    };
  }
  return null;
}

/**
 * Inline Markdown (incl. Obsidian constructs) → inline IR nodes.
 * Unsupported markers stay as literal text so nothing is lost on round-trip.
 */

export function parseMarkdownInline(
  input: string,
  ids: IdAllocator = new IdAllocator(),
): ScholarInlineNode[] {
  const out: ScholarInlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push(inline.text(text));
      text = "";
    }
  };
  const push = (node: ScholarInlineNode) => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "\\" && /^\\[\\`*_{}$[\]()#+!.~>-]/.test(input.slice(i))) {
      text += input[i + 1];
      i += 2;
      continue;
    }

    // Math: $$…$$ (inline display) then $…$
    if (ch === "$") {
      if (input.startsWith("$$", i)) {
        const close = input.indexOf("$$", i + 2);
        if (close !== -1 && close > i + 2) {
          const latex = input.slice(i + 2, close);
          if (latex.trim()) {
            push({ id: ids.inline(), type: "inline-math", latex, display: true });
            i = close + 2;
            continue;
          }
        }
      } else {
        const close = findClosingDollar(input, i + 1);
        if (close !== -1) {
          const latex = input.slice(i + 1, close);
          const after = input[close + 1];
          // Pandoc-style guard: a closing $ must not be followed by a digit,
          // so "$5 and $10" stays prose instead of becoming math.
          const digitAfter = after !== undefined && /[0-9]/.test(after);
          // $…$ requires non-space content (avoids currency text)
          if (latex.trim() && !latex.includes("\n") && !digitAfter) {
            push({ id: ids.inline(), type: "inline-math", latex });
            i = close + 1;
            continue;
          }
        }
      }
      text += ch;
      i++;
      continue;
    }

    // Code spans (`` ` `` with possible multi-backtick delimiters)
    if (ch === "`") {
      const span = readCodeSpan(input, i);
      if (span) {
        const annotation = /^<!-- scholarbridge:inline-latex [\s\S]*? -->/.exec(input.slice(span.end));
        const meta = annotation ? decodeInlineLatex(annotation[0]) : null;
        if (meta && meta.raw === span.code) {
          push(meta.keys
            ? inline.citation(meta.raw, meta.keys)
            : { id: ids.inline(), type: "inline-raw", raw: meta.raw });
        } else {
          push(inline.codeSpan(span.code));
        }
        i = span.end + (meta ? annotation![0].length : 0);
        continue;
      }
      const unmatched = /^`+/.exec(input.slice(i))![0];
      text += unmatched;
      i += unmatched.length;
      continue;
    }

    // Strong **…** and __…__ (CommonMark flanking, approximated — see
    // canOpenMarker/canCloseMarker; the full punctuation rule is not modeled).
    if (input.startsWith("**", i) && canOpenMarker(input, i, 2)) {
      const close = findClosingMarker(input, i + 2, "**");
      if (close !== -1) {
        const inner = input.slice(i + 2, close);
        if (inner.trim() && !inner.includes("\n")) {
          push({ id: ids.inline(), type: "strong", children: parseMarkdownInline(inner, ids) });
          i = close + 2;
          continue;
        }
      }
    }
    if (input.startsWith("__", i) && canOpenMarker(input, i, 2) && !isIntraword(input, i, 2)) {
      const close = findClosingMarker(input, i + 2, "__");
      if (close !== -1) {
        const inner = input.slice(i + 2, close);
        if (inner.trim() && !inner.includes("\n")) {
          push({ id: ids.inline(), type: "strong", children: parseMarkdownInline(inner, ids) });
          i = close + 2;
          continue;
        }
      }
    }

    // Emphasized *…*
    if (ch === "*" && canOpenMarker(input, i, 1)) {
      const close = findClosingMarker(input, i + 1, "*");
      if (close !== -1) {
        const inner = input.slice(i + 1, close);
        if (inner.trim() && !inner.includes("\n")) {
          push({ id: ids.inline(), type: "emph", children: parseMarkdownInline(inner, ids) });
          i = close + 1;
          continue;
        }
      }
    }

    // Emphasized _…_ (underscore is intraword-sensitive). The opening marker
    // only needs a non-word character on its LEFT; the "not followed by a word
    // character" rule belongs to the CLOSING marker. Testing both sides on
    // the opener rejected the ordinary "_word_" case.
    if (ch === "_" && !isWordChar(input[i - 1])) {
      const close = findClosingUnderscore(input, i);
      if (close !== -1) {
        const inner = input.slice(i + 1, close);
        if (inner.trim() && !inner.includes("\n") && !inner.includes("_")) {
          push({ id: ids.inline(), type: "emph", children: parseMarkdownInline(inner, ids) });
          i = close + 1;
          continue;
        }
      }
    }

    // Obsidian wikilink / embed
    if (input.startsWith("[[", i)) {
      const close = input.indexOf("]]", i + 2);
      if (close !== -1) {
        const body = input.slice(i + 2, close);
        const pipe = body.indexOf("|");
        const target = (pipe === -1 ? body : body.slice(0, pipe)).trim();
        const alias = pipe === -1 ? undefined : body.slice(pipe + 1).trim();
        if (target) {
          push(inline.link("wikilink", target, alias || undefined));
          i = close + 2;
          continue;
        }
      }
    }

    // Markdown link [text](url "title") — balanced-paren target scan
    if (ch === "[" && input[i + 1] !== "[") {
      const link = readMarkdownLink(input, i);
      if (link && !link.label.startsWith("^")) {
        push(inline.link("url", link.target, link.label, link.title, parseMarkdownInline(link.label, ids)));
        i = link.end;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return mergeAdjacentText(out);
}

function findClosingDollar(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") {
      i++;
      continue;
    }
    if (input[i] === "$") return i;
  }
  return -1;
}

/**
 * CommonMark flanking, approximated: an opener needs a non-whitespace char
 * right after it, a closer a non-whitespace char right before it. (The full
 * punctuation-flanking rule is not modeled.)
 */
function canOpenMarker(input: string, i: number, len: number): boolean {
  const next = input[i + len];
  return next !== undefined && !/\s/.test(next);
}

function canCloseMarker(input: string, close: number, len: number): boolean {
  const prev = input[close - 1];
  return prev !== undefined && !/\s/.test(prev);
}

/** CommonMark: `__` does not count when flanked by alphanumerics (intraword). */
function isIntraword(input: string, i: number, len: number): boolean {
  return isWordChar(input[i - 1]) && isWordChar(input[i + len]);
}

/** Index of the next `marker` run allowed to close emphasis, or -1. */
function findClosingMarker(input: string, from: number, marker: string): number {
  let close = input.indexOf(marker, from);
  while (close !== -1) {
    if (canCloseMarker(input, close, marker.length) && !(marker === "__" && isIntraword(input, close, marker.length))) {
      return close;
    }
    close = input.indexOf(marker, close + 1);
  }
  return -1;
}

/** Index of the `)` matching the `(` at `open`, honoring `\(` escapes; -1. */
function matchParen(input: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let angle = false;
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && /\s/.test(input[i - 1] ?? "")) { quote = ch; continue; }
    if (ch === "<" && depth === 1) { angle = true; continue; }
    if (ch === ">" && angle) { angle = false; continue; }
    if (angle) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split `target "title"` (title optional, single- or double-quoted). */
function splitLinkDestination(raw: string): { target: string; title?: string } {
  const trimmed = raw.trim();
  const m = /^(\S+)\s+(?:"([^"]*)"|'([^']*)')$/.exec(trimmed);
  if (m) {
    return { target: m[1].replace(/^<|>$/g, ""), title: m[2] ?? m[3] };
  }
  return { target: trimmed.replace(/^<|>$/g, "") };
}

/** Index of the `_` allowed to close emphasis opened at `open`, or -1. */
function findClosingUnderscore(input: string, open: number): number {
  for (let j = open + 1; j < input.length; j++) {
    if (input[j] !== "_") continue;
    // A closing underscore may not be followed by a word character, which is
    // what keeps snake_case_names out of the emphasis path.
    if (isWordChar(input[j + 1])) continue;
    return j;
  }
  return -1;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w§]/.test(ch);
}

function mergeAdjacentText(nodes: ScholarInlineNode[]): ScholarInlineNode[] {
  const out: ScholarInlineNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && n.type === "text") prev.text += n.text;
    else out.push(n);
  }
  return out;
}
