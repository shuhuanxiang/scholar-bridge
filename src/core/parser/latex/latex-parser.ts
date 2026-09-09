import { IdAllocator, inline, makeDocument } from "../../ir/document";
import type {
  AlgorithmNode,
  AlgorithmStatement,
  FigureNode,
  MathEnvironment,
  ScholarBlockNode,
  ScholarDocument,
  ScholarInlineNode,
  TableCell,
  TableNode,
} from "../../ir/nodes";
import {
  parseLatexInline,
  readBraceGroup,
  readBracketGroup,
} from "./inline";

/**
 * LaTeX → Scholar IR (TECHNICAL_DESIGN.md §4).
 *
 * Explicit handlers for the supported academic environments
 * (IMPLEMENTATION_PLAN.md Milestone 1); anything unrecognized becomes a
 * RawLatexNode so no source text is ever destroyed.
 */

const MATH_ENVIRONMENTS = new Set<MathEnvironment>([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "displaymath",
]);

const SECTION_LEVELS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

export function parseLatex(input: string): ScholarDocument {
  const ids = new IdAllocator();
  return parseLatexDocument(input, ids);
}

function parseLatexDocument(input: string, ids: IdAllocator): ScholarDocument {
  let preamble = "";
  let body = input;
  const beginDoc = input.indexOf("\\begin{document}");
  if (beginDoc !== -1) {
    const endDoc = input.indexOf("\\end{document}");
    preamble = input.slice(0, beginDoc);
    body =
      endDoc !== -1
        ? input.slice(beginDoc + "\\begin{document}".length, endDoc)
        : input.slice(beginDoc + "\\begin{document}".length);
  }
  const metadata = parsePreamble(preamble);
  const children = parseLatexBlocks(body, ids);
  return makeDocument(children, Object.keys(metadata).length ? metadata : undefined);
}

function parsePreamble(preamble: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const classMatch = /\\documentclass(?:\[[^\]]*\])?\{([^}]*)\}/.exec(preamble);
  if (classMatch) meta.documentClass = classMatch[1].trim();
  const packages = [...preamble.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)].flatMap((m) =>
    m[1].split(",").map((p) => p.trim()),
  );
  if (packages.length) meta.packages = packages;
  const title = readCommandArg(preamble, "title");
  if (title !== undefined) meta.title = title;
  const author = readCommandArg(preamble, "author");
  if (author !== undefined) meta.author = author;
  return meta;
}

function readCommandArg(text: string, command: string): string | undefined {
  const m = new RegExp(`\\\\${command}\\{`).exec(text);
  if (!m) return undefined;
  const group = readBraceGroup(text, m.index + m[0].length - 1);
  return group?.body.trim();
}

/** Scan a LaTeX body into block nodes. */
export function parseLatexBlocks(body: string, ids: IdAllocator): ScholarBlockNode[] {
  const children: ScholarBlockNode[] = [];
  let i = 0;
  let paragraphBuffer = "";

  const flushParagraph = () => {
    const text = paragraphBuffer.trim();
    paragraphBuffer = "";
    if (!text) return;
    children.push(...parseTextWithDisplayMath(text, ids));
  };

  while (i < body.length) {
    // Blank lines end the current paragraph.
    const blankEnd = blankRunEnd(body, i);
    if (blankEnd !== null) {
      flushParagraph();
      i = blankEnd;
      continue;
    }

    if (body.startsWith("\\begin{", i)) {
      flushParagraph();
      const parsed = parseEnvironment(body, i, ids);
      if (parsed) {
        children.push(...parsed.nodes);
        i = parsed.end;
        continue;
      }
    }

    const section = parseSectionAt(body, i);
    if (section) {
      flushParagraph();
      const group = readBraceGroup(body, section.braceStart);
      if (group) {
        const childrenInline = parseLatexInline(group.body, ids);
        children.push({
          id: ids.next("heading"),
          type: "heading",
          level: SECTION_LEVELS[section.name],
          children: childrenInline,
          ...(section.starred ? { source: { format: "latex", raw: `${section.name}*` } } : {}),
        });
        i = group.end;
        continue;
      }
    }

    // Comment line: drop (LaTeX comments carry no document content).
    if (body[i] === "%") {
      const eol = body.indexOf("\n", i);
      flushParagraph();
      i = eol === -1 ? body.length : eol + 1;
      continue;
    }

    // Standalone \command line that is not a known block: keep as raw block.
    if (!paragraphBuffer && body[i] === "\\") {
      const name = commandNameAt(body, i);
      if (name && !isInlineCommandName(name)) {
        flushParagraph();
        const lineEnd = body.indexOf("\n", i);
        const end = lineEnd === -1 ? body.length : lineEnd + 1;
        children.push({
          id: ids.next("raw-latex"),
          type: "raw-latex",
          raw: body.slice(i, end).trim(),
          reason: "unsupported standalone command",
        });
        i = end;
        continue;
      }
    }

    // Regular text: accumulate until blank line / block start.
    const nextBreak = findNextLineBreakOrCommand(body, i);
    paragraphBuffer += body.slice(i, nextBreak);
    i = nextBreak;
  }
  flushParagraph();
  return children;
}

