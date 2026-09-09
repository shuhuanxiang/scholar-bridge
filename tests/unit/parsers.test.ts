import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLatex } from "../../src/core/parser/latex/latex-parser";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string) => readFileSync(join(here, "../fixtures", p), "utf8");

describe("LaTeX parser (TEST_PLAN §3)", () => {
  it("parses an equation with label into a display MathNode", () => {
    const doc = parseLatex(fixture("latex/equation.tex"));
    expect(doc.children).toHaveLength(1);
    const math = doc.children[0];
    expect(math.type).toBe("math");
    if (math.type !== "math") return;
    expect(math.display).toBe(true);
    expect(math.environment).toBe("equation");
    expect(math.label).toBe("eq:loss");
    expect(math.latex).toContain("\\mathcal{L}");
    expect(math.latex).not.toContain("\\label");
  });

  it("parses align environments preserving the environment name", () => {
    const doc = parseLatex(fixture("latex/align.tex"));
    const math = doc.children[0];
    if (math.type !== "math") throw new Error("expected math");
    expect(math.environment).toBe("align");
    expect(math.latex).toContain("&");
    expect(math.latex).toContain("\\\\");
    expect(math.label).toBe("eq:align");
  });
});

describe("LaTeX tables (TEST_PLAN §4)", () => {
  it("parses a simple booktabs table with header cells and bold content", () => {
    const doc = parseLatex(fixture("latex/table_simple.tex"));
    const table = doc.children[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.booktabs).toBe(true);
    expect(table.caption).toContain("Main results");
    expect(table.label).toBe("tab:main");
    expect(table.columnAlignments).toEqual(["left", "center", "center"]);
    expect(table.rows).toHaveLength(3);
    const header = table.rows[0].map((c) => c.content.map((n) => (n.type === "text" ? n.text : "")).join(""));
    expect(header).toEqual(["Method", "Accuracy", "F1"]);
    const boldCell = table.rows[2].cells?.[0] ?? table.rows[2][0];
    expect(boldCell.content[0].type).toBe("strong");
    expect((boldCell.content[0] as { children: { text: string }[] }).children[0].text).toBe("FedContra");
  });

  it("converts \\multirow{7}{*}{K = 30} into rowSpan = 7", () => {
    const doc = parseLatex(fixture("latex/table_multirow.tex"));
    const table = doc.children[0];
    if (table.type !== "table") throw new Error("expected table");
    const first = table.rows[0][0];
    expect(first.rowSpan).toBe(7);
    expect(first.content.map((n) => (n.type === "text" ? n.text : "")).join("")).toBe("K = 30");
    // continuation placeholders keep the row shape consistent
    expect(table.rows[1][0].rowSpanContinue).toBe(true);
    expect(table.rows[2][0].rowSpanContinue).toBe(true);
  });
});

describe("LaTeX figures (TEST_PLAN §5)", () => {
  it("keeps path, width, caption, label and placement", () => {
    const doc = parseLatex(fixture("latex/figure.tex"));
    const fig = doc.children[0];
    if (fig.type !== "figure") throw new Error("expected figure");
    expect(fig.path).toBe("figures/time_comparison.pdf");
    expect(fig.latexWidth).toBe("0.45\\textwidth");
    expect(fig.width).toBe("45%");
    expect(fig.caption).toContain("Training time");
    expect(fig.label).toBe("fig:time");
    expect(fig.placement).toBe("htbp");
  });
});

describe("LaTeX algorithms", () => {
  it("parses algorithm + algorithmic with caption/label/backend", () => {
    const doc = parseLatex(fixture("latex/algorithm.tex"));
    const alg = doc.children[0];
    if (alg.type !== "algorithm") throw new Error("expected algorithm");
    expect(alg.caption).toContain("FedContra training loop");
    expect(alg.label).toBe("alg:fedcontra");
    expect(alg.backend).toBe("algorithmic");
    expect(alg.body.length).toBeGreaterThan(3);
    expect(alg.body.some((s) => s.text.startsWith("\\FOR"))).toBe(true);
  });
});

describe("LaTeX fallback", () => {
  it("never drops unknown environments (RawLatexNode)", () => {
    const doc = parseLatex("\\begin{myenv}\nstrange \\weirdcommand{x}\n\\end{myenv}");
    expect(doc.children[0].type).toBe("raw-latex");
    if (doc.children[0].type !== "raw-latex") return;
    expect(doc.children[0].raw).toContain("\\weirdcommand{x}");
  });
});

