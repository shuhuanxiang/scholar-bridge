import { describe, expect, it } from "vitest";
import { diffDocuments, diffDocumentsIR, DEFAULT_DIFF_OPTIONS } from "../../src/diff/structural-diff";
import { tokenizeFormula } from "../../src/diff/formula-tokenizer";
import { tokenizeText } from "../../src/diff/text-tokenizer";
import type {
  MathEnvironment,
  MathNode,
  ParagraphNode,
  ScholarBlockNode,
  ScholarDocument,
  TableNode,
  TableCell,
} from "../../src/core/ir/nodes";

const changedText = (s: string) =>
  s
    .map((c) => (c.op === "equal" ? "" : c.op === "replace" ? `old:${c.oldText}` : `del:${c.text}`))
    .join("");

describe("Chinese word-level diff (TEST_PLAN §7)", () => {
  it("focuses on 鲁棒性 → 安全性, not the whole line", () => {
    const result = diffDocuments("该方法显著提高模型的鲁棒性。", "该方法显著提高模型的安全性。");
    const changed = result.blocks.filter((b) => b.status === "changed");
    expect(changed).toHaveLength(1);
    const changes = changed[0].changes ?? [];
    const changedPieces = changes.filter((c) => c.op !== "equal");
    const covered = changedPieces
      .map((c) => (c.op === "replace" ? `${c.oldText}→${c.text}` : c.text))
      .join("|");
    expect(covered).toContain("鲁棒");
    expect(covered).toContain("安全");
    // unchanged prefix stays out of the change region
    expect(covered).not.toContain("该方法");
    expect(changedPieces.every((c) => (c.oldText ?? "").length + c.text.length <= 8)).toBe(true);
  });

  it("detects the addition of 轻量级", () => {
    const result = diffDocuments("我们提出一种联邦学习方法。", "我们提出一种轻量级联邦学习方法。");
    const changed = result.blocks.filter((b) => b.status === "changed");
    expect(changed).toHaveLength(1);
    const added = (changed[0].changes ?? []).filter((c) => c.op === "insert" || c.op === "replace");
    const text = added.map((c) => c.text).join("");
    expect(text).toContain("轻量级");
  });
});

describe("Mixed-language diff (TEST_PLAN §8)", () => {
  it("keeps FedContra atomic and 安全 as the main addition", () => {
    const result = diffDocuments(
      "我们使用 FedContra 对 global model 进行修复。",
      "我们使用 FedContra 对 global model 进行安全修复。",
    );
    const changed = result.blocks.filter((b) => b.status === "changed");
    expect(changed).toHaveLength(1);
    const changes = changed[0].changes ?? [];
    // FedContra must be an unchanged token
    const fedTokens = changes.filter((c) => c.op === "equal" && c.text.includes("FedContra"));
    expect(fedTokens).toHaveLength(1);
    const tokens = (changes.flatMap((c) => [c.text, c.oldText ?? ""]).join("") + "");
    expect(tokens).toContain("global");
    expect(tokens).toContain("model");
    const added = changes.filter((c) => c.op !== "equal").map((c) => c.text + (c.oldText ?? "")).join("");
    expect(added).toContain("安全");
  });
});

describe("Formula token diff (TEST_PLAN §9)", () => {
  it("shows \\lambda → \\alpha as one token replacement", () => {
    const result = diffDocuments(
      "$$\nL = L_{task} + \\lambda L_{contra}\n$$",
      "$$\nL = L_{task} + \\alpha L_{contra}\n$$",
    );
    const changed = result.blocks.filter((b) => b.status === "changed");
    expect(changed).toHaveLength(1);
    const changes = changed[0].changes ?? [];
    const replacements = changes.filter((c) => c.op === "replace");
    expect(replacements).toHaveLength(1);
    expect(replacements[0].oldText).toBe("\\lambda");
    expect(replacements[0].text).toBe("\\alpha");
  });

  it("tokenizes control sequences atomically", () => {
    const tokens = tokenizeFormula("L = L_{task} + \\lambda L_{contra}").filter((t) => t.type !== "space");
    expect(tokens.map((t) => t.text)).toContain("\\lambda");
    expect(tokens.map((t) => t.text)).toContain("_");
    expect(tokens.map((t) => t.text)).toContain("+");
  });
});

