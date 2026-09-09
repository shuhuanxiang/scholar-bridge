/**
 * Scholar IR — the shared intermediate representation (TECHNICAL_DESIGN.md §3).
 *
 * Every consumer (Markdown/LaTeX writers, semantic diff, translation engine)
 * operates on these nodes; no pairwise converters exist (README.md §2).
 *
 * Design rules:
 * - every node carries a deterministic id (assigned in document order);
 * - unknown input MUST end up in a RawLatexNode / RawHtmlNode, never dropped
 *   ("never discard content", TECHNICAL_DESIGN.md §3.8).
 */

export interface SourceLocation {
  format: "markdown" | "latex";
  start?: number;
  end?: number;
  raw?: string;
}

export interface BaseNode {
  id: string;
  type: string;
  source?: SourceLocation;
}

// ---------------------------------------------------------------------------
// Inline nodes
// ---------------------------------------------------------------------------

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
}

export interface InlineMathNode extends BaseNode {
  type: "inline-math";
  latex: string;
  /** True when the source used $$…$$ inline; Markdown writer keeps the form. */
  display?: boolean;
}

export interface CodeSpanNode extends BaseNode {
  type: "code-span";
  code: string;
}

/**
 * Unrecognized inline LaTeX command (e.g. `\newcommand{x}{y}` mid-text).
 * Emitted verbatim by the LaTeX writer; kept as literal text elsewhere.
 */
export interface InlineRawNode extends BaseNode {
  type: "inline-raw";
  raw: string;
}

export interface StrongNode extends BaseNode {
  type: "strong";
  children: ScholarInlineNode[];
}

export interface EmphNode extends BaseNode {
  type: "emph";
  children: ScholarInlineNode[];
}

export type LinkKind = "url" | "wikilink";

export interface LinkNode extends BaseNode {
  type: "link";
  kind: LinkKind;
  /** URL for kind "url", target note/path for kind "wikilink". */
  target: string;
  alias?: string;
  /** Optional `"title"` after the target in `[alias](target "title")`. */
  title?: string;
}

export interface CitationNode extends BaseNode {
  type: "citation";
  /** Original command, e.g. `\citep{a,b}` — preserved verbatim. */
  raw: string;
  keys: string[];
}

export type ScholarInlineNode =
  | TextNode
  | InlineMathNode
  | CodeSpanNode
  | InlineRawNode
  | StrongNode
  | EmphNode
  | LinkNode
  | CitationNode;

// ---------------------------------------------------------------------------
// Block nodes
// ---------------------------------------------------------------------------

export interface HeadingNode extends BaseNode {
  type: "heading";
  level: number; // 1..6
  children: ScholarInlineNode[];
}

export interface ParagraphNode extends BaseNode {
  type: "paragraph";
  children: ScholarInlineNode[];
}

export interface ListItemNode extends BaseNode {
  type: "list-item";
  children: ScholarBlockNode[]; // blocks; usually one paragraph
}

export interface ListNode extends BaseNode {
  type: "list";
  ordered: boolean;
  start?: number;
  /** Loose list: blank lines separate items; writers must keep them. */
  loose?: boolean;
  items: ListItemNode[];
}

export interface QuoteNode extends BaseNode {
  type: "quote";
  children: ScholarBlockNode[];
}

export interface CodeNode extends BaseNode {
  type: "code";
  language?: string;
  code: string;
}

export type MathEnvironment =
  | "equation"
  | "equation*"
  | "align"
  | "align*"
  | "gather"
  | "gather*"
  | "multline"
  | "multline*"
  | "displaymath";

export interface MathNode extends BaseNode {
  type: "math";
  display: boolean;
  environment?: MathEnvironment;
  /** LaTeX body without the surrounding environment/\\[ \\] delimiters. */
  latex: string;
  label?: string;
}

export interface TableCell {
  content: ScholarInlineNode[];
  rowSpan?: number;
  colSpan?: number;
  alignment?: "left" | "center" | "right";
  /** True for the shadow cells of a rowSpan started in an earlier row. */
  rowSpanContinue?: boolean;
}

export interface TableNode extends BaseNode {
  type: "table";
  caption?: string;
  label?: string;
  placement?: string;
  columnSpec?: string;
  booktabs?: boolean;
  /**
   * Per-column alignment, indexed by column. `undefined` (hole) marks an
   * unaligned column — positions must be preserved for LaTeX export.
   */
  columnAlignments?: ("left" | "center" | "right" | undefined)[];
  rows: TableCell[][];
}

export interface FigureNode extends BaseNode {
  type: "figure";
  path: string;
  caption?: string;
  label?: string;
  /** Display width in the note, e.g. "45%". */
  width?: string;
  /** Exact LaTeX width expression, e.g. "0.45\textwidth" (round-trip). */
  latexWidth?: string;
  placement?: string;
}

export interface AlgorithmStatement {
  text: string;
  /** Nesting depth (0-based). */
  indent: number;
}

export interface AlgorithmNode extends BaseNode {
  type: "algorithm";
  caption?: string;
  label?: string;
  backend?: "algorithmic" | "algpseudocode" | "unknown";
  body: AlgorithmStatement[];
  placement?: string;
}

export interface RawLatexNode extends BaseNode {
  type: "raw-latex";
  raw: string;
  reason?: string;
}

/** Unrecognized HTML block (e.g. a hand-written table or stray comment). */
export interface RawHtmlNode extends BaseNode {
  type: "raw-html";
  raw: string;
  reason?: string;
}

/**
 * A stored translation re-inserted into the note
 * (TECHNICAL_DESIGN.md §13–§14): hidden metadata + translated text.
 */
export interface TranslationBlockNode extends BaseNode {
  type: "translation-block";
  meta: import("./metadata").TranslationMeta;
  text: string;
}

/** Horizontal rule (`---`, `***`, `___`). */
export interface ThematicBreakNode extends BaseNode {
  type: "thematic-break";
}

export type ScholarBlockNode =
  | HeadingNode
  | ParagraphNode
  | ListItemNode
  | ListNode
  | QuoteNode
  | CodeNode
  | MathNode
  | TableNode
  | FigureNode
  | AlgorithmNode
  | RawLatexNode
  | RawHtmlNode
  | TranslationBlockNode
  | ThematicBreakNode;

export type ScholarNode = ScholarBlockNode | ScholarInlineNode;

export interface ScholarDocument {
  type: "document";
  children: ScholarBlockNode[];
  /** Preamble info (LaTeX source): documentclass, packages, title/author. */
  metadata?: Record<string, unknown>;
}
