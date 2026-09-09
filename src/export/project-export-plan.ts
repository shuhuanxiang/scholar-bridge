/**
 * Pure planning helpers for the folder/project → LaTeX export
 * (PRODUCT_REQUIREMENTS.md FR-3, IMPLEMENTATION_PLAN.md M11).
 *
 * Kept free of Obsidian imports so unit tests can run them directly; the
 * vault-facing wrapper lives in ./project-export.
 */

export interface ProjectExportPlan {
  /** Vault path of the latex output folder. */
  outDir: string;
  sectionsDir: string;
  mainTex: string;
  /** section file paths, aligned with the input md order. */
  sectionFiles: string[];
}

/** Minimal stand-in for Obsidian's normalizePath (vault-safe separators). */
export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

/** Pure path/layout planning (unit-tested without Obsidian). */
export function planProjectExport(folderPath: string, mdBasenames: string[]): ProjectExportPlan {
  const outDir = normalizeVaultPath(`${folderPath}/latex`);
  const sectionsDir = normalizeVaultPath(`${outDir}/sections`);
  return {
    outDir,
    sectionsDir,
    mainTex: normalizeVaultPath(`${outDir}/main.tex`),
    sectionFiles: mdBasenames.map((base) => normalizeVaultPath(`${sectionsDir}/${base}.tex`)),
  };
}

/** Pure main.tex builder (unit-tested without Obsidian). */
export function buildMainTex(
  profile: "article" | "ctexart",
  packages: string[],
  sectionNames: string[],
): string {
  const lines: string[] = [`\\documentclass{${profile}}`];
  for (const pkg of packages) lines.push(`\\usepackage{${pkg}}`);
  lines.push("\\begin{document}");
  for (const name of sectionNames) lines.push(`\\input{${latexInputName(name)}}`);
  lines.push("\\end{document}");
  return lines.join("\n") + "\n";
}

/**
 * \input argument for a section name (R3 P3-1): plain printable-ASCII names
 * go bare, but note titles with spaces ("Translation Demo") or non-ASCII
 * characters ("未命名") are quoted — `\input{"sections/a b"}` is the form
 * LaTeX (2019-10-01+) documents for such filenames; unquoted, old
 * distributions would cut the name at the space. Quoting simple names too
 * would only break pre-2019 engines that handle them fine, so it is
 * conditional.
 */
export function latexInputName(name: string): string {
  const rel = `sections/${name}`;
  return /^[\x21-\x7e]+$/.test(rel) ? rel : `"${rel}"`;
}

/**
 * Section file names derive from note basenames; duplicates would clobber
 * each other, so they get a numeric suffix in file order. Invalid filename
 * characters become dashes.
 */
export function sectionBasenames(files: { basename: string }[]): string[] {
  const used = new Map<string, number>();
  return files.map((file) => {
    const base = file.basename.replace(/[\\/:*?"<>|]/g, "-") || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}
