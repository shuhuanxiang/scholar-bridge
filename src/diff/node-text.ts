import type { ScholarBlockNode, ScholarInlineNode } from "../core/ir/nodes";
import type { DiffOptions } from "./structural-diff";

/**
 * Comparable plain text for inline runs. Wrappers (strong/emph) are transparent
 * when `ignoreWrappers` is on; citations can be excluded from comparison.
 */
export function inlineToComparable(
  nodes: ScholarInlineNode[],
  opts: DiffOptions,
): string {
  return nodes.map((n) => inlineNodeText(n, opts)).join("");
}

function inlineNodeText(node: ScholarInlineNode, opts: DiffOptions): string {
  switch (node.type) {
    case "text":
      return node.text;
    case "inline-math":
      return `$${node.latex}$`;
    case "code-span":
      return opts.ignoreWrappers ? node.code : `\`${node.code}\``;
    case "strong":
      return opts.ignoreWrappers
        ? inlineToComparable(node.children, opts)
        : `**${inlineToComparable(node.children, opts)}**`;
    case "emph":
      return opts.ignoreWrappers
        ? inlineToComparable(node.children, opts)
        : `*${inlineToComparable(node.children, opts)}*`;
    case "link":
      // The target must always take part in comparisons: retargeting a link
      // without touching the alias is a real change even when wrappers are
      // ignored. (Title is metadata and stays out.)
      return opts.ignoreWrappers
        ? `${node.alias ?? ""}(${node.target})`
        : `[${node.alias ?? node.target}](${node.target})`;
    case "citation":
      return opts.ignoreCitations ? "" : node.raw;
    case "inline-raw":
      return opts.ignoreCitations && /\\cite/.test(node.raw) ? "" : node.raw;
    default:
      return "";
  }
}

/** Normalize whitespace for comparison keys. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Block-level comparable text used for alignment signatures and text diff. */
export function blockComparableText(node: ScholarBlockNode, opts: DiffOptions): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
      return inlineToComparable(node.children, opts);
    case "math":
      return node.latex;
    case "code":
      return node.code;
    case "list":
      return node.items.map((item) => item.children.map((c) => blockComparableText(c, opts)).join(" ")).join(" ");
    case "quote":
      return node.children.map((c) => blockComparableText(c, opts)).join(" ");
    case "table":
      return node.rows
        .map((row) => row.filter((c) => !c.rowSpanContinue).map((c) => inlineToComparable(c.content, opts)).join("|"))
        .join("\n");
    case "figure":
      return node.path;
    case "algorithm":
      return node.body.map((s) => s.text).join("\n");
    case "translation-block":
      return node.text;
    case "raw-latex":
    case "raw-html":
      return node.raw;
    case "thematic-break":
      return "";
    default:
      return "";
  }
}
