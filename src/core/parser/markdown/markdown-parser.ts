import { IdAllocator, makeDocument } from "../../ir/document";
import {
  decodeMetaComment,
  decodeTranslationStart,
  isTranslationEnd,
  type ScholarBridgeMeta,
  type TranslationMeta,
} from "../../ir/metadata";
import type {
  AlgorithmNode,
  FigureNode,
  ScholarBlockNode,
  ScholarDocument,
  ScholarInlineNode,
  TableCell,
  TableNode,
} from "../../ir/nodes";
import { parseMarkdownInline } from "./inline";

/**
 * Obsidian Markdown → Scholar IR (TECHNICAL_DESIGN.md §5).
 *
 * Handles: ATX headings, paragraphs, fenced code, scholar-algorithm blocks,
 * inline/display math, lists, quotes, GFM tables, ScholarBridge-generated
 * HTML tables, embeds/wikilinks, links, and hidden ScholarBridge metadata.
 */
export function parseMarkdown(input: string): ScholarDocument {
  const ids = new IdAllocator();
  const { yaml, body } = stripFrontmatter(input);
  const children = parseBlocks(body, ids);
  return makeDocument(children, yaml ? { yaml } : undefined);
}

function stripFrontmatter(input: string): { yaml?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\n|$)/.exec(input);
  if (!m || m.index !== 0) return { body: input };
  return { yaml: m[1], body: input.slice(m[0].length) };
}