describe("Diff settings", () => {
  it("ignoreWhitespace treats reflowed text as equal", () => {
    const result = diffDocuments("hello world", "hello  world", "markdown", {
      ignoreWhitespace: true,
    });
    expect(result.blocks.every((b) => b.status === "equal")).toBe(true);
    const strict = diffDocuments("hello world", "hello  world", "markdown", {
      ignoreWhitespace: false,
    });
    expect(strict.stats.changed + strict.stats.added + strict.stats.removed).toBeGreaterThan(0);
  });

  it("case sensitivity is configurable", () => {
    const equal = diffDocuments("Model", "model", "markdown", { caseSensitive: false });
    expect(equal.stats.changed).toBe(0);
    const strict = diffDocuments("Model", "model", "markdown", { caseSensitive: true });
    expect(strict.stats.changed).toBe(1);
  });
});

describe("Structural diff", () => {
  it("reports added/removed blocks", () => {
    const result = diffDocuments("# A\n\npara one", "# A\n\npara one\n\npara two");
    expect(result.stats.added).toBe(1);
    expect(result.blocks[result.blocks.length - 1].type).toBe("paragraph");
  });

  it("carries deleted text on pure deletions (regression)", () => {
    const result = diffDocuments("A good thing", "A");
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    const deletions = (changed?.changes ?? []).filter((c) => c.op === "delete");
    const text = deletions.map((c) => c.text).join(" ");
    expect(text).toContain("good");
    expect(text).toContain("thing");
  });

  it("carries deleted text when words are removed from Chinese prose (regression)", () => {
    const result = diffDocuments("该方法显著提高模型的鲁棒性和安全性。", "该方法显著提高模型的鲁棒性。");
    const changed = result.blocks.find((b) => b.status === "changed");
    const deletions = (changed?.changes ?? []).filter((c) => c.op === "delete").map((c) => c.text).join("");
    expect(deletions.length).toBeGreaterThan(0);
  });

  it("mixed CJK/Latin segmentation produces word tokens", () => {
    const tokens = tokenizeText("我们使用 FedContra 对 global model 进行修复。");
    const texts = tokens.map((t) => t.text);
    expect(texts).toContain("FedContra");
    expect(texts).toContain("global");
    expect(texts.some((t) => t.includes("我"))).toBe(true);
    void changedText;
    void DEFAULT_DIFF_OPTIONS;
  });
});

// ---------------------------------------------------------------------------
// Hand-built IR helpers (diffDocumentsIR keeps these tests parser-independent)
// ---------------------------------------------------------------------------

const docOf = (children: ScholarBlockNode[]): ScholarDocument => ({ type: "document", children });

const paraBlock = (text: string): ParagraphNode => ({
  id: `p-${text}`,
  type: "paragraph",
  children: [{ id: `t-${text}`, type: "text", text }],
});

const mathBlock = (latex: string, environment?: MathEnvironment): MathNode => ({
  id: `m-${latex}-${environment ?? ""}`,
  type: "math",
  display: true,
  latex,
  ...(environment ? { environment } : {}),
});

const cell = (text: string, extra: Partial<TableCell> = {}): TableCell => ({
  content: [{ id: `c-${text}`, type: "text", text }],
  ...extra,
});

const shadow = (): TableCell => ({ content: [], rowSpanContinue: true });

const tableBlock = (rows: TableCell[][]): TableNode => ({ id: "tbl", type: "table", rows });

describe("Pure deletions keep their text (lcs early-return regression)", () => {
  it("citation-only replacement keeps the deleted prose (latex, ignoreCitations)", () => {
    const result = diffDocuments("Read Smith carefully.\n", "\\cite{smith2020}\n", "latex", {
      ignoreCitations: true,
    });
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    expect(changed?.type).toBe("paragraph");
    const deletions = (changed?.changes ?? []).filter((c) => c.op === "delete").map((c) => c.text).join("");
    expect(deletions).toContain("Read Smith");
  });

  it("fully deleted math body carries its old text", () => {
    const result = diffDocumentsIR(
      docOf([mathBlock("L = \\lambda L_{contra}")]),
      docOf([mathBlock("")]),
      DEFAULT_DIFF_OPTIONS,
    );
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    const deletions = (changed?.changes ?? []).filter((c) => c.op === "delete").map((c) => c.text).join("");
    expect(deletions).toContain("\\lambda");
    expect(deletions).toContain("L_{contra}");
  });
});

