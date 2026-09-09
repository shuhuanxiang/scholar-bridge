import { describe, expect, it } from "vitest";
import { scanFreshness } from "../../src/translation/freshness";
import { sourceHash, buildTranslationBlock, type ReinsertionInput } from "../../src/translation/reinsertion";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";

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

describe("Freshness scanning (TEST_PLAN §13)", () => {
  it("marks translation stale after one word changes in the source", () => {
    const source = "我们提出一种新的联邦学习防御方法。";
    const block = buildTranslationBlock(makeInput(source, "p_1", "We propose a new federated learning defense method."));
    const freshText = `# Title\n\n${source}\n\n${block}\n\n# Next\n`;
    const fresh = scanFreshness(freshText);
    expect(fresh.entries).toHaveLength(1);
    expect(fresh.entries[0].status).toBe("fresh");
    expect(fresh.staleEntries).toHaveLength(0);

    const editedSource = "我们提出一种新的联邦学习**防御**方法。".replace("**防御**", "攻击");
    const stale = scanFreshness(`# Title\n\n${editedSource}\n\n${block}\n\n# Next\n`);
    expect(stale.entries[0].status).toBe("stale");
    expect(stale.staleEntries).toHaveLength(1);
    expect(stale.staleEntries[0].sourceRaw).toBe(editedSource);
  });

  it("recovers multi-line sources and skips adjacent translation blocks", () => {
    const s1 = "第一段。\n第二行。";
    const s2 = "第二段。";
    const b1 = buildTranslationBlock(makeInput(s1, "p_1", "First paragraph."));
    const b2 = buildTranslationBlock(makeInput(s2, "p_2", "Second paragraph."));
    const text = [s1, "", b1, "", s2, "", b2].join("\n");
    const report = scanFreshness(text);
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].sourceRaw).toBe(s1);
    expect(report.entries[1].sourceRaw).toBe(s2);
    expect(report.entries.every((e) => e.status === "fresh")).toBe(true);
  });

  it("recovers true sources from back-to-back replace-mode blocks (regression)", () => {
    // Replace layout: each block's end marker is immediately followed by the
    // next start. Walking upward from block 2 must skip the whole previous
    // block — the old bug recovered the previous TRANSLATED text as the
    // "source", producing a false stale and a re-translation cascade.
    const s1 = "第一段的原文。";
    const s2 = "第二段的原文。";
    const b1 = buildTranslationBlock(makeInput(s1, "p_1", "First translation."));
    const b2 = buildTranslationBlock(makeInput(s2, "p_2", "Second translation."));
    const text = [s1, b1, b2].join("\n");
    const report = scanFreshness(text);
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].sourceRaw).toBe(s1);
    expect(report.entries[0].status).toBe("fresh");
    expect(report.entries[1].sourceRaw).not.toBe("First translation.");
    expect(report.entries[1].sourceRaw).toBe(s1);

    // The replace-apply path stores the hash of the recovered source, so the
    // next scan is fresh — no cascade.
    const b2Refilled = buildTranslationBlock(makeInput(s1, "p_2", "Second translation."));
    const rescan = scanFreshness([s1, b1, b2Refilled].join("\n"));
    expect(rescan.entries[1].sourceRaw).toBe(s1);
    expect(rescan.entries[1].status).toBe("fresh");
    expect(rescan.staleEntries).toHaveLength(0);
  });

  it("an unclosed start marker does not swallow later blocks", () => {
    const block = buildTranslationBlock(makeInput("有效原文。", "p_2", "Valid translation."));
    const note = [
      "<!-- scholarbridge:translation:start",
      '{"sourceNodeId": "p_bad", broken json without a closing comment',
      ...block.split("\n"),
    ].join("\n");
    const report = scanFreshness(note);
    const entry = report.entries.find((e) => e.sourceNodeId === "p_2");
    expect(entry).toBeDefined();
    // The garbage line above the valid block is (wrongly) recovered as its
    // source, so the block is reported — as stale, not lost.
    expect(entry?.status).toBe("stale");

    // Unclosed marker at EOF: no crash, no phantom entries.
    expect(scanFreshness("<!-- scholarbridge:translation:start\n{broken").entries).toHaveLength(0);
  });

  it("skips scholarbridge metadata comments when recovering the source (regression)", () => {
    const source = "你好。";
    const block = buildTranslationBlock(makeInput(source, "p_1", "Hello."));
    const note = [
      source,
      "",
      "<!-- scholarbridge",
      '{"schemaVersion":1,"type":"math","label":"eq:x"}',
      "-->",
      "",
      block,
    ].join("\n");
    const report = scanFreshness(note);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].sourceRaw).toBe(source);
    expect(report.entries[0].status).toBe("fresh");
  });

  it("reports orphan translations without a recoverable source", () => {
    const block = buildTranslationBlock(makeInput("something", "p_1", "Translation."));
    const report = scanFreshness(`${block}`);
    expect(report.entries[0].status).toBe("orphan");
    expect(report.staleEntries).toHaveLength(0);
  });

  it("round trip: inserted translation scanned from written document", () => {
    const source = "我们提出一种新的联邦学习防御方法。";
    const block = buildTranslationBlock(makeInput(source, "p_14", "We propose a new federated learning defense method."));
    const doc = parseMarkdown(`${source}\n\n${block}\n`);
    const md = writeMarkdown(doc);
    const report = scanFreshness(md);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].status).toBe("fresh");
    expect(report.entries[0].sourceNodeId).toBe("p_14");
  });

  it("sourceHash matches the stored metadata hash format", () => {
    const source = "hello world";
    const block = buildTranslationBlock(makeInput(source, "p_1", "hallo Welt"));
    expect(block).toContain(`"sourceHash":"${sourceHash(source)}"`);
  });
});
