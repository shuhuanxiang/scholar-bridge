import type { ScholarDocument } from "../ir/nodes";
import { parseLatex } from "./latex/latex-parser";
import { parseMarkdown } from "./markdown/markdown-parser";

export type DocumentFormat = "markdown" | "latex";

/** Parse a source document into the shared Scholar IR. */
export function parseDocument(input: string, format: DocumentFormat): ScholarDocument {
  return format === "latex" ? parseLatex(input) : parseMarkdown(input);
}

export { parseLatex, parseMarkdown };