describe("Table rowSpan shadow handling", () => {
  it("detects a change after a shadow cell (raw-width scan)", () => {
    const oldTable = tableBlock([
      [cell("A", { rowSpan: 2 }), cell("B"), cell("C")],
      [shadow(), cell("D"), cell("E")],
    ]);
    const newTable = tableBlock([
      [cell("A", { rowSpan: 2 }), cell("B"), cell("C")],
      [shadow(), cell("D"), cell("E changed")],
    ]);
    const result = diffDocumentsIR(docOf([oldTable]), docOf([newTable]), DEFAULT_DIFF_OPTIONS);
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.status).toBe("changed");
    const changedCells = (table?.tableChanges ?? []).filter((c) => c.status === "changed");
    expect(changedCells).toHaveLength(1);
    expect(changedCells[0].col).toBe(2);
    expect(changedCells[0].oldText).toBe("E");
    expect(changedCells[0].newText).toBe("E changed");
  });

  it("identical rowSpan tables diff clean", () => {
    const rows: TableCell[][] = [
      [cell("A", { rowSpan: 2 }), cell("B"), cell("C")],
      [shadow(), cell("D"), cell("E")],
    ];
    const result = diffDocumentsIR(docOf([tableBlock(rows)]), docOf([tableBlock(rows)]), DEFAULT_DIFF_OPTIONS);
    expect(result.stats.changed).toBe(0);
    expect(result.stats.equal).toBe(1);
  });
});

