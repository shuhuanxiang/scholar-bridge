import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLatex } from "../../src/core/parser/latex/latex-parser";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import {
  detectPackages,
  escapeLatexText,
  writeLatexArticle,
  writeLatexFragment,
} from "../../src/core/writer/latex/latex-writer";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string) => readFileSync(join(here, "../fixtures", p), "utf8");

describe("LaTeX → Markdown writer (TEST_PLAN §3)", () => {
  it("renders equations as $$…$$ with a hidden metadata comment", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/equation.tex")));
    expect(md).toContain("$$");
    expect(md).toContain("\\mathcal{L}_{task}");
    expect(md).toContain('{"environment":"equation","label":"eq:loss","schemaVersion":1,"type":"math"}');
  });
});

describe("Markdown tables (TEST_PLAN §4)", () => {
  it("uses a GFM table when no merged cells exist", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/table_simple.tex")));
    expect(md).toContain("| Method | Accuracy | F1 |");
    // alignment survives: left / right / center separators
    expect(md).toContain(":---");
    expect(md).toContain("---:");
    // metadata comment keeps booktabs/caption/label
    expect(md).toContain('"booktabs":true');
    expect(md).toContain('"label":"tab:main"');
  });

  it("falls back to an HTML table with rowspan for merged cells", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/table_multirow.tex")));
    expect(md).toContain("<table>");
    expect(md).toContain('<td rowspan="7">K = 30</td>');
    expect(md).not.toMatch(/^\|/m); // no pipe table
  });

  it("escapes literal pipes inside GFM cells (regression)", () => {
    // Source uses the escaped form (as GFM requires); IR holds latex "a|b".
    const md = "| A | B |\n|---|---|\n| x | $a\\|b$ |\n";
    const written = writeMarkdown(parseMarkdown(md));
    expect(written).toContain("$a\\|b$");
    const reparsed = parseMarkdown(written);
    const table = reparsed.children[0];
    if (table.type !== "table") throw new Error("expected table");
    // header + one body row (the separator line is not an IR row)
    expect(table.rows.map((r) => r.length)).toEqual([2, 2]);
    const math = table.rows[1][1].content[0];
    expect(math.type).toBe("inline-math");
    expect((math as { latex: string }).latex).toBe("a|b");

    // LaTeX-origin tables get the same protection on first conversion.
    const fromLatex = writeMarkdown(
      parseLatex("\\begin{tabular}{lc}\\toprule\nm & $a|b$ \\\\\n\\bottomrule\n\\end{tabular}"),
    );
    expect(fromLatex).toContain("$a\\|b$");
  });
});

describe("Figures (TEST_PLAN §5)", () => {
  it("emits an Obsidian embed with metadata for caption/label/width", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/figure.tex")));
    expect(md).toContain("![[figures/time_comparison.pdf|45%]]");
    expect(md).toContain('"label":"fig:time"');
    expect(md).toContain("0.45\\\\textwidth");
  });
});

describe("Markdown → LaTeX (TEST_PLAN §6)", () => {
  it("maps heading/bold/math/list to section/textbf/math/enumerate", () => {
    const latex = writeLatexFragment(parseMarkdown(fixture("markdown/prose.md")));
    expect(latex).toContain("\\section{Method}");
    expect(latex).toContain("\\textbf{FedContra}");
    expect(latex).toContain("$L = L_1 + \\lambda L_2$");
    expect(latex).toContain("\\begin{enumerate}");
    expect(latex).toContain("\\item Train the adapter.");
  });

  it("writes a full article with detected packages", () => {
    const doc = parseMarkdown(fixture("markdown/prose.md"));
    const latex = writeLatexArticle(parseMarkdown(fixture("markdown/figure.md")));
    expect(latex).toContain("\\documentclass{article}");
    expect(latex).toContain("\\usepackage{graphicx}");
    expect(latex).toContain("\\begin{document}");
    void doc;
  });

  it("detects booktabs/multirow/hyperref packages (§8.2)", () => {
    const tableDoc = parseLatex(fixture("latex/table_multirow.tex"));
    expect(detectPackages(tableDoc)).toEqual(expect.arrayContaining(["booktabs", "multirow"]));
    const linkDoc = parseMarkdown("[paper](https://example.com/paper.pdf)");
    expect(detectPackages(linkDoc)).toContain("hyperref");
  });
});

