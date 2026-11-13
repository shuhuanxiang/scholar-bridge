import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import { parseLatex, parseMarkdown } from "../../src/core/parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import { writeLatexArticle, writeLatexFragment } from "../../src/core/writer/latex/latex-writer";
import { buildTranslationBlock, buildTranslationMeta, applyToLines, type ReinsertionInput } from "../../src/translation/reinsertion";
import { encodeTranslationStart, encodeTranslationEnd } from "../../src/core/ir/metadata";
import { scanFreshness } from "../../src/translation/freshness";
import { protectBlock, restorePlaceholders, validateProtection } from "../../src/translation/protector";
import { translateBlocks } from "../../src/translation/translator";
import { TranslationCache } from "../../src/translation/cache";
import { LlamaClient } from "../../src/translation/llama/client";
import { diffDocuments } from "../../src/diff/structural-diff";
import { applyAcceptedChanges } from "../../src/diff/diff-apply";
import type { TranslationProvider, TranslationRequest } from "../../src/translation/provider";
import { SettingsSaveQueue } from "../../src/settings/save-queue";

const input = (raw = "Original.", translation = "Translated."): ReinsertionInput => ({
  nodeId: "p_1", translation, range: { raw, startLine: 0, endLine: 0 },
  meta: { sourceLanguage: "en", targetLanguage: "zh", model: "test", glossaryVersion: "g", promptVersion: "v1" },
});
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (file: string) => readFileSync(join(here, "../fixtures", file), "utf8");
const opts = { sourceLanguage: "en", targetLanguage: "zh", style: "academic" };
const echo: TranslationProvider = {
  health: async () => true,
  translate: async (request) => ({
    blocks: request.blocks.map((block) => ({ id: block.id, translation: block.text })),
    raw: "", model: "test",
  }),
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("review: complete translation boundaries and source recovery", () => {
  it("never makes the document tail writable when an end marker is missing", () => {
    const block = buildTranslationBlock(input()).replace("\n" + encodeTranslationEnd(), "");
    const text = `Changed.\n\n${block}\n\n# Unrelated\nKeep everything.`;
    const report = scanFreshness(text);
    expect(report.entries).toEqual([]);
    expect(report.invalidStartLines).toEqual([2]);
    expect(writeMarkdown(parseMarkdown(text))).toContain("Keep everything.");
  });

  it("does not match a damaged outer start with a later block's end", () => {
    const bad = buildTranslationBlock(input()).replace("\n" + encodeTranslationEnd(), "");
    const good = buildTranslationBlock({ ...input("Good."), nodeId: "p_2" });
    const text = `Changed.\n\n${bad}\n\nGood.\n\n${good}`;
    expect(scanFreshness(text).entries.map((entry) => entry.sourceNodeId)).toEqual(["p_2"]);
    expect(parseMarkdown(text).children.filter((node) => node.type === "translation-block")).toHaveLength(1);
  });

  it("ignores markers inside either kind of code fence", () => {
    for (const fence of ["```", "~~~~"]) {
      const text = `Source.\n\n${fence}md\n${buildTranslationBlock(input())}\n${fence}`;
      expect(scanFreshness(text).entries).toEqual([]);
    }
  });

  it("preserves translation-body formatting exactly", () => {
    const text = "First.\n\n```python\nx = 1\n\nx += 1\n```\n\n| A |\n|---|\n| B |";
    const block = buildTranslationBlock(input("Original.", text));
    const parsed = parseMarkdown(block).children[0];
    expect(parsed.type === "translation-block" && parsed.text).toBe(text);
  });

  it("never treats a replacement's preceding paragraph as its missing source", () => {
    const block = buildTranslationBlock(input(), "replace");
    expect(scanFreshness(`Unrelated preceding paragraph.\n\n${block}`).entries[0].status).toBe("orphan");
  });

  it("recovers all changed source lines after a new line was inserted", () => {
    const block = buildTranslationBlock(input("First.\nSecond."));
    const report = scanFreshness(`# Heading\nFirst changed.\nInserted.\nSecond.\n\n${block}`);
    expect(report.staleEntries[0].sourceRaw).toBe("First changed.\nInserted.\nSecond.");
  });

  it("recovers legacy suffix sources without quadratic hashing", () => {
    const meta = buildTranslationMeta(input("Source."));
    delete meta.sourceLineCount;
    delete meta.writeMode;
    const text = `${"prefix line\n".repeat(10000)}Source.\n${encodeTranslationStart(meta)}\nTranslated.\n${encodeTranslationEnd()}`;
    const start = performance.now();
    expect(scanFreshness(text).entries[0].status).toBe("fresh");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("review: selective diff application", () => {
  it("does not apply rejected additions alongside an accepted edit", () => {
    const old = "Original.\n\nAnchor.";
    const diff = diffDocuments(old, "Changed.\n\nAnchor.\n\nRejected.");
    const index = diff.blocks.findIndex((block) => block.status === "changed");
    const result = applyAcceptedChanges(old, diff.blocks, new Set([index]));
    expect(result.text).toBe("Changed.\n\nAnchor.");
    expect(result.applied).toEqual([index]);
  });

  it.each([
    ["A.\n\nB.", "A.\n\nX.\n\nB."],
    ["A.\n\nB.", "X.\n\nA.\n\nB."],
    ["A.\n\nB.", "A.\n\nB.\n\nX."],
    ["A.\n\nB.", "A.\n\nX.\n\nY.\n\nB."],
  ])("preserves both block boundaries when adding to %s", (old, next) => {
    const diff = diffDocuments(old, next);
    const accepted = new Set(diff.blocks.flatMap((block, index) => block.status === "added" ? [index] : []));
    expect(applyAcceptedChanges(old, diff.blocks, accepted).text).toBe(next);
  });

  it("preserves trailing blank lines when every change is rejected", () => {
    const old = "Original.\n\n\n";
    expect(applyAcceptedChanges(old, diffDocuments(old, "Changed."), new Set()).text).toBe(old);
  });

  it("detects caption-only edits for figures, tables and algorithms", () => {
    const figure = diffDocuments("![Old claim](plot.png)", "![Corrected claim](plot.png)");
    expect(figure.stats.changed).toBe(1);
    const old = "\\begin{table}\\caption{Old}\\begin{tabular}{l}A\\\\\\end{tabular}\\end{table}";
    const table = diffDocuments(old, old.replace("{Old}", "{New}"), "latex");
    expect(table.stats.changed).toBe(1);
    const algorithm = "\\begin{algorithm}\\caption{Old}\\begin{algorithmic}\n\\STATE x\n\\end{algorithmic}\\end{algorithm}";
    expect(diffDocuments(algorithm, algorithm.replace("{Old}", "{New}"), "latex").stats.changed).toBe(1);
  });
});

describe("review: lossless conversion and complete exports", () => {
  it("round-trips unknown inline commands, optional arguments and citations", () => {
    const source = fixture("latex/inline_preservation.tex");
    const output = writeLatexFragment(parseMarkdown(writeMarkdown(parseLatex(source))));
    expect(output).toContain("\\custom{one}{two}");
    expect(output).toContain("\\custom*[width=2]{outer {inner}}{next}");
    expect(output).toContain("\\citep[see][p.~5]{key}");
    expect(output).toContain("\\custom{a --> b}");
    expect(output).toContain("$E=mc^2$");
  });

  it("respects edits to visible raw-command spans instead of restoring stale metadata", () => {
    const markdown = writeMarkdown(parseLatex("Keep \\custom{x}."));
    const edited = markdown.replace("`\\custom{x}`", "`edited code`");
    const output = writeLatexFragment(parseMarkdown(edited));
    expect(output).toContain("\\texttt{edited code}");
    expect(output).not.toContain("\\custom{x}");
  });

  it("keeps both single-line and multi-line bracket formulas separate from prose", () => {
    const doc = parseMarkdown(fixture("markdown/bracket_math.md"));
    expect(doc.children.map((node) => node.type)).toEqual(["math", "paragraph", "math", "paragraph"]);
    expect(doc.children[0].type === "math" && doc.children[0].latex).toBe("x=y");
    expect(writeLatexFragment(doc)).toContain("Keep the final paragraph.");
  });

  it("keeps unterminated bracket input verbatim", () => {
    const source = "\\[x=y\n\nKeep this paragraph.";
    expect(writeLatexFragment(parseMarkdown(source))).toContain(source);
  });

  it("recognizes parenthesis-delimited LaTeX inline math", () => {
    const doc = parseLatex("Energy \\(E=mc^2\\) here.");
    expect(doc.children[0].type === "paragraph" && doc.children[0].children[1]).toMatchObject({
      type: "inline-math", latex: "E=mc^2",
    });
  });

  it("keeps multirow continuations within the declared column count", () => {
    const doc = parseLatex(fixture("latex/table_multirow.tex"));
    const table = doc.children[0];
    expect(table.type === "table" && table.rows.map((row) => row.length)).toEqual([5, 5, 5]);
    const roundTrip = writeLatexFragment(parseMarkdown(writeMarkdown(doc)));
    expect(roundTrip).toContain(" & Acc & 71.2 & 73.5 & 75.1");
    expect(roundTrip).not.toContain(" &  & Acc");
  });

  it("exports replacement prose but omits inserted annotation prose", () => {
    const replacement = applyToLines(["Original."], input("Original.", "Translated prose."), "replace").join("\n");
    expect(writeLatexFragment(parseMarkdown(replacement))).toContain("Translated prose.");
    const inserted = applyToLines(["Original."], input("Original.", "Annotation."), "insert-below").join("\n");
    expect(writeLatexFragment(parseMarkdown(inserted))).toBe("Original.\n");
  });

  it("retains legacy translation text whose write mode is unknown", () => {
    const meta = buildTranslationMeta(input());
    delete meta.writeMode;
    const text = `${encodeTranslationStart(meta)}\nOnly surviving prose.\n${encodeTranslationEnd()}`;
    expect(writeLatexFragment(parseMarkdown(text))).toContain("Only surviving prose.");
  });

  it("omits a legacy annotation when the preceding original source still matches", () => {
    const meta = buildTranslationMeta(input());
    delete meta.writeMode;
    const text = `Original.\n\n${encodeTranslationStart(meta)}\nAnnotation.\n${encodeTranslationEnd()}`;
    expect(writeLatexFragment(parseMarkdown(text))).toBe("Original.\n");
  });

  it("includes packages required by nested code and math in exported translations", () => {
    const text = "```python\nprint(1)\n```\n\n$$\nx=y\n$$";
    const article = writeLatexArticle(parseMarkdown(buildTranslationBlock(input("Original.", text), "replace")));
    expect(article).toContain("\\usepackage{amsmath}");
    expect(article).toContain("\\usepackage{listings}");
    const align = writeLatexArticle(parseLatex("\\begin{align}x&=y\\end{align}"));
    expect(align).toContain("\\usepackage{amsmath}");
  });
});

describe("review: protection, terminology and long paragraphs", () => {
  it.each([
    'Use `print("$x$")` here.',
    "Use ``value `nested` and $x$`` here.",
    "Use `literal ⟦MATH_001⟧ and $x$` here.",
  ])("protects an entire code span in %s", (text) => {
    const result = protectBlock(text);
    expect(result.protectedText).toBe("Use ⟦CODE_001⟧ here.");
    expect(validateProtection(result.protectedText, result.placeholders).ok).toBe(true);
    expect(restorePlaceholders(result.protectedText, result.placeholders)).toBe(text);
  });

  it("sends relevant fixed glossary entries in the actual model prompt", async () => {
    const client = new LlamaClient({ baseUrl: "http://127.0.0.1:8080", model: "test" });
    const chat = vi.spyOn(client, "chat").mockResolvedValue({
      content: '{"blocks":[{"id":"p_1","translation":"A fixed network."}]}', model: "test",
    });
    await translateBlocks(client, [{ nodeId: "p_1", type: "paragraph", sourceText: "A neural network." }], {
      ...opts, glossary: { "neural network": "FIXED_NETWORK", unused: "UNUSED" },
    });
    expect(JSON.stringify(chat.mock.calls[0][0])).toContain("FIXED_NETWORK");
    expect(JSON.stringify(chat.mock.calls[0][0])).not.toContain("UNUSED");
  });

  it("splits a long paragraph, reassembles it and caches only the whole result", async () => {
    const requests: TranslationRequest[] = [];
    const provider = { ...echo, translate: vi.fn(async (request: TranslationRequest) => {
      requests.push(request);
      return echo.translate(request);
    }) };
    const cache = new TranslationCache();
    const text = "word ".repeat(80).trim();
    const result = await translateBlocks(provider, [{ nodeId: "long", type: "paragraph", sourceText: text }], {
      ...opts, cache, chunkCharBudget: 60,
    });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.blocks.reduce((size, block) => size + block.text.length, 0) <= 60)).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].translation).toBe(text);
    expect(cache.size).toBe(1);
    await translateBlocks(provider, [{ nodeId: "long", type: "paragraph", sourceText: text }], {
      ...opts, cache, chunkCharBudget: 60,
    });
    expect(provider.translate).toHaveBeenCalledTimes(requests.length);
  });

  it("keeps placeholders complete and accounts for repeated terms per fragment", async () => {
    const text = "Transformer $x$ and ".repeat(20).trim();
    const result = await translateBlocks(echo, [{ nodeId: "long", type: "paragraph", sourceText: text }], {
      ...opts, chunkCharBudget: 70, glossary: { Transformer: "preserve" },
    });
    expect(result.blocks[0].translation).toBe(text);
  });

  it("does not return or cache a partially translated long paragraph", async () => {
    let calls = 0;
    const cache = new TranslationCache();
    const provider = { ...echo, translate: async (request: TranslationRequest) => {
      if (++calls === 2) return { blocks: [], raw: "", model: "test" };
      return echo.translate(request);
    } };
    const result = await translateBlocks(provider, [{
      nodeId: "long", type: "paragraph", sourceText: "word ".repeat(80),
    }], { ...opts, cache, chunkCharBudget: 60 });
    expect(result.blocks).toEqual([]);
    expect(result.problems?.length).toBeGreaterThan(0);
    expect(cache.size).toBe(0);
  });

  it("never splits a surrogate pair or stalls on a one-character budget", async () => {
    const result = await translateBlocks(echo, [{ nodeId: "unicode", type: "paragraph", sourceText: "\uD83D\uDE00x" }], {
      ...opts, chunkCharBudget: 1,
    });
    expect(result.blocks[0].translation).toBe("\uD83D\uDE00x");
  });
});

describe("review: settings persistence", () => {
  it("coalesces typing bursts into one save", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const queue = new SettingsSaveQueue(save, vi.fn());
    const first = queue.schedule();
    await vi.advanceTimersByTimeAsync(100);
    const second = queue.schedule();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("serializes writes and flushes pending edits without waiting for debounce", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const queue = new SettingsSaveQueue(save, vi.fn());
    const first = queue.schedule();
    const firstFlush = queue.flush();
    await Promise.resolve();
    const second = queue.schedule();
    const secondFlush = queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, firstFlush, secondFlush]);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports a failed write and still allows later saves", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const error = vi.fn();
    const queue = new SettingsSaveQueue(save, error);
    const first = queue.schedule();
    await queue.flush();
    await first;
    const second = queue.schedule();
    await queue.flush();
    await second;
    expect(error).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