describe("Markdown parser", () => {
  it("parses headings, bold, lists, quotes and code (TEST_PLAN §6 input side)", () => {
    const doc = parseMarkdown(fixture("markdown/prose.md"));
    const kinds = doc.children.map((c) => c.type);
    expect(kinds[0]).toBe("heading");
    expect(doc.children.some((c) => c.type === "list" && (c as { ordered: boolean }).ordered)).toBe(true);
    expect(doc.children.some((c) => c.type === "list" && !(c as { ordered: boolean }).ordered)).toBe(true);
    expect(doc.children.some((c) => c.type === "quote")).toBe(true);
    expect(doc.children.some((c) => c.type === "code")).toBe(true);
  });

  it("parses inline and display math", () => {
    const doc = parseMarkdown(fixture("markdown/equations.md"));
    const display = doc.children.find((c) => c.type === "math");
    expect(display).toBeDefined();
    expect((display as { latex: string }).latex).toContain("\\mathcal{L}_{task}");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.some((c) => c.type === "inline-math")).toBe(true);
  });

  it("parses GFM tables with alignment", () => {
    const doc = parseMarkdown(fixture("markdown/table.md"));
    const table = doc.children[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0][1].alignment).toBe("right");
    expect(table.rows[0][2].alignment).toBe("center");
  });

  it("parses Obsidian embeds into figures with metadata from comments", () => {
    const doc = parseMarkdown(fixture("markdown/figure.md"));
    const fig = doc.children[0];
    if (fig.type !== "figure") throw new Error("expected figure");
    expect(fig.path).toBe("figures/time_comparison.pdf");
    expect(fig.width).toBe("45%");
    expect(fig.latexWidth).toBe("0.45\\textwidth");
    expect(fig.label).toBe("fig:time");
    expect(fig.caption).toContain("Training time");
  });

  it("pairs translation start/end markers into translation blocks", () => {
    const md = [
      "我们提出一种新的联邦学习防御方法。",
      "",
      "<!-- scholarbridge:translation:start",
      '{"schemaVersion":1,"sourceNodeId":"p_14","sourceLanguage":"zh","targetLanguage":"en","sourceHash":"abc","model":"m","glossaryVersion":"g","promptVersion":"p","status":"fresh"}',
      "-->",
      "We propose a new federated learning defense method.",
      "<!-- scholarbridge:translation:end -->",
    ].join("\n");
    const doc = parseMarkdown(md);
    expect(doc.children).toHaveLength(2);
    const tr = doc.children[1];
    if (tr.type !== "translation-block") throw new Error("expected translation block");
    expect(tr.meta.sourceNodeId).toBe("p_14");
    expect(tr.text).toBe("We propose a new federated learning defense method.");
  });

  it("does not mistake setext-style underlines for tables (regression)", () => {
    const doc = parseMarkdown("a | b\n---\n\n正文。\n");
    expect(doc.children.every((c) => c.type !== "table")).toBe(true);
  });

  it("keeps currency amounts out of inline math (regression)", () => {
    const doc = parseMarkdown("It costs $5 and $10 total.");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.every((c) => c.type !== "inline-math")).toBe(true);
    expect(para.children.map((c) => (c.type === "text" ? c.text : "")).join("")).toContain("$5 and $10");
  });
});

// ---------------------------------------------------------------------------
// Regression tests (code-review fixes)
// ---------------------------------------------------------------------------

describe("LaTeX algorithm parsing (review fixes)", () => {
  it("keeps escaped % in algorithm statements and strips real comments (regression)", () => {
    const tex = [
      "\\begin{algorithm}",
      "\\begin{algorithmic}",
      "\\STATE keep 90\\% of samples",
      "\\STATE x % real comment",
      "\\end{algorithmic}",
      "\\end{algorithm}",
    ].join("\n");
    const doc = parseLatex(tex);
    const alg = doc.children[0];
    if (alg.type !== "algorithm") throw new Error("expected algorithm");
    expect(alg.body[0].text).toBe("\\STATE keep 90\\% of samples");
    expect(alg.body[1].text).toBe("\\STATE x");
  });

  it("derives algorithm statement indent from leading whitespace", () => {
    const tex = [
      "\\begin{algorithm}",
      "\\begin{algorithmic}",
      "\\STATE outer",
      "  \\STATE inner",
      "    \\STATE deepest",
      "\\STATE outer2",
      "\\end{algorithmic}",
      "\\end{algorithm}",
    ].join("\n");
    const doc = parseLatex(tex);
    const alg = doc.children[0];
    if (alg.type !== "algorithm") throw new Error("expected algorithm");
    expect(alg.body.map((s) => s.indent)).toEqual([0, 1, 2, 0]);
  });
});

describe("Translation block content (review fixes)", () => {
  const meta =
    '{"schemaVersion":1,"sourceNodeId":"p_1","sourceLanguage":"zh","targetLanguage":"en","sourceHash":"h","model":"m","glossaryVersion":"g","promptVersion":"p","status":"fresh"}';

  it("keeps list and quote content inside translation blocks (regression)", () => {
    const md = [
      "<!-- scholarbridge:translation:start",
      meta,
      "-->",
      "- item one",
      "- item two",
      "",
      "> quoted text",
      "<!-- scholarbridge:translation:end -->",
    ].join("\n");
    const doc = parseMarkdown(md);
    const tr = doc.children[0];
    if (tr.type !== "translation-block") throw new Error("expected translation block");
    expect(tr.text).toContain("- item one");
    expect(tr.text).toContain("- item two");
    expect(tr.text).toContain("> quoted text");
  });
});