describe("Round trips", () => {
  it("LaTeX equation → Markdown → LaTeX keeps the label (TEST_PLAN §3)", () => {
    const doc = parseLatex(fixture("latex/equation.tex"));
    const back = parseLatex(writeLatexFragment(parseMarkdown(writeMarkdown(doc))));
    const math = back.children[0];
    if (math.type !== "math") throw new Error("expected math");
    expect(math.label).toBe("eq:loss");
    expect(math.environment).toBe("equation");
    expect(math.latex).toContain("\\lambda");
  });

  it("multirow table: LaTeX → HTML Markdown → LaTeX keeps rowSpan", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/table_multirow.tex")));
    const back = parseMarkdown(md);
    const table = back.children.find((c) => c.type === "table");
    if (!table || table.type !== "table") throw new Error("expected table");
    expect(table.rows[0][0].rowSpan).toBe(7);
    const latex = writeLatexFragment({ type: "document", children: [table] });
    expect(latex).toContain("\\multirow{7}{*}{K = 30}");
  });

  it("figure round trip retains path/width/caption/label", () => {
    const doc = parseLatex(fixture("latex/figure.tex"));
    const back = parseMarkdown(writeMarkdown(doc));
    const fig = back.children[0];
    if (fig.type !== "figure") throw new Error("expected figure");
    expect(fig.path).toBe("figures/time_comparison.pdf");
    expect(fig.latexWidth).toBe("0.45\\textwidth");
    expect(fig.label).toBe("fig:time");
    const latex = writeLatexFragment({ type: "document", children: [fig] });
    expect(latex).toContain("\\includegraphics[width=0.45\\textwidth]{figures/time_comparison.pdf}");
    expect(latex).toContain("\\caption{Training time comparison across methods.}");
    expect(latex).toContain("\\label{fig:time}");
  });

  it("simple table round trip keeps booktabs metadata", () => {
    const md = writeMarkdown(parseLatex(fixture("latex/table_simple.tex")));
    const back = parseMarkdown(md);
    const table = back.children[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.booktabs).toBe(true);
    expect(table.label).toBe("tab:main");
    const latex = writeLatexFragment({ type: "document", children: [table] });
    expect(latex).toContain("\\begin{tabular}{lcc}");
    expect(latex).toContain("\\toprule");
    expect(latex).toContain("\\textbf{FedContra}");
    expect(latex).toContain("\\bottomrule");
  });

  it("Markdown → LaTeX → Markdown preserves prose content", () => {
    const doc = parseMarkdown(fixture("markdown/prose.md"));
    const back = parseLatex(writeLatexFragment(doc));
    const kinds = back.children.map((c) => c.type);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("list");
    const bold = back.children.find((c) => c.type === "paragraph");
    expect(bold).toBeDefined();
    const text = back.children
      .filter((c) => c.type === "paragraph")
      .map((p) => JSON.stringify(p))
      .join("");
    expect(text).toContain("FedContra");
  });

  it("never destroys unsupported LaTeX on markdown round trip", () => {
    const weird = "\\begin{tikzpicture}\n\\node at (0,0) {x};\n\\end{tikzpicture}";
    const doc = parseLatex(weird);
    expect(doc.children[0].type).toBe("raw-latex");
    const md = writeMarkdown(doc);
    expect(md).toContain("\\begin{tikzpicture}");
    // and the raw node survives back to LaTeX verbatim
    expect(writeLatexFragment(parseMarkdown(md))).toContain("\\node at (0,0) {x};");
  });
});

// ---------------------------------------------------------------------------
// Regression tests (code-review fixes)
// ---------------------------------------------------------------------------

describe("LaTeX text escaping (review fixes)", () => {
  it("renders a literal backslash as \\textbackslash{} (regression)", () => {
    expect(escapeLatexText("a\\b")).toBe("a\\textbackslash{}b");
    expect(escapeLatexText("C:\\Users\\name")).toBe("C:\\textbackslash{}Users\\textbackslash{}name");
  });

  it("escapes backslashes in code spans and table cells on export", () => {
    const latex = writeLatexFragment(
      parseMarkdown("Path `C:\\Users\\name` in prose.\n\n| Col |\n|---|\n| `a\\b` |"),
    );
    expect(latex).toContain("\\texttt{C:\\textbackslash{}Users\\textbackslash{}name}");
    expect(latex).toContain("\\texttt{a\\textbackslash{}b}");
  });
});

describe("Code fences (CommonMark, review fixes)", () => {
  it("lengthens the fence when the content contains a backtick run", () => {
    const md = "````\ninner ``` fence\n````\n";
    const out = writeMarkdown(parseMarkdown(md));
    expect(out).toBe(md);
    expect(writeMarkdown(parseMarkdown(out))).toBe(out);
  });

  it("round-trips a ~~~ fence containing a ```js block", () => {
    const md = "~~~\n``` js\nx\n~~~\n";
    const out = writeMarkdown(parseMarkdown(md));
    expect(out).toBe("````\n``` js\nx\n````\n");
    expect(writeMarkdown(parseMarkdown(out))).toBe(out);
  });
});

