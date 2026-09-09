import { IdAllocator, inline } from "../../ir/document";
import type { ScholarInlineNode } from "../../ir/nodes";

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
      const ticks = /^`+/.exec(input.slice(i))![0];
      const close = input.indexOf(ticks, i + ticks.length);
      if (close !== -1) {
        const code = input.slice(i + ticks.length, close);
        push(inline.codeSpan(code));
        i = close + ticks.length;
        continue;
      }
      text += ch;
      i++;
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
      const close = input.indexOf("](", i + 1);
      if (close !== -1) {
        const closeParen = matchParen(input, close + 1);
        if (closeParen !== -1) {
          const label = input.slice(i + 1, close);
          if (!label.startsWith("^")) {
            // footnote refs [^x](…) are not links
            const { target, title } = splitLinkDestination(input.slice(close + 2, closeParen));
            push(inline.link("url", target, label, title));
            i = closeParen + 1;
            continue;
          }
        }
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
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      i++;
      continue;
    }
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
