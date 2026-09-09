import { TFile, TFolder, type App, type TFile as TFileType } from "obsidian";
import { parseMarkdown } from "../core/parser/markdown/markdown-parser";
import {
  writeLatexArticle,
  writeLatexFragment,
  type ExportProfile,
} from "../core/writer/latex/latex-writer";

/**
 * Note → .tex export (PRODUCT_REQUIREMENTS.md FR-3, TECHNICAL_DESIGN.md §8).
 * Folder/project export is deferred beyond v0.1 by plan (§6 of the plan).
 */
export async function exportNoteToLatex(
  app: App,
  file: TFileType,
  profile: ExportProfile,
  opts: { overwrite?: boolean } = {},
): Promise<string> {
  const markdown = await app.vault.read(file as TFile);
  const doc = parseMarkdown(markdown);
  const latex =
    profile === "fragment"
      ? writeLatexFragment(doc)
      : writeLatexArticle(doc, profile === "ctexart" ? "ctexart" : "article");

  const texPath = latexExportPath(file);
  const existing = app.vault.getAbstractFileByPath(texPath);
  if (existing instanceof TFolder) {
    // vault.create() would fail with an opaque error; say what is wrong.
    throw new Error(`a folder already occupies “${texPath}” — rename it or the note first`);
  }
  if (existing instanceof TFile) {
    // Never clobber an existing export without an explicit decision: the
    // caller asks the user and passes overwrite back in.
    if (!opts.overwrite) throw new Error(`${texPath} already exists`);
    await app.vault.modify(existing, latex);
    return texPath;
  }
  await app.vault.create(texPath, latex);
  return texPath;
}

/** Destination path for a note's LaTeX export. */
export function latexExportPath(file: TFileType): string {
  return `${file.path.replace(/\.md$/, "")}.tex`;
}
