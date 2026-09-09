import type {
  ScholarBlockNode,
  ScholarDocument,
  ScholarInlineNode,
  TableNode,
} from "../../ir/nodes";

/**
 * Scholar IR → LaTeX (TECHNICAL_DESIGN.md §8).
 *
 * Fidelity rule §8.3: raw-latex/raw-html nodes are re-emitted verbatim unless
 * the user edited them (they only exist when source was preserved as-is).
 */

export type ExportProfile = "fragment" | "article" | "ctexart";

export function writeLatexFragment(doc: ScholarDocument): string {
  // Blocks own their interior whitespace (verbatim/lstlisting/raw bodies keep
  // blank runs); normalization happens only at block boundaries via the join.
  const parts = doc.children.map(writeBlock).filter((s) => s.length > 0);
  return parts.join("\n\n").trim() + "\n";
}

export function writeLatexArticle(doc: ScholarDocument, profile: "article" | "ctexart" = "article"): string {
  const packages = detectPackages(doc);
  const meta = doc.metadata as { title?: string; author?: string; documentClass?: string } | undefined;
  const lines: string[] = [];
  lines.push(`\\documentclass{${profile}}`);
  for (const pkg of packages) {
    lines.push(`\\usepackage{${pkg}}`);
  }
  if (meta?.title) lines.push(`\\title{${meta.title}}`);
  if (meta?.author) lines.push(`\\author{${meta.author}}`);
  lines.push("\\begin{document}");
  if (meta?.title) lines.push("\\maketitle");
  lines.push(writeLatexFragment(doc));
  lines.push("\\end{document}");
  return lines.join("\n") + "\n";
}

/** Package inference from IR content (TECHNICAL_DESIGN.md §8.2). */
export function detectPackages(doc: ScholarDocument): string[] {
  const packages = new Set<string>();
  const visit = (nodes: ScholarBlockNode[]) => {
    for (const node of nodes) {
      switch (node.type) {
        case "figure":
          packages.add("graphicx");
          break;
        case "table":
          if (node.booktabs) packages.add("booktabs");
          if (node.rows.some((r) => r.some((c) => (c.rowSpan ?? 1) > 1))) packages.add("multirow");
          break;
        case "algorithm":
          packages.add("algorithm");
          packages.add(node.backend === "algpseudocode" ? "algpseudocode" : "algorithmic");
          break;
        case "quote":
          visit(node.children);
          break;
        case "list":
          for (const item of node.items) visit(item.children);
          break;
        default:
          break;
      }
    }
  };
  visit(doc.children);
  // hyperref when URLs/links exist
  const needsHyperref = doc.children.some((n) => documentHasUrlLink(n));
  if (needsHyperref) packages.add("hyperref");
  return [...packages];
}

function documentHasUrlLink(node: ScholarBlockNode): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return node.children.some(inlineHasUrlLink);
    case "quote":
      return node.children.some(documentHasUrlLink);
    case "list":
      return node.items.some((item) => item.children.some(documentHasUrlLink));
    case "table":
      return node.rows.some((row) => row.some((cell) => cell.content.some(inlineHasUrlLink)));
    default:
      return false;
  }
}

function inlineHasUrlLink(node: ScholarInlineNode): boolean {
  if (node.type === "link") return node.kind === "url";
  if (node.type === "strong" || node.type === "emph") return node.children.some(inlineHasUrlLink);
  return false;
}

/** LaTeX sectioning commands, index 0 = heading level 1. */
const SECTION_COMMANDS = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"];

