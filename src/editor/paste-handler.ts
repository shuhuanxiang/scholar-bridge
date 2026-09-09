import { parseLatex } from "../core/parser/latex/latex-parser";
import { writeMarkdown } from "../core/writer/markdown/markdown-writer";

/**
 * Paste detection + conversion (PRODUCT_REQUIREMENTS.md FR-1).
 *
 * Safety rule (§5): when parsing confidence is low — nothing recognized at
 * all — the source text is kept untouched rather than rewritten.
 */

const ENVIRONMENT_TRIGGER =
  /\\begin\{(equation|equation\*|align|align\*|gather|multline|displaymath|table|figure|algorithm|tabular)\}/;

/** Heuristic: does this pasted text look like LaTeX worth converting? */
export function looksLikeLatex(text: string): boolean {
  if (text.length > 100_000) return false;
  if (ENVIRONMENT_TRIGGER.test(text)) return true;
  const commands = text.match(/\\[A-Za-z]+/g)?.length ?? 0;
  return commands >= 5;
}

/**
 * Convert a LaTeX fragment to Obsidian-friendly Markdown.
 * Returns null when nothing was recognized (caller must keep the source).
 */
export function convertLatexFragment(text: string): string | null {
  const doc = parseLatex(text);
  const recognized = doc.children.some((c) => c.type !== "raw-latex");
  if (!recognized) return null;
  return writeMarkdown(doc);
}
