import type {
  ScholarBlockNode,
  ScholarDocument,
  ScholarInlineNode,
  TableNode,
} from "../../ir/nodes";
import {
  encodeMetaComment,
  encodeTranslationEnd,
  encodeTranslationStart,
} from "../../ir/metadata";

/**
 * Scholar IR → Obsidian Markdown (TECHNICAL_DESIGN.md §6).
 *
 * - equations as $$…$$ with hidden metadata for LaTeX-specific fields;
 * - simple tables as GFM, tables with merged cells as HTML;
 * - figures as Obsidian embeds (width suffix) when metadata exists;
 * - algorithms as ```scholar-algorithm fenced blocks.
 */
export function writeMarkdown(doc: ScholarDocument): string {
  const parts: string[] = [];
  const meta = doc.metadata as { yaml?: string } | undefined;
  if (meta?.yaml) parts.push(`---\n${meta.yaml}\n---\n`);
  for (const node of doc.children) {
    parts.push(writeBlock(node));
  }
  return parts.join("\n\n").replace(/\n{3,}$/g, "\n") + "\n";
}

function writeBlock(node: ScholarBlockNode): string {
  switch (node.type) {
    case "heading":
      return `${"#".repeat(node.level)} ${node.children.map(writeInline).join("")}`;
    case "paragraph":
      return escapeLineStarts(node.children.map(writeInline).join(""));
    case "list": {
      const lines: string[] = [];
      let index = node.start ?? 1;
      for (const item of node.items) {
        const marker = node.ordered ? `${index++}.` : "-";
        const inner = item.children.map(writeBlock).join("\n\n");
        const indented = inner
          .split("\n")
          .map((l, idx) => (idx === 0 ? `${marker} ${l}` : `  ${l}`))
          .join("\n");
        lines.push(indented);
      }
      return lines.join(node.loose ? "\n\n" : "\n");
    }
    case "quote":
      return node.children
        .map(writeBlock)
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "code": {
      const fence = codeFence(node.code);
      return fence + (node.language ?? "") + "\n" + node.code + "\n" + fence;
    }
    case "math": {
      if (!node.display) return `$${node.latex}$`;
      const body = `$$\n${node.latex}\n$$`;
      const extra: Record<string, unknown> = { type: "math" };
      if (node.environment) extra.environment = node.environment;
      if (node.label) extra.label = node.label;
      const needsMeta = Boolean(node.environment || node.label);
      return needsMeta ? `${body}\n\n${encodeMetaComment(extra)}` : body;
    }
    case "table":
      return hasSpans(node) ? writeHtmlTable(node) : writeGfmTable(node);
    case "figure": {
      const widthSuffix = node.width ? `|${node.width}` : "";
      const hasLatexMeta = Boolean(node.caption || node.label || node.latexWidth || node.placement);
      if (hasLatexMeta) {
        const extra: Record<string, unknown> = { type: "figure" };
        if (node.caption) extra.caption = node.caption;
        if (node.label) extra.label = node.label;
        if (node.latexWidth) extra.latexWidth = node.latexWidth;
        if (node.placement) extra.placement = node.placement;
        return `![[${node.path}${widthSuffix}]]\n\n${encodeMetaComment(extra)}`;
      }
      if (node.width) return `![[${node.path}${widthSuffix}]]`;
      return `![](${node.path})`;
    }
    case "algorithm": {
      const fence = "```scholar-algorithm";
      const body = node.body.map((s) => "  ".repeat(s.indent) + s.text).join("\n");
      let out = `${fence}\n${body}\n\`\`\``;
      const extra: Record<string, unknown> = { type: "algorithm" };
      if (node.caption) extra.caption = node.caption;
      if (node.label) extra.label = node.label;
      if (node.backend) extra.backend = node.backend;
      if (node.caption || node.label || node.backend) out += `\n\n${encodeMetaComment(extra)}`;
      return out;
    }
    case "raw-latex": {
      // Preserve unsupported LaTeX as a raw block that Markdown will not touch.
      const fence = codeFence(node.raw);
      return fence + "latex\n" + node.raw + "\n" + fence;
    }
    case "raw-html":
      return node.raw;
    case "translation-block":
      return `${encodeTranslationStart(node.meta)}\n${node.text}\n${encodeTranslationEnd()}`;
    case "thematic-break":
      return "---";
    default:
      return "";
  }
}

function writeInline(node: ScholarInlineNode): string {
  switch (node.type) {
    case "text":
      return escapeMarkdown(node.text);
    case "inline-math":
      return node.display ? `$$${node.latex}$$` : `$${node.latex}$`;
    case "code-span":
      return node.code.includes("`") ? "`` " + node.code + " ``" : `\`${node.code}\``;
    case "strong":
      return `**${node.children.map(writeInline).join("")}**`;
    case "emph":
      return `*${node.children.map(writeInline).join("")}*`;
    case "link": {
      if (node.kind === "wikilink") {
        return `[[${node.target}${node.alias ? "|" + node.alias : ""}]]`;
      }
      const titleSuffix = node.title !== undefined ? ` "${node.title}"` : "";
      return `[${node.alias ?? node.target}](${node.target}${titleSuffix})`;
    }
    case "citation":
      return node.raw;
    case "inline-raw":
      return node.raw;
    default:
      return "";
  }
}

