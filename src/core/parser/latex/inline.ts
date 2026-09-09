import {
  inline,
  IdAllocator,
} from "../../ir/document";
import type { ScholarInlineNode } from "../../ir/nodes";

/**
 * Inline LaTeX → inline IR nodes.
 *
 * Conservative by design: recognized academic commands become structured
 * nodes; anything else is preserved verbatim as an inline-raw node so the
 * LaTeX writer can re-emit it unchanged (fidelity rule, TECHNICAL_DESIGN §8.3).
 */

const CITATION_COMMANDS = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citeauthor",
  "citeyear",
  "parencite",
  "textcite",
  "autocite",
  "footcite",
]);

const EMPH_COMMANDS = new Set(["textit", "emph", "mbox"]); // mbox: no emphasis but braces group
const BOLD_COMMANDS = new Set(["textbf", "textsc"]);
const TEXT_COMMANDS = new Set(["text", "textrm", "texttt", "textsf", "textup", "underline"]);

/** Parse a brace group starting at `input[i] === "{"`; returns inner text and end index. */
export function readBraceGroup(input: string, start: number): { body: string; end: number } | null {
  if (input[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { body: input.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

export function readBracketGroup(input: string, start: number): { body: string; end: number } | null {
  if (input[start] !== "[") return null;
  let depth = 0;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === "]") {
      depth--;
      if (depth === 0) return { body: input.slice(start + 1, i), end: i + 1 };
    } else if (ch === "[") depth++;
  }
  return null;
}

function isAlpha(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

/** Read a `\command` (letters only) starting at `i` where input[i] === "\\". */
function readCommand(input: string, i: number): string | null {
  if (input[i] !== "\\") return null;
  const next = input[i + 1];
  if (next === undefined) return "\\";
  if (!isAlpha(next)) return null; // escaped symbol like \% — caller handles
  let j = i + 1;
  while (j < input.length && isAlpha(input[j])) j++;
  return input.slice(i, j); // includes leading backslash
}

export function parseLatexInline(
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

    // $…$ inline math (respect \$)
    if (ch === "\\" && input[i + 1] === "$") {
      text += "$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      const end = findUnescaped(input, "$", i + 1);
      if (end !== -1) {
        const latex = input.slice(i + 1, end);
        if (latex.trim()) {
          push(inline.math(latex));
          i = end + 1;
          continue;
        }
      }
      text += ch;
      i++;
      continue;
    }

    if (ch === "\\") {
      if (input[i + 1] === "\\") {
        // \\ line break inside a paragraph → soft break
        text += " ";
        i += 2;
        continue;
      }
      const cmd = readCommand(input, i);
      if (cmd === null) {
        // escaped symbol: \% \& \_ \# \{ \} etc.
        text += input[i + 1] ?? "";
        i += 2;
        continue;
      }
      switch (cmd) {
        case "\\(": {
          const close = input.indexOf("\\)", i + 2);
          if (close !== -1) {
            const latex = input.slice(i + 2, close);
            if (latex.trim()) {
              push(inline.math(latex));
              i = close + 2;
              continue;
            }
          }
          text += cmd;
          i += cmd.length;
          continue;
        }
        case "\\%":
        case "\\&":
        case "\\_":
        case "\\#":
        case "\\$":
        case "\\{":
        case "\\}": {
          text += cmd.slice(1);
          i += cmd.length;
          continue;
        }
        case "\\textbackslash": {
          text += "\\";
          i += cmd.length;
          continue;
        }
        default:
          break;
      }

      const after = i + cmd.length;
      const name = cmd.slice(1);
      // natbib-style optional arguments come BEFORE the brace group
      // (\citep[see][p.~5]{key}). Fold them into the citation scan position,
      // otherwise readBraceGroup sees "[" and bails — the keys would fall out
      // as plain text (CODE_REVIEW_R2 P1-4).
      let groupStart = skipSpaces(input, after);
      if (CITATION_COMMANDS.has(name)) {
        let consumed = 0;
        while (input[groupStart] === "[" && consumed < 2) {
          const close = input.indexOf("]", groupStart + 1);
          if (close === -1) break;
          groupStart = skipSpaces(input, close + 1);
          consumed++;
        }
      }
      const group = readBraceGroup(input, groupStart);
      if (group !== null) {
        if (name === "href") {
          // \href{url}{text}
          const rest = skipSpaces(input, group.end);
          const labelGroup = readBraceGroup(input, rest);
          if (labelGroup !== null) {
            push(
              inline.link("url", group.body, labelGroup.body),
            );
            i = labelGroup.end;
            continue;
          }
        }
        if (name === "url") {
          push(inline.link("url", group.body, group.body));
          i = group.end;
          continue;
        }
        if (CITATION_COMMANDS.has(name)) {
          const raw = input.slice(i, group.end);
          const keys = group.body
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean);
          push(inline.citation(raw, keys));
          i = group.end;
          continue;
        }
        if (BOLD_COMMANDS.has(name) || EMPH_COMMANDS.has(name) || TEXT_COMMANDS.has(name)) {
          const children = parseLatexInline(group.body, ids);
          if (BOLD_COMMANDS.has(name)) {
            push({ id: ids.inline(), type: "strong", children });
          } else if (EMPH_COMMANDS.has(name)) {
            push({ id: ids.inline(), type: "emph", children });
          } else if (name === "texttt") {
            // texttt maps to a code span with its plain text content
            push(inline.codeSpan(children.map(inlineText).join("")));
          } else {
            // \text{...}, \textrm{...}, \underline{...} → inline content only.
            // Must go through push() so any buffered plain text is flushed
            // first; pushing straight onto `out` would reorder it after the
            // command's content.
            for (const child of children) push(child);
          }
          i = group.end;
          continue;
        }
        // Unknown command with a brace group: preserve verbatim.
        push({ id: ids.inline(), type: "inline-raw", raw: input.slice(i, group.end) });
        i = group.end;
        continue;
      }
      // Unknown command without arguments (e.g. \item, \midrule in text)
      push({ id: ids.inline(), type: "inline-raw", raw: cmd });
      i += cmd.length;
      continue;
    }

    if (ch === "%" && (i === 0 || input[i - 1] !== "\\")) {
      // LaTeX comment: skip to end of line
      const eol = input.indexOf("\n", i);
      i = eol === -1 ? input.length : eol;
      continue;
    }

    if (ch === "~") {
      text += " ";
      i++;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return mergeText(out);
}

function inlineText(n: ScholarInlineNode): string {
  if (n.type === "text") return n.text;
  if (n.type === "strong" || n.type === "emph") return n.children.map(inlineText).join("");
  if (n.type === "code-span") return n.code;
  if (n.type === "inline-math") return `$${n.latex}$`;
  if (n.type === "link") return n.alias ?? n.target;
  if (n.type === "citation") return n.raw;
  return n.raw; // inline-raw
}

function findUnescaped(input: string, ch: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    if (input[i] === "\\") {
      i++;
      continue;
    }
    if (input[i] === ch) return i;
  }
  return -1;
}

function skipSpaces(input: string, i: number): number {
  while (i < input.length && /\s/.test(input[i])) i++;
  return i;
}

/** Merge adjacent text nodes so output stays normalized. */
export function mergeText(nodes: ScholarInlineNode[]): ScholarInlineNode[] {
  const out: ScholarInlineNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && n.type === "text") {
      prev.text += n.text;
    } else {
      out.push(n);
    }
  }
  return out;
}
