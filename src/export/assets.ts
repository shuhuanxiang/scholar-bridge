import { posix } from "node:path";
import { normalizePath, type App, type TFile } from "obsidian";
import { walkNodes } from "../core/ir/document";
import type { ScholarDocument } from "../core/ir/nodes";
import { prepareLatexDocument } from "../core/writer/latex/latex-writer";

/** TeX resolves image names from the main document's working directory. */
export function prepareExportAssets(
  app: App,
  doc: ScholarDocument,
  source: TFile,
  outputDirectory: string,
): ScholarDocument {
  const prepared = prepareLatexDocument(doc);
  for (const node of walkNodes(prepared)) {
    if (node.type !== "figure" || /^[a-z][a-z0-9+.-]*:/i.test(node.path)) continue;
    const resolved = app.metadataCache?.getFirstLinkpathDest(node.path, source.path);
    const sourceDirectory = posix.dirname(source.path);
    const target = resolved?.path ?? posix.normalize(posix.join(sourceDirectory, node.path));
    node.path = normalizePath(posix.relative(outputDirectory || ".", target));
  }
  return prepared;
}
