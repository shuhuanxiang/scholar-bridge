import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { parseMarkdown } from "../core/parser/markdown/markdown-parser";
import { prepareExportAssets } from "./assets";
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

  const packages = new Set<string>();
  const outputs: { path: string; content: string }[] = [];
  let original: { preamble: string; packages: string[] } | undefined;
  for (let i = 0; i < mdFiles.length; i++) {
    const doc = prepareExportAssets(app, parseMarkdown(await app.vault.read(mdFiles[i])), mdFiles[i], plan.outDir);
    if (doc.metadata?.preambleConflict) throw new Error(`conflicting LaTeX preambles in ${mdFiles[i].path}`);
    if (typeof doc.metadata?.latexPreamble === "string") {
      if (original && original.preamble !== doc.metadata.latexPreamble) {
        throw new Error("project notes have different LaTeX preambles; export them separately or use one shared preamble");
      }
      original = {
        preamble: doc.metadata.latexPreamble,
        packages: Array.isArray(doc.metadata.packages) ? doc.metadata.packages.filter((pkg): pkg is string => typeof pkg === "string") : [],
      };
    }
    for (const pkg of detectPackages(doc)) packages.add(pkg);
    const tex = writeLatexFragment(doc);
    outputs.push({ path: normalizePath(plan.sectionFiles[i]), content: tex });
  }
  outputs.push({
    path: normalizePath(plan.mainTex),
    content: buildMainTex(profile, [...packages], basenames, original, mdFiles.map((file) => file.path)),
  });
  for (const output of outputs) {
    if (app.vault.getAbstractFileByPath(output.path) instanceof TFolder) {
      throw new Error(`a folder already occupies the output path: ${output.path}`);
    }
  }
  await ensureFolder(app, plan.outDir);
  await ensureFolder(app, plan.sectionsDir);
  for (const output of outputs) await writeFile(app, output.path, output.content);

  return plan;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  if (existing) throw new Error(`a file already occupies the output folder: ${path}`);
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