describe("Inline markdown (review fixes)", () => {
  it("parses __bold__ as strong but keeps intraword double underscores literal", () => {
    const doc = parseMarkdown("__bold__ and snake__case__name");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    const strong = para.children.find((c) => c.type === "strong");
    expect(strong).toBeDefined();
    const text = para.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("snake__case__name");
  });

  it("keeps spaced asterisks as plain text (CommonMark flanking)", () => {
    const doc = parseMarkdown("2 * 3 * 4 and a ** b ** c and ** ** x");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.every((c) => c.type !== "emph" && c.type !== "strong")).toBe(true);
    const text = para.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("2 * 3 * 4");
    expect(text).toContain("a ** b ** c");
  });

  it("still parses **bold** and *em*", () => {
    const doc = parseMarkdown("**bold** and *em*");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.some((c) => c.type === "strong")).toBe(true);
    expect(para.children.some((c) => c.type === "emph")).toBe(true);
  });

  it("unescapes \\$ to a literal dollar in text", () => {
    const doc = parseMarkdown("price \\$5");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children).toHaveLength(1);
    expect(para.children[0]).toMatchObject({ type: "text", text: "price $5" });
  });

  it("parses links with balanced parentheses in the target", () => {
    const doc = parseMarkdown("[wiki](https://en.wikipedia.org/wiki/Thing_(concept))");
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    const link = para.children[0];
    if (link.type !== "link") throw new Error("expected link");
    expect(link.target).toBe("https://en.wikipedia.org/wiki/Thing_(concept)");
  });

  it("separates the link title from the target", () => {
    const doc = parseMarkdown('[a](https://x.example "the title")');
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    const link = para.children[0];
    if (link.type !== "link") throw new Error("expected link");
    expect(link.target).toBe("https://x.example");
    expect(link.title).toBe("the title");
    expect(link.alias).toBe("a");
  });
});

describe("Display math on one line (review fixes)", () => {
  it("parses $$x$$ trailing text as inline display math plus prose (regression)", () => {
    const doc = parseMarkdown("$$x$$ trailing text\nmore prose");
    expect(doc.children).toHaveLength(2);
    const para = doc.children[0];
    if (para.type !== "paragraph") throw new Error("expected paragraph");
    const math = para.children[0];
    if (math.type !== "inline-math") throw new Error("expected inline math");
    expect(math.display).toBe(true);
    expect(math.latex).toBe("x");
    const text = para.children.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toBe(" trailing text");
    expect(doc.children[1].type).toBe("paragraph");
  });

  it("parses $$$$ as an empty display math block", () => {
    const doc = parseMarkdown("$$$$");
    const math = doc.children[0];
    if (math.type !== "math") throw new Error("expected math block");
    expect(math.latex).toBe("");
  });

  it("keeps the multi-line $$ … $$ path", () => {
    const doc = parseMarkdown("$$\na\nb\n$$");
    const math = doc.children[0];
    if (math.type !== "math") throw new Error("expected math");
    expect(math.latex).toBe("a\nb");
  });
});

describe("GFM table alignment positions (review fixes)", () => {
  it("keeps unaligned columns in place (sparse columnAlignments)", () => {
    const md = "| a | b | c |\n|---|---|:---:|\n| 1 | 2 | 3 |";
    const doc = parseMarkdown(md);
    const table = doc.children[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.columnAlignments).toEqual([undefined, undefined, "center"]);
  });
});

describe("LaTeX tables (review fixes)", () => {
  it("does not split tabular rows on \\\\ inside nested environments", () => {
    const tex = [
      "\\begin{tabular}{ll}",
      "a & $\\begin{pmatrix} p \\\\ q \\end{pmatrix}$ \\\\",
      "x & y \\\\",
      "\\end{tabular}",
    ].join("\n");
    const doc = parseLatex(tex);
    const table = doc.children[0];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toHaveLength(2);
  });

  it("does not decorate the raw fallback of a tabular-less table float", () => {
    const doc = parseLatex("\\begin{table}[h]\n\\caption{Only}\n\\end{table}");
    const node = doc.children[0];
    expect(node.type).toBe("raw-latex");
    expect(Object.hasOwn(node, "caption")).toBe(false);
    expect(Object.hasOwn(node, "label")).toBe(false);
  });
});

describe("Thematic breaks (review fixes)", () => {
  it("parses thematic breaks (spaced or not) instead of a list", () => {
    for (const line of ["* * *", "***", "___", "---"]) {
      const doc = parseMarkdown(line);
      expect(doc.children, line).toHaveLength(1);
      expect(doc.children[0].type, line).toBe("thematic-break");
    }
    const doc = parseMarkdown("- list");
    expect(doc.children[0].type).toBe("list");
  });

  it("breaks a paragraph before a thematic break line", () => {
    const doc = parseMarkdown("prose line\n***\n");
    expect(doc.children.map((c) => c.type)).toEqual(["paragraph", "thematic-break"]);
  });
});
