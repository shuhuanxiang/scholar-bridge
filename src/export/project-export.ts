import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { parseMarkdown } from "../core/parser/markdown/markdown-parser";
import { writeLatexFragment, detectPackages } from "../core/writer/latex/latex-writer";
import {
  buildMainTex,
  planProjectExport,
  sectionBasenames,
  type ProjectExportPlan,
} from "./project-export-plan";

/**
 * Folder/project → LaTeX export (PRODUCT_REQUIREMENTS.md FR-3,
 * IMPLEMENTATION_PLAN.md M11):
 *
 *   paper/
 *   ├── abstract.md
 *   └── introduction.md
 *
 * becomes
 *
 *   paper/latex/
 *   ├── main.tex          (preamble + \input of every section)
 *   └── sections/
 *       ├── abstract.tex
 *       └── introduction.tex
 *
 * Markdown notes are exported as fragments; the preamble carries the union of
 * the package detection over all notes (TECHNICAL_DESIGN.md §8.2). Pure
 * planning logic lives in ./project-export-plan (unit-testable).
 */

/**
 * Export every .md file in `folder` to `latex/sections/*.tex` plus a
 * `latex/main.tex`. Throws with a descriptive message when the folder holds
 * no notes or when an existing export must be confirmed first (the caller
 * asks the user and retries with `overwrite: true`).
 */
export async function exportFolderToLatex(
  app: App,
  folder: TFolder,
  profile: "article" | "ctexart",
  opts: { overwrite?: boolean } = {},
): Promise<ProjectExportPlan> {
  const mdFiles = folder.children
    .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (mdFiles.length === 0) {
    throw new Error(`no Markdown notes in “${folder.path}”`);
  }

  const basenames = sectionBasenames(mdFiles);
  const plan = planProjectExport(folder.path, basenames);

  const existing: string[] = [plan.mainTex, ...plan.sectionFiles].filter(
    (p) => app.vault.getAbstractFileByPath(p) instanceof TFile,
  );
  if (existing.length > 0 && !opts.overwrite) {
    throw new Error(`overwrite confirmation required: ${existing.join(", ")}`);
  }

  await ensureFolder(app, plan.outDir);
  await ensureFolder(app, plan.sectionsDir);

  const packages = new Set<string>();
  for (let i = 0; i < mdFiles.length; i++) {
    const doc = parseMarkdown(await app.vault.read(mdFiles[i]));
    for (const pkg of detectPackages(doc)) packages.add(pkg);
    const tex = writeLatexFragment(doc);
    await writeFile(app, normalizePath(plan.sectionFiles[i]), tex);
  }
  await writeFile(app, normalizePath(plan.mainTex), buildMainTex(profile, [...packages], basenames));

  return plan;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(path)) return;
  await app.vault.createFolder(path);
}

async function writeFile(app: App, path: string, content: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
  } else {
    await app.vault.create(path, content);
  }
}
