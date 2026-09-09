import { describe, expect, it } from "vitest";
import { parseLatex } from "../../src/core/parser/latex/latex-parser";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { escapeLatexFreeText, writeLatexFragment } from "../../src/core/writer/latex/latex-writer";
import { protectBlock, validateProtection } from "../../src/translation/protector";

/**
 * Regressions found in the 2026-09-08 code audit (see CODE_REVIEW.md).
 * Each test fails against the pre-fix behaviour.
 */

const paragraphOf = (doc: { children: unknown[] }): any =>
  doc.children.find((c: any) => c.type === "paragraph");

const inlineText = (node: any): string =>
  (node?.children ?? []).map((c: any) => c.text ?? "").join("");

describe("audit regressions: LaTeX inline ordering (P0-1)", () => {
  it("keeps text preceding \\textrm in front of the command content", () => {
    const doc = parseLatex(
      "\\documentclass{article}\n\\begin{document}\nsee \\textrm{Fig} 1\n\\end{document}\n",
    );
    // Pre-fix: the unflushed buffer landed after the command → "Figsee  1".
    expect(inlineText(paragraphOf(doc))).toBe("see Fig 1");
  });

  it("keeps ordering for \\text and \\textup too", () => {
    for (const cmd of ["text", "textup", "underline"]) {
      const doc = parseLatex(
        `\\documentclass{article}\n\\begin{document}\nresult \\${cmd}{X} here\n\\end{document}\n`,
      );
      expect(inlineText(paragraphOf(doc))).toBe("result X here");
    }
  });
});

describe("audit regressions: repeated glossary terms (P0-2)", () => {
  it("accepts a faithful output that repeats a preserved term", () => {
    const src = "Transformer is good. Transformer is great.";
    const { protectedText, placeholders } = protectBlock(src, {
      glossary: { Transformer: "preserve" },
    });
    // The term occurs twice and shares one token — that must not be read as
    // a model error.
    const faithful = validateProtection(protectedText, placeholders);
    expect(faithful.ok).toBe(true);
    expect(faithful.problems).toEqual([]);
  });

  it("still rejects an output that drops one of the occurrences", () => {
    const { protectedText, placeholders } = protectBlock("A Transformer and a Transformer.", {
      glossary: { Transformer: "preserve" },
    });
    const dropped = protectedText.replace("⟦TERM_001⟧", "the model");
    const result = validateProtection(dropped, placeholders);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("appears");
  });
});

describe("audit regressions: caption escaping (P1-1)", () => {
  it("escapes & so the produced LaTeX still compiles", () => {
    expect(escapeLatexFreeText("Comparison of A & B")).toBe("Comparison of A \\& B");
    const doc = parseMarkdown("![Comparison of A & B](fig/x.png)");
    expect(writeLatexFragment(doc)).toContain("\\caption{Comparison of A \\& B}");
  });

  it("escapes ^ ~ and a stray $ while keeping math and commands", () => {
    expect(escapeLatexFreeText("x^2 ~ y")).toBe("x\\textasciicircum{}2 \\textasciitilde{} y");
    expect(escapeLatexFreeText("Energy $E=mc^2$")).toBe("Energy $E=mc^2$");
    // An existing command must not be double-escaped.
    expect(escapeLatexFreeText("\\textbf{bold} & more")).toBe("\\textbf{bold} \\& more");
    // Currency is prose, not math.
    expect(escapeLatexFreeText("costs $5")).toBe("costs \\$5");
  });
});

describe("audit regressions: underscore emphasis (P2-1)", () => {
  it("parses _word_ as emphasis at a word boundary", () => {
    const para = paragraphOf(parseMarkdown("_word_ is emphasized"));
    expect(para.children.some((c: any) => c.type === "emph")).toBe(true);
  });

  it("still treats snake_case as plain text", () => {
    const para = paragraphOf(parseMarkdown("snake_case_name here"));
    expect(para.children.some((c: any) => c.type === "emph")).toBe(false);
    expect(inlineText(para)).toBe("snake_case_name here");
  });
});
