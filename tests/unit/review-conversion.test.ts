import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLatex, parseMarkdown } from "../../src/core/parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import { writeLatexArticle, writeLatexFragment } from "../../src/core/writer/latex/latex-writer";
import { parseColumnSpec } from "../../src/core/parser/latex/latex-parser";
import { diffDocuments } from "../../src/diff/structural-diff";
import { applyAcceptedChanges } from "../../src/diff/diff-apply";
import { buildMainTex, latexInputName, planProjectExport, sectionBasenames } from "../../src/export/project-export-plan";

const roundTrip = (source: string) => writeLatexFragment(parseMarkdown(writeMarkdown(parseLatex(source))));
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "../fixtures/latex", name), "utf8");

describe("review: safe differences and unchanged regions", () => {
  it("refuses a stale snapshot instead of editing another identical paragraph", () => {
    const diff = diffDocuments("Alpha.\n\nAlpha.", "Changed.\n\nAlpha.");
    const current = "Hand edited.\n\nAlpha.";
    const result = applyAcceptedChanges(current, diff.blocks, new Set([0]));
    expect(result.text).toBe(current);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((item) => item.index)).toEqual([0]);
  });

  it("refuses accepted additions when their source snapshot changed", () => {
    const diff = diffDocuments("Anchor.", "Anchor.\n\nAdded.");
    const accepted = new Set(diff.blocks.flatMap((block, index) => block.status === "added" ? [index] : []));
    const result = applyAcceptedChanges("Newer anchor.", diff.blocks, accepted);
    expect(result.text).toBe("Newer anchor.");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("skips an addition when its neighboring block cannot be safely located", () => {
    const old = Array.from({ length: 2001 }, (_, i) => `Line ${i}.`).join("\n");
    const diff = diffDocuments(old, `Added.\n\n${old}`);
    const accepted = new Set(diff.blocks.flatMap((block, index) => block.status === "added" ? [index] : []));
    const result = applyAcceptedChanges(old, diff.blocks, accepted);
    expect(result.text).toBe(old);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("uses source positions when canonical formatting would match another block", () => {
    const old = "_Alpha_\n\n*Alpha*";
    const diff = diffDocuments(old, "_Changed_\n\n*Alpha*", "markdown", { ignoreWrappers: false });
    const result = applyAcceptedChanges(old, diff.blocks, new Set([0]));
    expect(result.text).toBe("_Changed_\n\n*Alpha*");
    expect(result.skipped).toEqual([]);
  });

  it("keeps every rejected region and trailing blank line byte-identical", () => {
    const old = "  First.  \n\n_second_ paragraph.\n\n\n";
    const diff = diffDocuments(old, "Changed.\n\n*second* paragraph.\n\nRejected addition.");
    const changed = diff.blocks.findIndex((block) => block.status === "changed");
    expect(applyAcceptedChanges(old, diff.blocks, new Set([changed])).text)
      .toBe("Changed.\n\n_second_ paragraph.\n\n\n");
  });

  it("applies exact block positions while retaining Windows line endings", () => {
    const old = "First.\r\n\r\n_second_ paragraph.\r\n\r\n";
    const next = "Changed.\r\n\r\n*second* paragraph.\r\n\r\n";
    const result = applyAcceptedChanges(old, diffDocuments(old, next).blocks, new Set([0]));
    expect(result.applied).toEqual([0]);
    expect(result.skipped).toEqual([]);
    expect(result.text).toBe("Changed.\r\n\r\n_second_ paragraph.\r\n\r\n");
  });

  it("still rejects changes to line endings after the snapshot was captured", () => {
    const old = "First.\r\n\r\nSecond.";
    const current = old.replace(/\r\n/g, "\n");
    const result = applyAcceptedChanges(current, diffDocuments(old, "Changed.").blocks, new Set([0]));
    expect(result.text).toBe(current);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("replaces attached metadata exactly once using its complete source range", () => {
    const comment = '<!-- scholarbridge\n{"schemaVersion":1,"type":"math","environment":"equation","label":"eq:old"}\n-->';
    const old = `$$x$$\n\n${comment}`;
    const next = `$$y$$\n\n${comment.replace("eq:old", "eq:new")}`;
    const result = applyAcceptedChanges(old, diffDocuments(old, next).blocks, new Set([0]));
    expect(result.text).toBe(next);
    expect(result.text.match(/<!-- scholarbridge/g)).toHaveLength(1);
  });

  it.each([
    ["- A", "1. A"],
    ["1. A", "3. A"],
    ["```js\nx\n```", "```py\nx\n```"],
    ["| A |\n| :--- |\n| X |", "| A |\n| ---: |\n| X |"],
    ["![[x.png|100]]", "![[x.png|200]]"],
    ["- A\n  - B", "- A\n- B"],
  ])("detects structural changes: %s", (old, next) => {
    const diff = diffDocuments(old, next, "markdown", { ignoreWrappers: false });
    expect(diff.stats.changed + diff.stats.added + diff.stats.removed).toBeGreaterThan(0);
  });
});

describe("review: bounded and lossless conversion", () => {
  it.each([
    "*{1000000000}{}",
    `*{${"9".repeat(400)}}{c}`,
    "*{256}{*{256}{c}}",
    `${"*{1}{".repeat(25)}c${"}".repeat(25)}`,
    "*{-1}{c}",
  ])("preserves specifications exceeding the parsing budget: %s", (spec) => {
    const source = `\\begin{tabular}{${spec}}A \\\\ \\end{tabular}`;
    expect(parseLatex(source).children[0].type).toBe("raw-latex");
    expect(roundTrip(source).trim()).toBe(source);
  });

  it("still expands ordinary nested column specifications", () => {
    expect(parseColumnSpec("*{2}{lc}r")).toEqual(["left", "center", "left", "center", "right"]);
  });

  it("preserves definitions, class options, title, author, packages and epilogue", () => {
    const source = fixture("complex-roundtrip.tex");
    const doc = parseMarkdown(writeMarkdown(parseLatex(source)));
    const output = writeLatexArticle(doc);
    for (const text of [
      "\\documentclass[twocolumn]{article}",
      "\\newcommand{\\customscore}{IMPORTANT}",
      "\\title{Preserved title}",
      "\\author{Preserved author}",
      "% Preserved epilogue.",
    ]) expect(output).toContain(text);
    expect(output.match(/\\usepackage\{amsmath/g)).toHaveLength(1);
    expect(output.match(/\\maketitle/g)).toHaveLength(1);
    expect(writeMarkdown(parseMarkdown(writeMarkdown(doc)))).toBe(writeMarkdown(doc));
  });

  it("restores a complete document pasted below existing note prose", () => {
    const markdown = "Existing note paragraph.\n\n" + writeMarkdown(parseLatex(fixture("complex-roundtrip.tex")));
    expect(writeLatexArticle(parseMarkdown(markdown))).toContain("\\newcommand{\\customscore}{IMPORTANT}");
  });

  it("refuses conflicting preambles without removing them from the note", () => {
    const first = writeMarkdown(parseLatex("\\documentclass{article}\n\\begin{document}First.\\end{document}"));
    const second = writeMarkdown(parseLatex("\\documentclass{book}\n\\begin{document}Second.\\end{document}"));
    const doc = parseMarkdown(first + "\n" + second);
    expect(() => writeLatexArticle(doc)).toThrow("conflicting");
    expect(writeMarkdown(doc)).toContain("documentclass{book}");
  });

  it.each([
    String.raw`\multirow{2}{2cm}{A}`,
    String.raw`\multirow{-2}{*}{A}`,
    String.raw`\multicolumn{2}{|c|}{A}`,
  ])("preserves cell attributes outside the supported subset: %s", (cell) => {
    const source = `\\begin{tabular}{ll}${cell} & B \\\\ \\end{tabular}`;
    expect(roundTrip(source).trim()).toBe(source);
  });

  it("keeps a nested matrix in one table cell, including its row delimiters", () => {
    const source = String.raw`\begin{tabular}{ll}Name & $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$ \\ \end{tabular}`;
    const node = parseLatex(source).children[0];
    expect(node.type === "table" && node.rows[0].length).toBe(2);
    expect(roundTrip(source)).toContain(String.raw`$\begin{pmatrix} a & b \\ c & d \end{pmatrix}$`);
  });

  it("preserves extra multirow annotations as raw LaTeX", () => {
    const source = fixture("unsupported-table-tail.tex");
    expect(parseLatex(source).children[0].type).toBe("raw-latex");
    expect(roundTrip(source).trim()).toBe(source.trim());
  });

  it("preserves content following multicolumn rather than moving it inside the span", () => {
    const source = String.raw`\begin{tabular}{ll}\multicolumn{2}{c}{A} IMPORTANT \\ \end{tabular}`;
    expect(roundTrip(source).trim()).toBe(source);
  });

  it("preserves tabular* width, table* and complete graphics options", () => {
    const output = roundTrip(fixture("complex-roundtrip.tex"));
    expect(output).toContain("\\begin{table*}[t]");
    expect(output).toContain("\\begin{tabular*}{\\textwidth}{ll}");
    expect(output).not.toContain("\\begin{tabular}{\\textwidth}");
    expect(output).toContain("\\begin{figure*}[t]");
    expect(output).toContain("\\includegraphics[width=1cm,height=2cm,keepaspectratio]{plot.png}");
    expect(output).toContain("\\end{figure*}");
    expect(output).toContain("\\end{table*}");
  });

  it.each([
    '<table><tr><td><img src="plot.png"></td></tr></table>',
    '<table><tr><td><table><tr><td>NESTED</td></tr></table></td></tr></table>',
    '<table class="custom"><tr><td>STYLED</td></tr></table>',
    '<table><tr><td><span data-key="keep">TEXT</span></td></tr></table>',
  ])("preserves unsupported HTML verbatim: %s", (source) => {
    const doc = parseMarkdown(source);
    expect(doc.children[0]).toMatchObject({ type: "raw-html", raw: source });
    expect(writeMarkdown(doc).trimEnd()).toBe(source);
  });

  it("decodes HTML entities once, keeping escaped literal entity text", () => {
    const source = '<table><tr><td rowspan="2">a</td><td>&amp;lt;</td></tr><tr><td>b</td></tr></table>';
    const output = writeMarkdown(parseMarkdown(source));
    expect(output).toContain("&amp;lt;");
    expect(writeMarkdown(parseMarkdown(output))).toBe(output);
  });

  it("escapes link and wikilink labels as ordinary prose", () => {
    expect(writeLatexFragment(parseMarkdown("[a_b & c](https://example.com)")))
      .toContain("\\href{https://example.com}{a\\_b \\& c}");
    expect(writeLatexFragment(parseMarkdown("[[note|a_b & c]]"))).toBe("a\\_b \\& c\n");
    expect(writeLatexFragment(parseMarkdown("[paper](https://x.test/p?q=10%20a#section)")))
      .toContain("10\\%20a\\#section");
  });

  it("escapes the percent encodings of braces and backslashes in URL arguments", () => {
    const markdown = String.raw`[paper](https://x.test/{draft}/a\b)`;
    expect(writeLatexFragment(parseMarkdown(markdown)))
      .toContain(String.raw`\href{https://x.test/\%7Bdraft\%7D/a\%5Cb}{paper}`);
  });

  it("preserves formatted hyperlink labels and avoids double-encoding TeX URL escapes", () => {
    const source = String.raw`Read \href{https://x.test/a\_b?q=10\%20a\#section}{\textbf{A} \& B} here.`;
    const output = roundTrip(source);
    expect(output).toContain("\\href{https://x.test/a_b?q=10\\%20a\\#section}{\\textbf{A} \\& B}");
    expect(output).not.toContain("%5C");
    const markdown = "[**A** & $x$](https://x.test)";
    const latex = writeLatexArticle(parseMarkdown(markdown));
    expect(latex).toContain("{\\textbf{A} \\& $x$}");
    expect(latex).toContain("\\usepackage{amsmath}");
  });
});

describe("review: portable project output names", () => {
  it("allocates unique names after sanitization, suffixing and case folding", () => {
    const names = sectionBasenames([
      { basename: "a?" }, { basename: "a*" }, { basename: "a-2" },
      { basename: "A" }, { basename: "100% ablation" }, { basename: "CON" },
      { basename: "\u4e2d\u6587" }, { basename: "chapter".repeat(100) },
    ]);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect(names.every((name) => /^[A-Za-z0-9._-]+$/.test(name) && name.length < 130)).toBe(true);
    expect(buildMainTex("article", [], names)).not.toContain("%");
    expect(planProjectExport("paper", names).sectionFiles).toHaveLength(names.length);
  });

  it("rejects unsafe direct planning before any file can be written", () => {
    expect(() => latexInputName("100% ablation")).toThrow("unsafe");
    expect(() => planProjectExport("paper", ["a", "A"])).toThrow("unique");
    expect(() => planProjectExport("paper", ["../outside"])).toThrow("unsafe");
  });
});