/**
 * Length of the whitespace run ending at the first newline, or null when the
 * text at `i` does not start a blank line. Substring-free so the block scan
 * stays linear on large documents.
 */
function blankRunEnd(body: string, i: number): number | null {
  let j = i;
  while (j < body.length && body[j] !== "\n" && /\s/.test(body[j])) j++;
  return j < body.length && body[j] === "\n" ? j + 1 : null;
}

function isAlphaAt(text: string, i: number): boolean {
  return i < text.length && /[A-Za-z]/.test(text[i]);
}

/** `\command` name at `i` (without backslash), or "" for escaped symbols. */
function commandNameAt(text: string, i: number): string {
  if (text[i] !== "\\" || !isAlphaAt(text, i + 1)) return "";
  let j = i + 1;
  while (isAlphaAt(text, j)) j++;
  return text.slice(i + 1, j);
}

const SECTION_NAMES = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];

/** `\section*?[opt]{`-style heading at `i`; returns the `{` position. */
function parseSectionAt(
  body: string,
  i: number,
): { name: string; starred: boolean; braceStart: number } | null {
  const name = commandNameAt(body, i);
  if (!name || !SECTION_NAMES.includes(name)) return null;
  let j = i + 1 + name.length;
  const starred = body[j] === "*";
  if (starred) j++;
  while (j < body.length && /\s/.test(body[j])) j++;
  if (body[j] === "[") {
    const close = body.indexOf("]", j);
    if (close === -1) return null;
    j = close + 1;
    while (j < body.length && /\s/.test(body[j])) j++;
  }
  return body[j] === "{" ? { name, starred, braceStart: j } : null;
}

function isInlineCommandName(name: string): boolean {
  // Commands that commonly appear at the start of a text paragraph.
  return /^(text|emph|textbf|textit|texttt|cite|ref|eqref|noindent|indent|item)$/.test(name);
}

/** Advance to the next newline or a `\command`/`\begin` that starts a new block. */
function findNextLineBreakOrCommand(body: string, from: number): number {
  for (let i = from; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      if (body.startsWith("\\begin{", i)) return i;
      if (parseSectionAt(body, i)) return i;
      i++; // skip escaped char
      continue;
    }
    if (ch === "\n") {
      // Peek: next non-empty content starting a block construct?
      let j = i + 1;
      while (j < body.length && (body[j] === " " || body[j] === "\t" || body[j] === "\r")) j++;
      if (
        j >= body.length ||
        body[j] === "\n" ||
        body.startsWith("\\begin{", j) ||
        parseSectionAt(body, j) ||
        body[j] === "%"
      ) {
        return i + 1;
      }
    }
  }
  return body.length;
}