describe("LaTeX export whitespace (review fixes)", () => {
  it("keeps blank runs inside code bodies on LaTeX export (regression)", () => {
    const md = "```\na\n\n\n\nb\n```\n";
    const latex = writeLatexFragment(parseMarkdown(md));
    expect(latex).toContain("\\begin{verbatim}\na\n\n\n\nb\n\\end{verbatim}");
  });
});

describe("Figures (review fixes)", () => {
  it("emits the figure meta comment for caption-only figures (regression)", () => {
    const md = "![A caption](images/plot.png)\n";
    const out = writeMarkdown(parseMarkdown(md));
    expect(out).toContain("![[images/plot.png]]");
    expect(out).toContain('"caption":"A caption"');
    const back = parseMarkdown(out);
    const fig = back.children[0];
    if (fig.type !== "figure") throw new Error("expected figure");
    expect(fig.caption).toBe("A caption");
    expect(writeMarkdown(back)).toBe(out);
  });
});

describe("Table alignment export (review fixes)", () => {
  it("exports sparse GFM alignments at their original column positions", () => {
    const latex = writeLatexFragment(parseMarkdown("| a | b | c |\n|---|---|:---:|\n| 1 | 2 | 3 |"));
    expect(latex).toContain("\\begin{tabular}{llc}");
  });
});

describe("Dollar escaping (review fixes)", () => {
  it("re-escapes literal dollars so \\$ does not grow backslashes (regression)", () => {
    const out = writeMarkdown(parseMarkdown("price \\$5"));
    expect(out).toContain("price \\$5");
    expect(out).not.toContain("\\\\$5");
    expect(writeMarkdown(parseMarkdown(out))).toBe(out);
    expect(writeMarkdown(parseMarkdown("value $x$ here"))).toContain("$x$");
  });
});

describe("Links (review fixes)", () => {
  it("round-trips link targets with parentheses and titles", () => {
    const md1 = "[wiki](https://en.wikipedia.org/wiki/Thing_(concept))\n";
    const out1 = writeMarkdown(parseMarkdown(md1));
    expect(out1).toContain("[wiki](https://en.wikipedia.org/wiki/Thing_(concept))");
    expect(writeMarkdown(parseMarkdown(out1))).toBe(out1);

    const md2 = '[a](https://x.example "the title")\n';
    const out2 = writeMarkdown(parseMarkdown(md2));
    expect(out2).toContain('[a](https://x.example "the title")');
    expect(writeMarkdown(parseMarkdown(out2))).toBe(out2);

    const latex = writeLatexFragment(parseMarkdown(md2));
    expect(latex).toContain("\\href{https://x.example}{a}");
    expect(latex).not.toContain("the title");
  });
});

describe("Lists (review fixes)", () => {
  it("keeps loose lists loose and tight lists tight", () => {
    const loose = writeMarkdown(parseMarkdown("- a\n\n- b\n"));
    expect(loose).toBe("- a\n\n- b\n");
    expect(writeMarkdown(parseMarkdown(loose))).toBe(loose);
    expect(writeMarkdown(parseMarkdown("- a\n- b\n"))).toBe("- a\n- b\n");
  });

  it("keeps an ordered-list start of 0 (regression)", () => {
    const out = writeMarkdown(parseMarkdown("0. a\n0. b\n"));
    expect(out).toContain("0. a");
    const list = parseMarkdown(out).children[0];
    if (list.type !== "list") throw new Error("expected list");
    expect(list.start).toBe(0);
  });
});

describe("Thematic breaks (review fixes)", () => {
  it("writes thematic breaks back as ---", () => {
    const out = writeMarkdown(parseMarkdown("para\n\n* * *\n\nafter\n"));
    expect(out).toBe("para\n\n---\n\nafter\n");
    expect(writeMarkdown(parseMarkdown(out))).toBe(out);
  });
});

describe("HTML tables (review fixes)", () => {
  it("escapes HTML-special characters in table cells (regression)", () => {
    const md = '<table>\n  <tr><td rowspan="2">x</td><td>a &lt; b</td></tr>\n  <tr><td>y</td></tr>\n</table>';
    const out = writeMarkdown(parseMarkdown(md));
    expect(out).toContain("<td>a &lt; b</td>");
    const back = parseMarkdown(out);
    const table = back.children[0];
    if (table.type !== "table") throw new Error("expected table");
    const cellText = table.rows[0][1].content.map((n) => (n.type === "text" ? n.text : "")).join("");
    expect(cellText).toBe("a < b");
    expect(writeMarkdown(back)).toBe(out);
  });
});