function writeBlock(node: ScholarBlockNode): string {
  switch (node.type) {
    case "heading": {
      // LaTeX offers five levels below \part, Markdown six heading levels:
      // H5 and H6 both become \subparagraph, so a latex→markdown round-trip
      // returns an H6 heading as H5 (documented in KNOWN_LIMITATIONS.md).
      const cmd = SECTION_COMMANDS[Math.min(node.level, SECTION_COMMANDS.length) - 1];
      return `\\${cmd}{${node.children.map(writeInline).join("")}}`;
    }
    case "paragraph":
      return node.children.map(writeInline).join("");
    case "list": {
      const env = node.ordered ? "enumerate" : "itemize";
      const items = node.items.map((item) => {
        const inner = item.children.map(writeBlock).join("\n\n");
        return `\\item ${inner}`;
      });
      return `\\begin{${env}}\n${items.join("\n")}\n\\end{${env}}`;
    }
    case "quote": {
      const inner = node.children.map(writeBlock).join("\n\n");
      return `\\begin{quote}\n${inner}\n\\end{quote}`;
    }
    case "code": {
      if (node.language) {
        return `\\begin{lstlisting}[language=${node.language}]\n${node.code}\n\\end{lstlisting}`;
      }
      return `\\begin{verbatim}\n${node.code}\n\\end{verbatim}`;
    }
    case "math": {
      if (!node.display) return `$${node.latex}$`;
      const label = node.label ? `\\label{${node.label}}` : "";
      if (node.environment) {
        return `\\begin{${node.environment}}\n${node.latex}\n${label}\n\\end{${node.environment}}`;
      }
      return `\\[\n${node.latex}\n${label}\n\\]`;
    }
    case "table":
      return writeTable(node);
    case "figure": {
      const width = node.latexWidth ?? displayWidthToLatex(node.width) ?? "0.8\\textwidth";
      const placement = node.placement ? `[${node.placement}]` : "[htbp]";
      const lines = [`\\begin{figure}${placement}`, "\\centering"];
      lines.push(`\\includegraphics[width=${width}]{${node.path}}`);
      if (node.caption) lines.push(`\\caption{${escapeLatexFreeText(node.caption)}}`);
      if (node.label) lines.push(`\\label{${node.label}}`);
      lines.push("\\end{figure}");
      return lines.join("\n");
    }
    case "algorithm": {
      const placement = node.placement ? `[${node.placement}]` : "[htbp]";
      const backend = node.backend === "algpseudocode" ? "algpseudocode" : "algorithmic";
      const body = node.body
        .map((s) => "  ".repeat(s.indent) + algorithmStatementToLatex(s.text, backend))
        .join("\n");
      const lines = [`\\begin{algorithm}${placement}`];
      if (node.caption) lines.push(`\\caption{${escapeLatexFreeText(node.caption)}}`);
      if (node.label) lines.push(`\\label{${node.label}}`);
      lines.push(`\\begin{${backend}}`);
      lines.push(body);
      lines.push(`\\end{${backend}}`);
      lines.push("\\end{algorithm}");
      return lines.join("\n");
    }
    case "raw-latex":
      return node.raw;
    case "raw-html":
      // HTML has no LaTeX meaning; keep the source visible as a comment.
      return node.raw
        .split("\n")
        .map((l) => `% (raw html) ${l}`)
        .join("\n");
    case "translation-block":
      // Stored translations are note artifacts, not export content.
      return "";
    default:
      return "";
  }
}

/** Prefix plain statements with \STATE so unknown algorithm text stays valid. */
function algorithmStatementToLatex(text: string, backend: string): string {
  if (text.startsWith("\\")) return text;
  const kw = backend === "algpseudocode" ? "\\State " : "\\STATE ";
  return kw + text;
}

function displayWidthToLatex(width: string | undefined): string | undefined {
  if (!width) return undefined;
  const pct = /^([0-9]*\.?[0-9]+)\s*%$/.exec(width);
  if (pct) return `${Number.parseFloat(pct[1]) / 100}\\textwidth`;
  return undefined;
}

