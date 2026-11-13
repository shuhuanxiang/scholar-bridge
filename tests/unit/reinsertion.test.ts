import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import { encodeTranslationEnd, encodeTranslationStart } from "../../src/core/ir/metadata";
import {
  applyToLines,
  buildTranslationBlock,
  buildTranslationMeta,
  createTranslatedCopy,
  freshnessStatus,
  sourceHash,
  type ReinsertionInput,
} from "../../src/translation/reinsertion";

const input: ReinsertionInput = {
  nodeId: "p_14",
  translation: "We propose a new federated learning defense method.",
  range: { raw: "我们提出一种新的联邦学习防御方法。", startLine: 1, endLine: 1 },
  meta: {
    sourceLanguage: "zh",
    targetLanguage: "en",
    model: "qwen2.5-7b-instruct",
    glossaryVersion: "g_1",
    promptVersion: "v1",
  },
};

describe("Translation insertion (TEST_PLAN §12)", () => {
  it("insert below source preserves the source exactly and stores metadata", () => {
    const lines = ["# Intro", "我们提出一种新的联邦学习防御方法。", "", "Next paragraph."];
    const out = applyToLines(lines, input, "insert-below");
    const text = out.join("\n");

    expect(out).toContain("我们提出一种新的联邦学习防御方法。");
    expect(text).toContain("scholarbridge:translation:start");
    expect(text).toContain('"sourceNodeId":"p_14"');
    expect(text).toContain('"targetLanguage":"en"');
    expect(text).toContain('"model":"qwen2.5-7b-instruct"');
    expect(text).toContain('"promptVersion":"v1"');
    expect(text).toContain('"sourceHash":"' + sourceHash(input.range.raw) + '"');
    expect(text).toContain("\n> We propose a new federated learning defense method.\n");
    expect(text).toContain("scholarbridge:translation:end");
    expect(text).toContain("Next paragraph.");
  });

  it("quotes every translation line, including blank lines and existing quotes", () => {
    const translation = "First line.\nSecond line.\n\n> An existing quote.\n\n$x+y$";
    const block = buildTranslationBlock({ ...input, translation });
    expect(block).toContain("\n> First line.\n> Second line.\n>\n> > An existing quote.\n>\n> $x+y$\n");
    const doc = parseMarkdown(block);
    expect(doc.children[0]).toMatchObject({ type: "translation-block", text: translation });
    const written = writeMarkdown(doc);
    expect(written.trimEnd()).toBe(block);
    expect(written).not.toContain("> > First line.");
  });

  it("keeps legacy unquoted translation blocks unchanged", () => {
    const meta = buildTranslationMeta(input);
    delete meta.presentation;
    const text = "> Existing content.\n\nUnquoted content.";
    const block = `${encodeTranslationStart(meta)}\n${text}\n${encodeTranslationEnd()}`;
    const doc = parseMarkdown(block);
    expect(doc.children[0]).toMatchObject({ type: "translation-block", text });
    expect(writeMarkdown(doc).trimEnd()).toBe(block);
  });

  it.each(["replace", "bilingual"] as const)("keeps %s translation text unquoted", (mode) => {
    const block = buildTranslationBlock(input, mode);
    expect(block).toContain(`\n${input.translation}\n`);
    expect(block).not.toContain(`\n> ${input.translation}`);
  });

  it("replace mode swaps source for the translation block", () => {
    const lines = ["# Intro", "我们提出一种新的联邦学习防御方法。"];
    const out = applyToLines(lines, input, "replace");
    expect(out.join("\n")).not.toContain("我们提出一种新的联邦学习防御方法。\n\n<!--");
    expect(out).not.toContain("我们提出");
    expect(out.join("\n")).toContain("We propose a new federated");
  });

  it("translated copy replaces each block with its translation", () => {
    const lines = ["# Title", "第一段。", "", "第二段。"];
    const inputs: ReinsertionInput[] = [
      {
        ...input,
        nodeId: "p_1",
        translation: "First paragraph.",
        range: { raw: "第一段。", startLine: 1, endLine: 1 },
      },
      {
        ...input,
        nodeId: "p_2",
        translation: "Second paragraph.",
        range: { raw: "第二段。", startLine: 3, endLine: 3 },
      },
    ];
    const out = createTranslatedCopy(lines, inputs);
    expect(out).toEqual(["# Title", "First paragraph.", "", "Second paragraph."]);
  });

  it("round-trips through the markdown parser as a translation block", async () => {
    const { parseMarkdown } = await import("../../src/core/parser/markdown/markdown-parser");
    const block = buildTranslationBlock(input);
    const doc = parseMarkdown(`我们提出一种新的联邦学习防御方法。\n\n${block}\n\n之后的内容。`);
    const tr = doc.children.find((c) => c.type === "translation-block");
    expect(tr).toBeDefined();
    if (tr?.type !== "translation-block") return;
    expect(tr.text).toBe("We propose a new federated learning defense method.");
    expect(tr.meta.sourceNodeId).toBe("p_14");
  });
});

describe("Stale translation detection (TEST_PLAN §13)", () => {
  it("hash changes when one word changes", () => {
    const original = "我们提出一种新的联邦学习防御方法。";
    const edited = "我们提出一种新的联邦学习攻击方法。";
    const hash = sourceHash(original);
    expect(sourceHash(edited)).not.toBe(hash);
    expect(freshnessStatus(original, hash)).toBe("fresh");
    expect(freshnessStatus(edited, hash)).toBe("stale");
  });

  it("hash is stable under whitespace-only changes", () => {
    const a = "hello   world";
    const b = "hello world\n";
    expect(sourceHash(a)).toBe(sourceHash(b));
  });
});