describe("Large documents diff block-by-block (guard trimming)", () => {
  it("2100 blocks with one middle insertion: equal 2100, added 1", () => {
    const blocks = Array.from({ length: 2100 }, (_, i) => paraBlock(`p${i}`));
    const inserted = [...blocks.slice(0, 1050), paraBlock("inserted"), ...blocks.slice(1050)];
    const started = performance.now();
    const result = diffDocumentsIR(docOf(blocks), docOf(inserted), DEFAULT_DIFF_OPTIONS);
    const elapsed = performance.now() - started;
    expect(result.stats).toEqual({ equal: 2100, changed: 0, added: 1, removed: 0 });
    const added = result.blocks.filter((b) => b.status === "added");
    expect(added).toHaveLength(1);
    expect(added[0].newNode).toEqual(paraBlock("inserted"));
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("Table row alignment (LCS over row signatures)", () => {
  it("edited key cell stays paired: cell changed, not remove+add", () => {
    const result = diffDocuments(
      "| ID | Val |\n| -- | --- |\n| a1 | x |\n| b2 | y |",
      "| ID | Val |\n| -- | --- |\n| a9 | x |\n| b2 | y |",
    );
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.status).toBe("changed");
    const changes = table?.tableChanges ?? [];
    expect(changes.filter((c) => c.status === "changed")).toHaveLength(1);
    expect(changes.filter((c) => c.status === "removed")).toHaveLength(0);
    expect(changes.filter((c) => c.status === "added")).toHaveLength(0);
    const changed = changes.find((c) => c.status === "changed");
    expect(changed?.oldText).toBe("a1");
    expect(changed?.newText).toBe("a9");
  });

  it("appending a duplicate-key row adds one row and removes none", () => {
    const result = diffDocuments(
      "| H | V |\n| - | - |\n| k | 1 |\n| k | 2 |",
      "| H | V |\n| - | - |\n| k | 1 |\n| k | 2 |\n| k | 3 |",
    );
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.status).toBe("changed");
    const changes = table?.tableChanges ?? [];
    const added = changes.filter((c) => c.status === "added");
    expect(changes.filter((c) => c.status === "removed")).toHaveLength(0);
    expect(changes.filter((c) => c.status === "changed")).toHaveLength(0);
    expect(added).toHaveLength(2); // the appended row's two cells
    expect(added.every((c) => c.newRow === 3)).toBe(true);
  });

  it("all-numeric table: inserted top row adds without shifting the rest", () => {
    const result = diffDocuments(
      "| 1 |\n| - |\n| 2 |\n| 3 |",
      "| 0 |\n| - |\n| 1 |\n| 2 |\n| 3 |",
    );
    const table = result.blocks.find((b) => b.type === "table");
    const changes = table?.tableChanges ?? [];
    const added = changes.filter((c) => c.status === "added");
    expect(added).toHaveLength(1);
    expect(added[0].newText).toBe("0");
    expect(added[0].newRow).toBe(0);
    expect(added[0].oldRow).toBeUndefined();
    expect(changes.filter((c) => c.status === "removed")).toHaveLength(0);
    expect(changes.filter((c) => c.status === "changed")).toHaveLength(0);
    // the remaining rows stay equal and in place
    const equalRows = new Set(changes.filter((c) => c.status === "equal").map((c) => c.row));
    expect(equalRows).toEqual(new Set([1, 2, 3]));
  });

  it("reordered rows are reported as moves (removed + added), not silent equality", () => {
    const result = diffDocuments(
      "| H |\n| - |\n| a |\n| b |",
      "| H |\n| - |\n| b |\n| a |",
    );
    const table = result.blocks.find((b) => b.type === "table");
    expect(table?.status).toBe("changed");
    const changes = table?.tableChanges ?? [];
    expect(changes.filter((c) => c.status === "changed")).toHaveLength(0); // content is unchanged
    expect(changes.filter((c) => c.status === "removed")).toHaveLength(1);
    expect(changes.filter((c) => c.status === "added")).toHaveLength(1);
    expect(changes.find((c) => c.status === "removed")?.oldRow).toBeDefined();
  });

  it("removed rows report their old-table index", () => {
    const result = diffDocuments(
      "| 1 |\n| - |\n| 2 |\n| 3 |",
      "| 1 |\n| - |\n| 2 |",
    );
    const changes = result.blocks.find((b) => b.type === "table")?.tableChanges ?? [];
    const removed = changes.filter((c) => c.status === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].oldRow).toBe(2);
    expect(removed[0].row).toBe(2);
    expect(removed[0].newRow).toBeUndefined();
    expect(removed[0].oldText).toBe("3");
  });
});

describe("Heading level and math environment changes", () => {
  it("## Foo → ### Foo is a change, not equal", () => {
    const result = diffDocuments("## Foo", "### Foo");
    expect(result.stats.changed).toBe(1);
    expect(result.stats.equal).toBe(0);
    expect(result.blocks[0].type).toBe("heading");
  });

  it("aligned → gather with identical body is a change", () => {
    const result = diffDocumentsIR(
      docOf([mathBlock("x &= y", "align")]),
      docOf([mathBlock("x &= y", "gather")]),
      DEFAULT_DIFF_OPTIONS,
    );
    expect(result.stats.changed).toBe(1);
    expect(result.stats.equal).toBe(0);
  });
});

describe("Link targets always participate in the comparison", () => {
  it("detects a url retarget with unchanged alias", () => {
    const result = diffDocuments("see [text](a.md) now", "see [text](b.md) now");
    expect(result.stats.changed).toBe(1);
  });

  it("detects a wikilink retarget with unchanged alias", () => {
    const result = diffDocuments("see [[note-a|alias]] here", "see [[note-b|alias]] here");
    expect(result.stats.changed).toBe(1);
  });

  it("still detects a pure alias change", () => {
    const result = diffDocuments("see [one](a.md) now", "see [two](a.md) now");
    expect(result.stats.changed).toBe(1);
  });
});

describe("Lists and quotes get word-level changes", () => {
  it("- item two → - item TWO pinpoints the word change", () => {
    const result = diffDocuments("- item two", "- item TWO");
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    expect(changed?.type).toBe("list");
    const hits = (changed?.changes ?? []).filter((c) => c.op !== "equal");
    expect(hits.length).toBeGreaterThan(0);
    const rendered = hits.map((c) => `${c.oldText ?? ""}→${c.text}`).join("|");
    expect(rendered).toContain("two");
    expect(rendered).toContain("TWO");
  });

  it("quote edits populate changes too", () => {
    const result = diffDocuments("> old words here", "> new words here");
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    expect(changed?.type).toBe("quote");
    const hits = (changed?.changes ?? []).filter((c) => c.op !== "equal");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((c) => `${c.oldText ?? ""}${c.text}`).join("")).toContain("old");
  });
});

describe("Math whitespace-only reformatting is not a change", () => {
  it("a + b → a+b yields no whitespace-only changes", () => {
    const result = diffDocuments("$$\na + b\n$$", "$$\na+b\n$$");
    expect(result.stats.changed).toBe(0);
    expect(result.stats.equal).toBe(1);
  });

  it("\\lambda → \\alpha stays one replacement after whitespace filtering", () => {
    const result = diffDocuments(
      "$$\nL = \\lambda L_{contra}\n$$",
      "$$\nL = \\alpha L_{contra}\n$$",
    );
    const changed = result.blocks.find((b) => b.status === "changed");
    expect(changed).toBeDefined();
    const replacements = (changed?.changes ?? []).filter((c) => c.op === "replace");
    expect(replacements).toHaveLength(1);
    expect(replacements[0].oldText).toBe("\\lambda");
    expect(replacements[0].text).toBe("\\alpha");
  });
});