function writeTable(table: TableNode): string {
  const columnCount = Math.max(...table.rows.map((r) => r.length), 1);
  const columnSpec =
    table.columnSpec ||
    Array.from({ length: columnCount }, (_, i) => {
      const a = table.columnAlignments?.[i] ?? table.rows[0]?.[i]?.alignment;
      return a === "center" ? "c" : a === "right" ? "r" : "l";
    }).join("");
  const placement = table.placement ? `[${table.placement}]` : "[htbp]";
  const lines: string[] = [`\\begin{table}${placement}`, "\\centering"];
  if (table.caption) lines.push(`\\caption{${escapeLatexFreeText(table.caption)}}`);
  if (table.label) lines.push(`\\label{${table.label}}`);
  lines.push(`\\begin{tabular}{${columnSpec}}`);
  if (table.booktabs) lines.push("\\toprule");
  else lines.push("\\hline");
  table.rows.forEach((row, rowIdx) => {
    const cells = row.map((cell) => {
      if (cell.rowSpanContinue) return "";
      const content = cell.content.map(writeInline).join("");
      let out = content;
      if ((cell.rowSpan ?? 1) > 1) out = `\\multirow{${cell.rowSpan}}{*}{${content}}`;
      if ((cell.colSpan ?? 1) > 1) {
        const align = cell.alignment === "center" ? "c" : cell.alignment === "right" ? "r" : "l";
        out = `\\multicolumn{${cell.colSpan}}{${align}}{${out}}`;
      }
      return out;
    });
    lines.push(cells.join(" & ") + " \\\\");
    if (table.booktabs && rowIdx === 0) lines.push("\\midrule");
    if (!table.booktabs && rowIdx === table.rows.length - 1) lines.push("\\hline");
  });
  if (table.booktabs) lines.push("\\bottomrule");
  lines.push("\\end{tabular}");
  lines.push("\\end{table}");
  return lines.join("\n");
}

function writeInline(node: ScholarInlineNode): string {
  switch (node.type) {
    case "text":
      return escapeLatexText(node.text);
    case "inline-math":
      // Display math keeps its flag: writing $$…$$ as $…$ would round-trip
      // as inline math and lose the semantics (CODE_REVIEW_R2 P1-3). The
      // LaTeX parser reads \[…\] back as a display math block.
      return node.display ? `\\[${node.latex}\\]` : `$${node.latex}$`;
    case "code-span":
      return `\\texttt{${escapeLatexText(node.code)}}`;
    case "strong":
      return `\\textbf{${node.children.map(writeInline).join("")}}`;
    case "emph":
      return `\\emph{${node.children.map(writeInline).join("")}}`;
    case "link":
      if (node.kind === "wikilink") {
        // Obsidian note links are not URLs; degrade to plain text (kept verbatim).
        return node.alias ?? node.target;
      }
      return `\\href{${node.target}}{${node.alias ?? node.target}}`;
    case "citation":
      return node.raw;
    case "inline-raw":
      return node.raw;
    default:
      return "";
  }
}

/** Escape plain text only; structured math/commands are separate nodes. */
const LATEX_TEXT_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  "$": "\\$",
  "#": "\\#",
  "_": "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Single pass: the backslash substitution inserts braces, so sequential
 * replace passes would re-escape either the backslash or its own output.
 */
export function escapeLatexText(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_TEXT_ESCAPES[ch]);
}

/**
 * Escapes for free-text fields: backslash commands and braces are left alone
 * (captions may intentionally use \textbf{…}), so only the characters that
 * would break compilation are substituted.
 */
const LATEX_FREE_TEXT_ESCAPES: Record<string, string> = {
  "&": "\\&",
  "%": "\\%",
  "$": "\\$",
  "#": "\\#",
  "_": "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Partial escaping for free-text fields that may legitimately contain LaTeX
 * (captions typed in Obsidian often hold $…$ math or \textbf{…}). Math spans
 * and existing backslash sequences pass through untouched; everything else
 * that would corrupt the document structure is escaped.
 */
export function escapeLatexFreeText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // Inline/display math: copy verbatim. Currency-safe — "$5" / "$ 3" is
    // prose, not the start of a math span.
    if (ch === "$" && !/[\s\d]/.test(text[i + 1] ?? "")) {
      const fence = text.startsWith("$$", i) ? "$$" : "$";
      const close = text.indexOf(fence, i + fence.length);
      if (close !== -1) {
        out += text.slice(i, close + fence.length);
        i = close + fence.length;
        continue;
      }
    }
    // Existing escape or command name: keep it intact so we neither
    // double-escape nor break \textbf{…}-style markup.
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += LATEX_FREE_TEXT_ESCAPES[ch] ?? ch;
    i++;
  }
  return out;
}