/** Split paragraph text on display math ($$…$$ and \[…\]) into block nodes. */
function parseTextWithDisplayMath(text: string, ids: IdAllocator): ScholarBlockNode[] {
  const blocks: ScholarBlockNode[] = [];
  let buffer = "";
  let i = 0;
  const flushPara = () => {
    const trimmed = buffer.trim();
    buffer = "";
    if (!trimmed) return;
    const inlines = parseLatexInline(trimmed, ids);
    if (inlines.length) blocks.push({ id: ids.next("paragraph"), type: "paragraph", children: inlines });
  };
  while (i < text.length) {
    if (text.startsWith("$$", i)) {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1) {
        flushPara();
        blocks.push(makeMathNode(text.slice(i + 2, close), undefined, ids));
        i = close + 2;
        continue;
      }
    }
    if (text.startsWith("\\[", i)) {
      const close = text.indexOf("\\]", i + 2);
      if (close !== -1) {
        flushPara();
        blocks.push(makeMathNode(text.slice(i + 2, close), undefined, ids));
        i = close + 2;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flushPara();
  return blocks;
}

function makeMathNode(body: string, environment: MathEnvironment | undefined, ids: IdAllocator) {
  const { latex, label } = extractLabel(body);
  return {
    id: ids.next("math"),
    type: "math" as const,
    display: true,
    latex: latex.trim(),
    ...(environment ? { environment } : {}),
    ...(label ? { label } : {}),
  };
}

function extractLabel(body: string): { latex: string; label?: string } {
  const m = /\\label\{([^}]*)\}/.exec(body);
  if (!m) return { latex: body };
  const label = m[1].trim();
  const latex = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
  return { latex, label };
}

// ---------------------------------------------------------------------------
// Environment dispatch
// ---------------------------------------------------------------------------

function parseEnvironment(
  body: string,
  start: number,
  ids: IdAllocator,
): { nodes: ScholarBlockNode[]; end: number } | null {
  const nameMatch = /^\\begin\{([^}]*)\}/.exec(body.slice(start));
  if (!nameMatch) return null;
  const envName = nameMatch[1];
  let cursor = start + nameMatch[0].length;
  const optional = readBracketGroup(body, cursor);
  const placement = optional ? optional.body.trim() : undefined;
  if (optional) cursor = optional.end;

  const endIdx = findMatchingEnd(body, cursor, envName);
  if (endIdx === -1) {
    // No closing \end: preserve the raw remainder, never drop it.
    return {
      nodes: [
        {
          id: ids.next("raw-latex"),
          type: "raw-latex",
          raw: body.slice(start),
          reason: `unterminated environment: ${envName}`,
        },
      ],
      end: body.length,
    };
  }
  const inner = body.slice(cursor, endIdx);
  const end = endIdx + `\\end{${envName}}`.length;

  if (MATH_ENVIRONMENTS.has(envName as MathEnvironment)) {
    return { nodes: [makeMathNode(inner, envName as MathEnvironment, ids)], end };
  }
  switch (envName) {
    case "table":
    case "table*":
      return { nodes: [parseTableFloat(inner, placement, ids)], end };
    case "tabular":
    case "tabular*":
      return { nodes: [parseTabularFloat(inner, placement, ids, envName === "tabular*")], end };
    case "figure":
    case "figure*":
      return { nodes: [parseFigure(inner, placement, ids)], end };
    case "algorithm":
      return { nodes: [parseAlgorithm(inner, placement, ids)], end };
    case "itemize":
    case "enumerate": {
      const list = parseList(inner, envName === "enumerate", ids);
      return { nodes: [list], end };
    }
    case "quote": {
      const children = parseLatexBlocks(inner, ids);
      return { nodes: [{ id: ids.next("quote"), type: "quote", children }], end };
    }
    case "abstract": {
      return { nodes: parseLatexBlocks(inner, ids), end };
    }
    case "verbatim":
      return {
        nodes: [{ id: ids.next("code"), type: "code", code: inner.replace(/^\n/, "") }],
        end,
      };
    case "lstlisting":
      return {
        nodes: [
          {
            id: ids.next("code"),
            type: "code",
            language: placement?.match(/language=([\w+-]+)/)?.[1] ?? placement,
            code: inner.replace(/^\n/, ""),
          },
        ],
        end,
      };
    default:
      return {
        nodes: [
          {
            id: ids.next("raw-latex"),
            type: "raw-latex",
            raw: body.slice(start, end),
            reason: `unsupported environment: ${envName}`,
          },
        ],
        end,
      };
  }
}

