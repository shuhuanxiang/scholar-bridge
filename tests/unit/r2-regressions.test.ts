import { describe, expect, it } from "vitest";
import { parseLatex } from "../../src/core/parser/latex/latex-parser";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { writeLatexFragment } from "../../src/core/writer/latex/latex-writer";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import {
  protectBlock,
  restorePlaceholders,
  validateProtection,
  type PlaceholderInfo,
} from "../../src/translation/protector";
import { buildTranslationBlock, type ReinsertionInput } from "../../src/translation/reinsertion";
import { scanFreshness } from "../../src/translation/freshness";
import { extractJson } from "../../src/translation/llama/client";
import { sanitizeGlossary } from "../../src/settings/settings";
import { tokenizeFormula } from "../../src/diff/formula-tokenizer";
import { applyAcceptedChangesToLines } from "../../src/diff/diff-apply";
import type { BlockDiff } from "../../src/diff/structural-diff";

/**
 * Regressions found in the 2026-09-08 SECOND code audit (CODE_REVIEW_R2.md).
 * Each test fails against the pre-fix behaviour.
 */

const paragraphOf = (doc: { children: unknown[] }): any =>
  doc.children.find((c: any) => c.type === "paragraph");

const firstBlock = (markdown: string): any => parseMarkdown(markdown).children[0];

const makeInput = (raw: string, nodeId: string, translation: string): ReinsertionInput => ({
  nodeId,
  translation,
  range: { raw, startLine: 0, endLine: 0 },
  meta: {
    sourceLanguage: "zh",
    targetLanguage: "en",
    model: "test-model",
    glossaryVersion: "g_1",
    promptVersion: "v1",
  },
});

describe("R2 P1-4: natbib optional citation arguments", () => {
  it("keeps \\citep[see][p.~5]{key} as one citation node", () => {
    const doc = parseLatex(
      "\\begin{document}\nSee \\citep[see][p.~5]{smith2004} now.\n\\end{document}\n",
    );
    const cite = paragraphOf(doc).children.find((c: any) => c.type === "citation");
    expect(cite).toBeDefined();
    expect(cite.raw).toBe("\\citep[see][p.~5]{smith2004}");
    expect(cite.keys).toEqual(["smith2004"]);
  });

  it("still parses the plain \\cite{key} form", () => {
    const doc = parseLatex(
      "\\begin{document}\nSee \\cite{smith2004,jones2005} now.\n\\end{document}\n",
    );
    const cite = paragraphOf(doc).children.find((c: any) => c.type === "citation");
    expect(cite).toBeDefined();
    expect(cite.keys).toEqual(["smith2004", "jones2005"]);
  });
});

describe("R2 P1-3: display math keeps its flag", () => {
  it("writes inline display math as \\[…\\] instead of $…$", () => {
    const doc = parseMarkdown("before $$E=mc^2$$ after");
    const out = writeLatexFragment(doc);
    expect(out).toContain("\\[E=mc^2\\]");
    expect(out).not.toContain("$E=mc^2$");
  });

  it("round-trips the display flag through LaTeX", () => {
    const doc = parseMarkdown("before $$E=mc^2$$ after");
    const latex = writeLatexFragment(doc);
    const back = parseLatex(latex);
    // The display math must survive as a MATH block (not inline prose).
    expect(JSON.stringify(back)).toContain('"type":"math"');
    expect(JSON.stringify(back)).toContain("E=mc^2");
  });
});

describe("R2 P2-1: tabular row splitting honours brace depth", () => {
  it("does not split a row on \\\\ inside a brace group", () => {
    const doc = parseLatex(
      "\\begin{table}\n\\begin{tabular}{cc}\nA & \\makecell{X\\\\Y} \\\\\n\\end{tabular}\n\\end{table}\n",
    );
    const table = doc.children.find((c: any) => c.type === "table");
    expect(table).toBeDefined();
    // Pre-fix: the \\ inside \makecell{X\\Y} split the row in two.
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toHaveLength(2);
  });
});

describe("R2 P2-2: line-leading block markers are escaped", () => {
  it("escapes paragraph lines starting with > or #", () => {
    const doc = parseLatex(
      "\\begin{document}\n>100 cases were reviewed.\n\n#3 filter applied.\n\\end{document}\n",
    );
    const out = writeMarkdown(doc);
    expect(out).toContain("\\>100 cases");
    expect(out).toContain("\\#3 filter applied");
  });

  it("round-trips back to the original paragraph text", () => {
    const doc = parseLatex(
      "\\begin{document}\n>100 cases were reviewed.\n\\end{document}\n",
    );
    const back = parseMarkdown(writeMarkdown(doc));
    const para = paragraphOf(back);
    expect(para.type).toBe("paragraph");
    expect((para.children as any[]).map((c) => c.text ?? "").join("")).toContain(">100 cases");
  });

  it("escapes an ordered-marker line as 1\\.", () => {
    const doc = parseLatex("\\begin{document}\n1. not a list\n\\end{document}\n");
    const out = writeMarkdown(doc);
    expect(out).toContain("1\\. not a list");
  });
});