function parseBlocks(input: string, ids: IdAllocator): ScholarBlockNode[] {
  const lines = input.split(/\r?\n/);
  const blocks: ScholarBlockNode[] = [];
  // Active `scholarbridge:translation:start … end` collection, if any.
  let translation: { meta: TranslationMeta; lines: string[] } | null = null;
  let i = 0;

  const push = (node: ScholarBlockNode) => {
    if (translation) {
      translation.lines.push(blockToPlainLines(node));
    } else {
      blocks.push(node);
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code / scholar-algorithm
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    const fenceChar = fence?.[1][0];
    const fenceInfo = fence ? fence[2].trim() : "";
    // CommonMark: the info string of a backtick fence may not contain `
    if (fence && (fenceChar === "~" || !fenceInfo.includes("`"))) {
      const openLen = fence[1].length;
      // Closes only on a line of only fence chars, at least as long as the
      // opener — a shorter/longer-texted ``` line is content.
      const closeRe = fenceChar === "`" ? /^`+$/ : /^~+$/;
      const content: string[] = [];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (closeRe.test(t) && t.length >= openLen) break;
        content.push(lines[i]);
        i++;
      }
      i++; // closing fence
      push(makeCodeLike(fenceInfo, content.join("\n"), ids));
      continue;
    }

    // HTML comments: ScholarBridge metadata / translation markers / plain
    if (trimmed.startsWith("<!--")) {
      const { body: comment, next } = readHtmlComment(lines, i);
      i = next;
      const inner = comment.replace(/^\s*<!--/, "").replace(/-->\s*$/, "");

      const startMeta = decodeTranslationStart(inner);
      if (startMeta) {
        translation = { meta: startMeta, lines: [] };
        continue;
      }
      if (isTranslationEnd(inner)) {
        if (translation) {
          blocks.push({
            id: ids.next("translation-block"),
            type: "translation-block",
            meta: translation.meta,
            text: translation.lines.join("\n").trim(),
          });
          translation = null;
        }
        continue;
      }
      const meta = decodeMetaComment(inner);
      if (meta && applyMetaToPrevious(meta, blocks)) continue;
      push({ id: ids.next("raw-html"), type: "raw-html", raw: comment, reason: meta ? "orphan scholarbridge metadata" : "html comment" });
      continue;
    }

    // GFM table (header + separator line). The separator must have the same
    // cell count as the header, so setext-style underlines (`a | b` + `---`)
    // are not mistaken for one-column tables.
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      lines[i + 1].includes("-") &&
      /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) &&
      splitGfmRow(trimmed).length === splitGfmRow(lines[i + 1]).length
    ) {
      const alignments = parseAlignments(lines[i + 1]);
      const rows: string[][] = [splitGfmRow(trimmed)];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitGfmRow(lines[i].trim()));
        i++;
      }
      push(makeGfmTable(rows, alignments, ids));
      continue;
    }

    // HTML table or stray HTML block
    if (/^<([a-z]+)[\s>]/i.test(trimmed)) {
      if (/^<table[\s>]/i.test(trimmed)) {
        let html = lines[i];
        let j = i + 1;
        while (j < lines.length && !/<\/table\s*>/i.test(html)) {
          html += "\n" + lines[j];
          j++;
        }
        const table = parseHtmlTable(html, ids);
        push(table ?? { id: ids.next("raw-html"), type: "raw-html", raw: html, reason: "unparsed HTML table" });
        i = j;
        continue;
      }
      let html = lines[i];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && /^<[a-z!/]/i.test(lines[j].trim())) {
        html += "\n" + lines[j];
        j++;
      }
      push({ id: ids.next("raw-html"), type: "raw-html", raw: html, reason: "html block" });
      i = j;
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      push({
        id: ids.next("heading"),
        type: "heading",
        level: heading[1].length,
        children: parseMarkdownInline(heading[2], ids),
      });
      i++;
      continue;
    }

    // Display math block: $$ … $$ possibly across lines
    if (trimmed.startsWith("$$")) {
      // Complete pair on the same line: a math block (body may be empty) or
      // Obsidian-style inline display math followed by prose on one line.
      const close = trimmed.indexOf("$$", 2);
      if (close !== -1) {
        const latex = trimmed.slice(2, close).trim();
        const remainder = trimmed.slice(close + 2);
        if (!remainder.trim()) {
          push(makeDisplayMath(latex, ids));
          i++;
          continue;
        }
        push({
          id: ids.next("paragraph"),
          type: "paragraph",
          children: [
            { id: ids.inline(), type: "inline-math", latex, display: true },
            ...parseMarkdownInline(remainder, ids),
          ],
        });
        i++;
        continue;
      }
      const content: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("$$")) {
        content.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        content.push(lines[i].trim().slice(0, -2));
        i++;
      }
      push(makeDisplayMath(content.join("\n"), ids));
      continue;
    }

    // Display math \[ … \]
    if (trimmed.startsWith("\\[")) {
      const content: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith("\\]")) {
        content.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        content.push(lines[i].trim().slice(0, -2));
        i++;
      }
      push(makeDisplayMath(content.join("\n"), ids));
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoted.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      push({
        id: ids.next("quote"),
        type: "quote",
        children: parseBlocks(quoted.join("\n"), ids),
      });
      continue;
    }

    // Thematic break (`---`, `***`, `___`, incl. spaced variants like * * *).
    // Checked before lists so `* * *` is not read as a nested list; setext
    // underlines are unsupported (documented limitation).
    if (isThematicBreak(trimmed)) {
      push({ id: ids.next("thematic-break"), type: "thematic-break" });
      i++;
      continue;
    }

    // Lists
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const { node, next } = parseListBlock(lines, i, ids);
      push(node);
      i = next;
      continue;
    }

    // Paragraph: accumulate until blank line or a new block construct
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim()) {
      const t = lines[i].trim();
      if (
        /^#{1,6}\s/.test(t) ||
        t.startsWith("```") ||
        t.startsWith("~~~") ||
        t.startsWith("<!--") ||
        t.startsWith(">") ||
        t.startsWith("$$") ||
        t.startsWith("\\[") ||
        /^([-*+]|\d+[.)])\s+/.test(t) ||
        /^<([a-z]+)[\s>]/i.test(t) ||
        isThematicBreak(t)
      ) {
        break;
      }
      para.push(lines[i]);
      i++;
    }
    for (const node of makeParagraphOrFigure(para.join("\n"), ids)) push(node);
  }

  // Unterminated translation block: keep the collected text (never drop).
  if (translation) {
    blocks.push({
      id: ids.next("translation-block"),
      type: "translation-block",
      meta: translation.meta,
      text: translation.lines.join("\n").trim(),
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Node factories
// ---------------------------------------------------------------------------

function makeDisplayMath(latex: string, ids: IdAllocator) {
  return {
    id: ids.next("math"),
    type: "math" as const,
    display: true,
    latex: latex.trim(),
  };
}

function makeCodeLike(info: string, code: string, ids: IdAllocator): ScholarBlockNode {
  if (info === "scholar-algorithm") {
    const statements = code
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => ({
        text: l.trim(),
        indent: Math.floor((l.length - l.trimStart().length) / 2),
      }));
    const node: AlgorithmNode = {
      id: ids.next("algorithm"),
      type: "algorithm",
      backend: "unknown",
      body: statements,
    };
    return node;
  }
  if (info === "latex") {
    // Raw LaTeX fallback block (preserved verbatim for export).
    return { id: ids.next("raw-latex"), type: "raw-latex", raw: code };
  }
  return {
    id: ids.next("code"),
    type: "code",
    ...(info ? { language: info } : {}),
    code,
  };
}

/** Standalone embed/image line → FigureNode; otherwise a paragraph. */
function makeParagraphOrFigure(text: string, ids: IdAllocator): ScholarBlockNode[] {
  const single = text.trim();
  const embed = /^!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(single);
  if (embed) {
    const width = embed[2]?.trim();
    return [
      {
        id: ids.next("figure"),
        type: "figure",
        path: embed[1].trim(),
        ...(width ? { width } : {}),
      } satisfies FigureNode,
    ];
  }
  const image = /^!\[([^\]]*)\]\(\s*[^)\s]+(?:\s+"[^"]*")?\s*\)$/.exec(single);
  if (image) {
    const src = /!\[[^\]]*\]\(\s*([^)\s]+)/.exec(single)![1];
    const title = /!\[[^\]]*\]\([^)"']*"([^"]*)"/.exec(single)?.[1];
    const alt = image[1];
    return [
      {
        id: ids.next("figure"),
        type: "figure",
        path: src,
        ...(title || alt ? { caption: title || alt } : {}),
      } satisfies FigureNode,
    ];
  }
  return [
    {
      id: ids.next("paragraph"),
      type: "paragraph",
      children: parseMarkdownInline(single, ids),
    },
  ];
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function parseListBlock(
  lines: string[],
  start: number,
  ids: IdAllocator,
): { node: ScholarBlockNode; next: number } {
  const baseMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start])!;
  const baseIndent = baseMatch[1].length;
  const ordered = /\d/.test(baseMatch[2][0]);
  const startNum = ordered ? Number.parseInt(baseMatch[2], 10) : undefined;

  const items: string[][] = [];
  let currentItem: string[] | null = null;
  let sawBlank = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // Blank line: stays in the list when content continues afterwards.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (
        j < lines.length &&
        (itemIndentation(lines[j]) > baseIndent || sameMarkerFamily(lines[j], baseIndent, ordered))
      ) {
        currentItem?.push(line);
        sawBlank = true;
        i++;
        continue;
      }
      break;
    }
    if (markerIndent(line) === baseIndent && sameMarkerFamily(line, baseIndent, ordered)) {
      currentItem = [line.replace(/^(\s*)([-*+]|\d+[.)])\s+/, "")];
      items.push(currentItem);
      i++;
      continue;
    }
    if (itemIndentation(line) > baseIndent && currentItem) {
      currentItem.push(line.slice(Math.min(baseIndent + 2, itemIndentation(line))));
      i++;
      continue;
    }
    break;
  }

  const itemNodes = items.map((item) => ({
    id: ids.next("list-item"),
    type: "list-item" as const,
    children: parseBlocks(item.join("\n"), ids),
  }));
  return {
    node: {
      id: ids.next("list"),
      type: "list",
      ordered,
      ...(startNum !== undefined && startNum !== 1 ? { start: startNum } : {}),
      ...(sawBlank ? { loose: true } : {}),
      items: itemNodes,
    },
    next: i,
  };
}