/** Find the next `\end{name}`, counting nested same-name environments. */
function findMatchingEnd(body: string, from: number, name: string): number {
  const needle = `\\end{${name}}`;
  const begin = `\\begin{${name}}`;
  let depth = 1;
  let i = from;
  while (i < body.length) {
    if (body.startsWith(begin, i)) {
      depth++;
      i += begin.length;
      continue;
    }
    if (body.startsWith(needle, i)) {
      depth--;
      if (depth === 0) return i;
      i += needle.length;
      continue;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Math helpers used by table cells too
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function parseTableFloat(
  inner: string,
  placement: string | undefined,
  ids: IdAllocator,
): TableNode | ScholarBlockNode {
  const caption = readCommandArg(inner, "caption");
  const label = readCommandArg(inner, "label");
  const tabularMatch = /\\begin\{tabular\*?\}/.exec(inner);
  if (!tabularMatch) {
    // Table float without tabular (e.g. contains only raw content): raw fallback.
    return {
      id: ids.next("raw-latex"),
      type: "raw-latex",
      raw: `\\begin{table}${placement ? `[${placement}]` : ""}${inner}\\end{table}`,
      reason: "table without tabular environment",
    };
  }
  const node = parseTabularFloat(inner.slice(tabularMatch.index), placement, ids, false);
  if (caption) node.caption = caption;
  if (label) node.label = label;
  return node;
}

function parseTabularFloat(
  text: string,
  placement: string | undefined,
  ids: IdAllocator,
  starred: boolean,
): TableNode {
  const beginMatch = /\\begin\{tabular\*?\}/.exec(text);
  let cursor = beginMatch ? beginMatch.index + beginMatch[0].length : 0;
  if (starred) {
    // \begin{tabular*}{width}{column spec}
    const widthGroup = readBraceGroup(text, skipSpaces(text, cursor));
    if (widthGroup) cursor = widthGroup.end;
  }
  const specGroup = readBraceGroup(text, skipSpaces(text, cursor));
  const columnSpec = specGroup?.body ?? "";
  if (specGroup) cursor = specGroup.end;
  const endIdx = findMatchingEnd(text, cursor, starred ? "tabular*" : "tabular");
  const inner = endIdx === -1 ? text.slice(cursor) : text.slice(cursor, endIdx);

  const alignments = parseColumnSpec(columnSpec);
  const hasBooktabs = /\\(toprule|midrule|bottomrule|cmidrule)/.test(inner);
  const rawRows = splitTabularRows(inner);
  const parsedRows = rawRows.map((raw) => parseRawRow(raw, ids));

  const rows = resolveSpans(parsedRows);
  return {
    id: ids.next("table"),
    type: "table",
    rows,
    ...(columnSpec ? { columnSpec } : {}),
    ...(alignments.length ? { columnAlignments: alignments } : {}),
    ...(hasBooktabs ? { booktabs: true } : {}),
    ...(placement ? { placement } : {}),
  };
}

/** Column letters → alignment list; ignores | and @{…} decorations. */
export function parseColumnSpec(spec: string): ("left" | "center" | "right")[] {
  const out: ("left" | "center" | "right")[] = [];
  let i = 0;
  while (i < spec.length) {
    const ch = spec[i];
    if (ch === "l") out.push("left");
    else if (ch === "c") out.push("center");
    else if (ch === "r") out.push("right");
    else if (ch === "p" || ch === "m" || ch === "b") {
      out.push("left");
      const g = readBraceGroup(spec, i + 1);
      if (g) i = g.end - 1;
    } else if (ch === "@") {
      const g = readBraceGroup(spec, i + 1);
      if (g) i = g.end - 1;
    } else if (ch === "*") {
      // *{n}{spec}: expand — read both groups and re-scan the inner spec
      const nG = readBraceGroup(spec, i + 1);
      if (nG) {
        const specG = readBraceGroup(spec, skipSpaces(spec, nG.end));
        if (specG) {
          const n = Number.parseInt(nG.body, 10) || 1;
          const expanded = parseColumnSpec(specG.body);
          for (let k = 0; k < n; k++) out.push(...expanded);
          i = specG.end - 1;
        }
      }
    }
    i++;
  }
  return out;
}

function skipSpaces(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** Strip a trailing `%` comment; `\%` escapes are kept (escape-aware scan). */
function stripLatexComment(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      out += ch + (line[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "%") break;
    out += ch;
  }
  return out;
}

/**
 * Split tabular body on depth-0 `\\` row separators. `\\` inside a nested
 * environment (e.g. a pmatrix in a cell) does not end the row.
 */
function splitTabularRows(inner: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let envDepth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\") {
      // Consume the whole \begin{env}/\end{env} token INCLUDING its braces:
      // the old code skipped the "{" (i += 6/4) while the "}" was still
      // counted below, driving `depth` negative after every environment
      // (found by the R2 P2-1 fix's own test suite).
      if (inner.startsWith("\\begin{", i)) {
        const close = inner.indexOf("}", i);
        if (close !== -1) {
          envDepth++;
          current += inner.slice(i, close + 1);
          i = close;
          continue;
        }
        envDepth++;
        current += "\\begin{";
        i += 6;
        continue;
      }
      if (inner.startsWith("\\end{", i)) {
        const close = inner.indexOf("}", i);
        if (close !== -1) {
          envDepth = Math.max(0, envDepth - 1);
          current += inner.slice(i, close + 1);
          i = close;
          continue;
        }
        envDepth = Math.max(0, envDepth - 1);
        current += "\\end{";
        i += 4;
        continue;
      }
      // Row separator only OUTSIDE brace groups and environments: a \\
      // inside a cell's braces (\makecell{X\\Y}, \footnote{a\\b}) or inside
      // a nested environment (\begin{pmatrix} p \\ q \end{pmatrix}) belongs
      // to the inner construct (CODE_REVIEW_R2 P2-1).
      if (envDepth === 0 && depth === 0 && inner[i + 1] === "\\") {
        rows.push(current);
        current = "";
        i++;
        continue;
      }
      current += ch + (inner[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    current += ch;
  }
  rows.push(current);
  return rows
    .map((r) =>
      r
        .replace(/\\(toprule|midrule|bottomrule)/g, "")
        .replace(/\\cmidrule(\([^)]*\))?(\[[^\]]*\])?\{[^}]*\}/g, "")
        .replace(/\\hline/g, "")
        .replace(/\\(addlinespace|noalign)(\[[^\]]*\])?(\{[^}]*\})?/g, "")
        .trim(),
    )
    .filter((r) => r.length > 0);
}