/**
 * Escape characters that would otherwise parse as Markdown markup.
 * Markdown-origin text already escaped here round-trips unchanged
 * (the inline parser unescapes).
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_\[\]$])/g, "\\$1");
}

/**
 * A line may not START with a character that would re-parse as a block
 * marker (blockquote `>`, heading `#`, bullet `-`/`+`/`*`, ordered `1.`) or
 * md→md round-trips corrupt paragraph structure (CODE_REVIEW_R2 P2-2).
 * Applied per output line; mid-line occurrences are not block markers.
 * The inline parser unescapes every character produced here.
 */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // `>` and `#` are block markers with NO trailing-space requirement
      // (">100" is a blockquote), so they escape unconditionally at line
      // start; bullets and ordered markers need a following space.
      if (/^[>#]/.test(line)) return `\\${line}`;
      const ordered = /^(\d{1,9}[.)])\s/.exec(line);
      if (ordered) {
        const marker = ordered[1];
        return `${marker.slice(0, -1)}\\${marker.slice(-1)}${line.slice(marker.length)}`;
      }
      if (/^[-+*]\s/.test(line)) return `\\${line}`;
      return line;
    })
    .join("\n");
}

/** CommonMark: the fence must be longer than any backtick run in the body. */
function codeFence(code: string): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Escape cell pipes for GFM (the parser unescapes `\|` on read-back). */
function escapePipe(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function hasSpans(table: TableNode): boolean {
  return table.rows.some((row) =>
    row.some((cell) => (cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1),
  );
}

function writeGfmTable(table: TableNode): string {
  const alignOf = (col: number): "left" | "center" | "right" | undefined => {
    const fromCell = table.rows[0]?.[col]?.alignment;
    if (fromCell) return fromCell;
    return table.columnAlignments?.[col];
  };
  const rowToLine = (row: typeof table.rows[number]): string => {
    // Literal pipes (e.g. math `$a|b$`) must be escaped or the pipe table
    // breaks apart on re-parse and in rendering.
    const cells = row.map((cell) => escapePipe(cell.content.map(writeInline).join("")));
    return `| ${cells.join(" | ")} |`;
  };
  const header = table.rows[0] ?? [];
  const alignLine =
    "| " +
    header.map((_, col) => {
      const a = alignOf(col);
      if (a === "center") return ":---:";
      if (a === "right") return "---:";
      if (a === "left") return ":---";
      return "---";
    }).join(" | ") +
    " |";
  const lines = [rowToLine(header), alignLine];
  for (const row of table.rows.slice(1)) lines.push(rowToLine(row));
  const extras: string[] = [];
  if (table.caption || table.label || table.booktabs || table.columnSpec || table.placement) {
    const extra: Record<string, unknown> = { type: "table" };
    if (table.caption) extra.caption = table.caption;
    if (table.label) extra.label = table.label;
    if (table.booktabs) extra.booktabs = true;
    if (table.columnSpec) extra.columnSpec = table.columnSpec;
    if (table.placement) extra.placement = table.placement;
    extras.push(encodeMetaComment(extra));
  }
  return [...lines, ...extras].join("\n");
}

function writeHtmlTable(table: TableNode): string {
  const alignAttr = (a: string | undefined) => (a ? ` align="${a}"` : "");
  const lines: string[] = ["<table>"];
  if (table.caption) lines.push(`  <caption>${escapeHtml(table.caption)}</caption>`);
  for (const row of table.rows) {
    const cells = row
      .filter((cell) => !cell.rowSpanContinue)
      .map((cell) => {
        const tag = "td";
        const attrs: string[] = [];
        if ((cell.rowSpan ?? 1) > 1) attrs.push(`rowspan="${cell.rowSpan}"`);
        if ((cell.colSpan ?? 1) > 1) attrs.push(`colspan="${cell.colSpan}"`);
        if (cell.alignment) attrs.push(`align="${cell.alignment}"`);
        const inline = escapeHtml(cell.content.map(writeInline).join(""));
        return `    <${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${inline}</${tag}>`;
      });
    lines.push(`  <tr>${cells.join("")}</tr>`);
  }
  lines.push("</table>");
  const extras: string[] = [];
  if (table.label || table.booktabs || table.columnSpec || table.placement) {
    const extra: Record<string, unknown> = { type: "table" };
    if (table.caption) extra.caption = table.caption;
    if (table.label) extra.label = table.label;
    if (table.booktabs) extra.booktabs = true;
    if (table.columnSpec) extra.columnSpec = table.columnSpec;
    if (table.placement) extra.placement = table.placement;
    extras.push(encodeMetaComment(extra));
  }
  return [...lines, ...extras].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