/** `***`, `---`, `___` with 3+ marker chars; spaces between chars allowed. */
function isThematicBreak(line: string): boolean {
  return /^([*_-])([ \t]*\1){2,}$/.test(line);
}

function itemIndentation(line: string): number {
  return line.length - line.trimStart().length;
}

function markerIndent(line: string): number {
  const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
  return m ? m[1].length : -1;
}

/** A different marker family (`1.` vs `-`) starts a new list. */
function sameMarkerFamily(line: string, baseIndent: number, ordered: boolean): boolean {
  const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
  return !!m && m[1].length === baseIndent && /\d/.test(m[2][0]) === ordered;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function parseAlignments(sepLine: string): ("left" | "center" | "right" | undefined)[] {
  return splitGfmRow(sepLine).map((cell) => {
    const t = cell.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center" as const;
    if (right) return "right" as const;
    if (left) return "left" as const;
    return undefined;
  });
}

function splitGfmRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function makeGfmTable(
  rows: string[][],
  alignments: ("left" | "center" | "right" | undefined)[],
  ids: IdAllocator,
): TableNode {
  const tableRows: TableCell[][] = rows.map((row) =>
    row.map((cell, col) => ({
      content: parseMarkdownInline(cell, ids),
      ...(alignments[col] ? { alignment: alignments[col] } : {}),
    })),
  );
  // Keep unaligned columns as undefined holes so alignment stays indexed by
  // column (compacting would shift LaTeX export onto the wrong columns).
  return {
    id: ids.next("table"),
    type: "table",
    rows: tableRows,
    ...(alignments.some((a) => a) ? { columnAlignments: alignments } : {}),
  };
}

/** Parse a ScholarBridge-generated HTML table back into a TableNode. */
export function parseHtmlTable(html: string, ids: IdAllocator): TableNode | null {
  const captionMatch = /<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(html);
  const rows: TableCell[][] = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: TableCell[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(td|th)((?:\s+[^<>]*?)?)>([\s\S]*?)<\/\1>/gi)) {
      const attrs = cellMatch[2] ?? "";
      const inner = cellMatch[3].trim();
      const rowSpan = numAttr(attrs, "rowspan");
      const colSpan = numAttr(attrs, "colspan");
      const align = /align\s*=\s*["']?(left|center|right)/i.exec(attrs)?.[1] as
        | "left"
        | "center"
        | "right"
        | undefined;
      cells.push({
        content: parseMarkdownInline(htmlToMarkdownInline(inner), ids),
        ...(rowSpan && rowSpan > 1 ? { rowSpan } : {}),
        ...(colSpan && colSpan > 1 ? { colSpan } : {}),
        ...(align ? { alignment: align } : {}),
      });
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;
  return {
    id: ids.next("table"),
    type: "table",
    rows: resolveHtmlSpans(rows),
    ...(captionMatch ? { caption: stripTags(captionMatch[1]).trim() } : {}),
  };
}

function numAttr(attrs: string, name: string): number | undefined {
  const v = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attrs)?.[1];
  return v ? Number.parseInt(v, 10) : undefined;
}

/** Expand rowspan attributes into continuation placeholder cells. */
function resolveHtmlSpans(rows: TableCell[][]): TableCell[][] {
  const pending: number[] = [];
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
      if ((cell.rowSpan ?? 1) > 1) {
        pending[col] = (pending[col] ?? 0) + (cell.rowSpan as number) - 1;
      }
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

function htmlToMarkdownInline(html: string): string {
  return stripTags(
    html
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)"),
  );
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readHtmlComment(lines: string[], start: number): { body: string; next: number } {
  let body = lines[start];
  let i = start + 1;
  while (i < lines.length && !body.includes("-->")) {
    body += "\n" + lines[i];
    i++;
  }
  return { body, next: i };
}

// ---------------------------------------------------------------------------
// Metadata application
// ---------------------------------------------------------------------------

function applyMetaToPrevious(meta: ScholarBridgeMeta, blocks: ScholarBlockNode[]): boolean {
  for (let k = blocks.length - 1; k >= 0; k--) {
    const node = blocks[k];
    if (node.type === "translation-block") continue;
    if (meta.type !== node.type) return false;
    switch (node.type) {
      case "math":
        if (typeof meta.environment === "string") node.environment = meta.environment as never;
        if (typeof meta.label === "string" && !node.label) node.label = meta.label;
        return true;
      case "figure":
        if (typeof meta.caption === "string") node.caption = meta.caption;
        if (typeof meta.label === "string") node.label = meta.label;
        if (typeof meta.latexWidth === "string") node.latexWidth = meta.latexWidth;
        if (typeof meta.placement === "string") node.placement = meta.placement;
        return true;
      case "table":
        if (typeof meta.caption === "string") node.caption = meta.caption;
        if (typeof meta.label === "string") node.label = meta.label;
        if (typeof meta.columnSpec === "string") node.columnSpec = meta.columnSpec;
        if (meta.booktabs === true) node.booktabs = true;
        if (typeof meta.placement === "string") node.placement = meta.placement;
        return true;
      case "algorithm":
        if (typeof meta.caption === "string") node.caption = meta.caption;
        if (typeof meta.label === "string") node.label = meta.label;
        if (meta.backend === "algorithmic" || meta.backend === "algpseudocode") {
          node.backend = meta.backend;
        }
        return true;
      default:
        return false;
    }
  }
  return false;
}

/**
 * Plain-markdown rendering of a block, used to capture translated text.
 * Content-bearing node types must never render to "" — every block kind is
 * rendered recursively so nothing is silently destroyed.
 */
function blockToPlainLines(node: ScholarBlockNode): string {
  switch (node.type) {
    case "paragraph":
      return node.children.map(inlineToPlain).join("");
    case "heading":
      return `${"#".repeat(node.level)} ${node.children.map(inlineToPlain).join("")}`;
    case "list":
      return node.items
        .map((item, idx) => {
          const marker = node.ordered ? `${idx + (node.start ?? 1)}.` : "-";
          return blockToPlainLines(item)
            .split("\n")
            .map((l, j) => (j === 0 ? `${marker} ${l}` : `  ${l}`))
            .join("\n");
        })
        .join("\n");
    case "list-item":
      return node.children.map(blockToPlainLines).join("\n\n");
    case "quote":
      return node.children
        .map(blockToPlainLines)
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "code":
      return "```" + (node.language ?? "") + "\n" + node.code + "\n```";
    case "math":
      return `$$\n${node.latex}\n$$`;
    case "table":
      return node.rows
        .map(
          (row) =>
            `| ${row.map((cell) => cell.content.map(inlineToPlain).join("")).join(" | ")} |`,
        )
        .join("\n");
    case "figure":
      return `![[${node.path}]]`;
    case "algorithm":
      return (
        "```scholar-algorithm\n" +
        node.body.map((s) => "  ".repeat(s.indent) + s.text).join("\n") +
        "\n```"
      );
    case "thematic-break":
      return "---";
    case "raw-html":
    case "raw-latex":
      return node.raw;
    case "translation-block":
      return node.text;
  }
}

function inlineToPlain(node: ScholarInlineNode): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "inline-math":
      return node.display ? `$$${node.latex}$$` : `$${node.latex}$`;
    case "code-span":
      return `\`${node.code}\``;
    case "strong":
      return `**${node.children.map(inlineToPlain).join("")}**`;
    case "emph":
      return `*${node.children.map(inlineToPlain).join("")}*`;
    case "link":
      return node.kind === "wikilink"
        ? `[[${node.target}${node.alias ? "|" + node.alias : ""}]]`
        : `[${node.alias ?? node.target}](${node.target})`;
    case "citation":
      return node.raw;
    case "inline-raw":
      return node.raw;
    default:
      return "";
  }
}