describe("R2 P2-3: placeholder restoration is single-pass", () => {
  it("does not cascade when a restored value contains another token", () => {
    const placeholders: PlaceholderInfo[] = [
      { token: "⟦RAW_001⟧", kind: "RAW", value: "prefix ⟦TERM_001⟧ suffix" },
      { token: "⟦TERM_001⟧", kind: "TERM", value: "Transformer" },
    ];
    // Pre-fix: restoring RAW_001 injected ⟦TERM_001⟧, which the next pass
    // replaced again — the literal data was corrupted.
    expect(restorePlaceholders("A ⟦RAW_001⟧ B", placeholders)).toBe(
      "A prefix ⟦TERM_001⟧ suffix B",
    );
  });
});

describe("R2 P2-4: token-shaped literals in user text", () => {
  it("protects ⟦MATH_001⟧-style literals and restores them verbatim", () => {
    const src = "The marker ⟦MATH_001⟧ stays verbatim.";
    const { protectedText, placeholders } = protectBlock(src);
    expect(protectedText).not.toContain("⟦MATH_001⟧");
    // Pre-fix: the literal reached the model unprotected and its faithful
    // return was rejected as an "unknown placeholder".
    expect(validateProtection(protectedText, placeholders).ok).toBe(true);
    expect(restorePlaceholders(protectedText, placeholders)).toBe(src);
  });
});

describe("R2 P2-5: diff apply anchoring", () => {
  const diff = (status: BlockDiff["status"], oldMd: string, newMd: string): BlockDiff => ({
    status,
    type: firstBlock(oldMd).type,
    oldNode: firstBlock(oldMd),
    newNode: firstBlock(newMd),
  });

  it("a missed block consumes its opening-line occurrence before later blocks search", () => {
    const lines = ["- 共享段。", "独特段。", "- 共享段。"];
    // Block 0's old list has two items — the exact sequence is absent (hand
    // edited), so it cannot be located. Block 1's old text equals the shared
    // line, which occurs at index 0 AND 2: without consuming the missed
    // block's opening occurrence, block 1 anchored at index 0 and corrupted
    // the untouched first item.
    const blocks: BlockDiff[] = [
      diff("changed", "- 共享段。\n- 中间段。", "- 新列表。"),
      diff("changed", "- 共享段。", "- 改段。"),
    ];
    const res = applyAcceptedChangesToLines(lines, blocks, new Set([0, 1]));
    expect(res.skipped.map((s) => s.index)).toEqual([0]);
    expect(res.applied).toEqual([1]);
    expect(res.text.split("\n")).toEqual(["- 共享段。", "独特段。", "- 改段。"]);
  });
});

describe("R2 P3-1: hash-guided source recovery", () => {
  it("finds the true source when other blocks sit directly above it", () => {
    const source = "正文段落。";
    const block = buildTranslationBlock(makeInput(source, "p_1", "Body paragraph."));
    // translate-section layout: the heading is glued to the source (no blank
    // line) but is NOT part of the translated range.
    const text = `# Title\n${source}\n${block}`;
    const report = scanFreshness(text);
    expect(report.entries).toHaveLength(1);
    // Pre-fix: the extension swallowed the heading → hash mismatch → the
    // block was falsely reported stale on every scan.
    expect(report.entries[0].status).toBe("fresh");
    expect(report.entries[0].sourceRaw).toBe(source);
  });

  it("still reports stale when the source really changed", () => {
    const block = buildTranslationBlock(makeInput("原始段落。", "p_1", "Original."));
    const report = scanFreshness(`# Title\n修改过的段落。\n${block}`);
    expect(report.entries[0].status).toBe("stale");
  });
});

describe("R2 P3-2: extractJson balanced extraction", () => {
  it("ignores a trailing brace in surrounding prose", () => {
    expect(extractJson('Result: {"blocks":[]} } done')).toBe('{"blocks":[]}');
  });

  it("keeps the fenced and padded cases working", () => {
    expect(extractJson('```json\n{"blocks":[]}\n```')).toBe('{"blocks":[]}');
    expect(extractJson('Here you go: {"blocks":[]} hope it helps')).toBe('{"blocks":[]}');
  });
});

describe("R2 P3-3: glossary sanitisation", () => {
  it("drops non-object and non-string garbage", () => {
    expect(sanitizeGlossary("garbage")).toEqual({});
    expect(sanitizeGlossary(["x"])).toEqual({});
    expect(sanitizeGlossary(null)).toEqual({});
    expect(sanitizeGlossary({ a: "zh", b: 5, c: null, d: ["x"] })).toEqual({ a: "zh" });
  });
});

describe("R2 §7 leftover: formula tokenizer operator runs", () => {
  it("merges multi-character operators into one token", () => {
    const toks = tokenizeFormula("a<=b").filter((t) => t.type !== "space");
    expect(toks.map((t) => t.text)).toEqual(["a", "<=", "b"]);
    const sum = tokenizeFormula("x += 1").filter((t) => t.type !== "space");
    expect(sum.map((t) => t.text)).toContain("+=");
  });
});