function parseRawRow(raw: string, ids: IdAllocator): TableCell[] {
  if (!raw.trim()) return [];
  const cells: TableCell[] = [];
  let depth = 0;
  let current = "";
  const parts: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && raw[i + 1] === "&") {
      current += "&";
      i++;
      continue;
    }
    if (ch === "\\") {
      current += ch + (raw[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "&" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  for (const part of parts) {
    cells.push(parseCell(part.trim(), ids));
  }
  return cells;
}

function parseCell(raw: string, ids: IdAllocator): TableCell {
  if (raw.startsWith("\\multirow")) {
    const after = raw.slice("\\multirow".length);
    const nG = readBraceGroup(after, skipSpaces(after, 0));
    if (nG) {
      const widthG = readBraceGroup(after, skipSpaces(after, nG.end));
      if (widthG) {
        const contentG = readBraceGroup(after, skipSpaces(after, widthG.end));
        if (contentG) {
          return {
            content: parseLatexInline(contentG.body, ids),
            rowSpan: Number.parseInt(nG.body, 10) || 1,
          };
        }
      }
    }
  }
  if (raw.startsWith("\\multicolumn")) {
    const after = raw.slice("\\multicolumn".length);
    const nG = readBraceGroup(after, skipSpaces(after, 0));
    if (nG) {
      const specG = readBraceGroup(after, skipSpaces(after, nG.end));
      if (specG) {
        const contentG = readBraceGroup(after, skipSpaces(after, specG.end));
        if (contentG) {
          const alignChar = specG.body.trim()[0];
          const alignment =
            alignChar === "c" ? "center" : alignChar === "r" ? "right" : alignChar === "|" ? undefined : "left";
          return {
            content: parseLatexInline(contentG.body, ids),
            colSpan: Number.parseInt(nG.body, 10) || 1,
            ...(alignment ? { alignment } : {}),
          };
        }
      }
    }
  }
  return { content: parseLatexInline(raw, ids) };
}

/**
 * Insert rowSpan continuation placeholders so every row has a cell for each
 * covered column (mirrors how HTML/Markdown renderers consume spans).
 */
function resolveSpans(rows: TableCell[][]): TableCell[][] {
  const pending: number[] = []; // per column: placeholder rows still owed
  const out: TableCell[][] = [];
  for (const row of rows) {
    const placed: TableCell[] = [];
    let col = 0;
    for (const cell of row) {
      while ((pending[col] ?? 0) > 0) {
        placed.push({ content: [], rowSpanContinue: true });
        pending[col] -= 1;
        col += 1;
      }
      placed.push(cell);
      const span = cell.rowSpan ?? 1;
      if (span > 1) pending[col] = (pending[col] ?? 0) + span - 1;
      col += cell.colSpan ?? 1;
    }
    while ((pending[col] ?? 0) > 0) {
      placed.push({ content: [], rowSpanContinue: true });
      pending[col] -= 1;
      col += 1;
    }
    out.push(placed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function parseFigure(inner: string, placement: string | undefined, ids: IdAllocator): FigureNode | ScholarBlockNode {
  const graphicsMatches = [...inner.matchAll(/\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g)];
  const captionGroup = readCommandArgWithGroup(inner, "caption");
  const label = readCommandArg(inner, "label");
  if (graphicsMatches.length !== 1) {
    return {
      id: ids.next("raw-latex"),
      type: "raw-latex",
      raw: `\\begin{figure}${placement ? `[${placement}]` : ""}${inner}\\end{figure}`,
      reason:
        graphicsMatches.length === 0
          ? "figure without includegraphics"
          : "figure with multiple includegraphics (subfigures)",
    };
  }
  const path = graphicsMatches[0][2].trim();
  const options = graphicsMatches[0][1] ?? "";
  const widthMatch = /width\s*=\s*([^,\]]+)/.exec(options);
  const latexWidth = widthMatch ? widthMatch[1].trim() : undefined;
  return {
    id: ids.next("figure"),
    type: "figure",
    path,
    ...(captionGroup ? { caption: latexInlineToText(parseLatexInline(captionGroup, ids)) } : {}),
    ...(label ? { label } : {}),
    ...(latexWidth ? { latexWidth, width: latexWidthToDisplay(latexWidth) } : {}),
    ...(placement ? { placement } : {}),
  };
}

function readCommandArgWithGroup(text: string, command: string): string | undefined {
  const m = new RegExp(`\\\\${command}\\b\\s*(?:\\[[^\\]]*\\]\\s*)?\\{`).exec(text);
  if (!m) return undefined;
  const group = readBraceGroup(text, m.index + m[0].length - 1);
  return group?.body;
}

/** `0.45\textwidth` → "45%"; passthrough for other expressions. */
function latexWidthToDisplay(latexWidth: string): string | undefined {
  const m = /^([0-9]*\.?[0-9]+)\\textwidth$/.exec(latexWidth);
  if (m) return `${Math.round(Number.parseFloat(m[1]) * 100)}%`;
  const pct = /^([0-9]*\.?[0-9]+)%$/.exec(latexWidth);
  if (pct) return `${pct[1]}%`;
  return undefined;
}

export function latexInlineToText(nodes: ScholarInlineNode[]): string {
  return nodes.map(inlineToText).join("");
}

function inlineToText(n: ScholarInlineNode): string {
  switch (n.type) {
    case "text":
      return n.text;
    case "inline-math":
      return `$${n.latex}$`;
    case "code-span":
      return n.code;
    case "strong":
    case "emph":
      return n.children.map(inlineToText).join("");
    case "link":
      return n.alias ?? n.target;
    case "citation":
      return n.raw;
    case "inline-raw":
      return n.raw;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

function parseAlgorithm(inner: string, placement: string | undefined, ids: IdAllocator): AlgorithmNode | ScholarBlockNode {
  const caption = readCommandArg(inner, "caption");
  const label = readCommandArg(inner, "label");
  const algMatch = /\\begin\{(algorithmic|algpseudocode)\}/.exec(inner);
  if (!algMatch) {
    return {
      id: ids.next("raw-latex"),
      type: "raw-latex",
      raw: `\\begin{algorithm}${placement ? `[${placement}]` : ""}${inner}\\end{algorithm}`,
      reason: "algorithm without algorithmic environment",
    };
  }
  const backendName = algMatch[1] as "algorithmic" | "algpseudocode";
  const bodyStart = algMatch.index + algMatch[0].length;
  const endIdx = findMatchingEnd(inner, bodyStart, backendName);
  const body = endIdx === -1 ? inner.slice(bodyStart) : inner.slice(bodyStart, endIdx);
  const kept = body
    .split("\n")
    .map((line) => ({
      leading: line.length - line.trimStart().length,
      text: stripLatexComment(line).trim(),
    }))
    .filter((s) => s.text.length > 0);
  // Indent relative to the smallest indent — one level per two leading
  // spaces, mirroring the Markdown scholar-algorithm fence path.
  const minIndent = Math.min(...kept.map((s) => s.leading));
  const statements: AlgorithmStatement[] = kept.map((s) => ({
    text: s.text,
    indent: Math.floor((s.leading - minIndent) / 2),
  }));
  return {
    id: ids.next("algorithm"),
    type: "algorithm",
    ...(caption ? { caption: latexInlineToText(parseLatexInline(caption, ids)) } : {}),
    ...(label ? { label } : {}),
    backend: backendName,
    body: statements,
  };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function parseList(inner: string, ordered: boolean, ids: IdAllocator) {
  const itemBodies = splitOnItems(inner);
  const items = itemBodies.map((body) => ({
    id: ids.next("list-item"),
    type: "list-item" as const,
    children: parseLatexBlocks(body, ids),
  }));
  return {
    id: ids.next("list"),
    type: "list" as const,
    ordered,
    ...(ordered ? { start: 1 } : {}),
    items,
  };
}

/** Split a list environment body on depth-0 \item markers. */
function splitOnItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let envDepth = 0;
  let i = 0;
  while (i < inner.length) {
    if (inner.startsWith("\\begin{", i)) {
      envDepth++;
      current += "\\begin{";
      i += 7;
      continue;
    }
    if (inner.startsWith("\\end{", i)) {
      envDepth--;
      current += "\\end{";
      i += 5;
      continue;
    }
    if (inner.startsWith("\\item", i) && envDepth === 0) {
      const after = inner[i + 5];
      if (after === undefined || /[\s[{]/.test(after)) {
        items.push(current);
        current = "";
        i += 5;
        // skip optional [label]
        if (after === "[") {
          const close = inner.indexOf("]", i);
          if (close !== -1) i = close + 1;
        }
        continue;
      }
    }
    current += inner[i];
    i++;
  }
  items.push(current);
  const trimmed = items.map((s) => s.trim()).filter(Boolean);
  return trimmed.length ? trimmed : [inner.trim()];
}

// re-export for writers/tests
export { inline };
