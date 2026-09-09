import { describe, expect, it } from "vitest";
import { diffDocuments } from "../../src/diff/structural-diff";
import {
  applyAcceptedChanges,
  applyAcceptedChangesToLines,
} from "../../src/diff/diff-apply";

const changedIndex = (blocks: ReturnType<typeof diffDocuments>["blocks"]) =>
  blocks.findIndex((b) => b.status === "changed");
const firstIndex = (blocks: ReturnType<typeof diffDocuments>["blocks"], status: string) =>
  blocks.findIndex((b) => b.status === status);

describe("diff apply: changed paragraphs (v0.3 accept/reject)", () => {
  it("applies an accepted word-level change to the old note", () => {
    const old = "第一段保持不变。\n\n该方法显著提高模型的鲁棒性。\n\n结尾段不动。";
    const neu = "第一段保持不变。\n\n该方法显著提高模型的安全性。\n\n结尾段不动。";
    const d = diffDocuments(old, neu);
    const i = changedIndex(d.blocks);
    expect(i).toBeGreaterThanOrEqual(0);

    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.skipped).toHaveLength(0);
    expect(res.text).toContain("安全性");
    expect(res.text).not.toContain("鲁棒性");
    // untouched neighbours stay byte-identical
    expect(res.text).toContain("第一段保持不变。");
    expect(res.text).toContain("结尾段不动。");
  });

  it("keeps everything verbatim when the change is rejected", () => {
    const old = "A 段。\n\n该方法显著提高模型的鲁棒性。";
    const neu = "A 段。\n\n该方法显著提高模型的安全性。";
    const d = diffDocuments(old, neu);
    const res = applyAcceptedChanges(old, d.blocks, new Set());
    expect(res.text).toBe(old);
    expect(res.applied).toHaveLength(0);
  });

  it("applies only the accepted one of several changes", () => {
    const old = "_alpha_ 段落。\n\n第二段内容甲。\n\n第三段内容乙。";
    const neu = "_alpha_ 段落。\n\n第二段内容丙。\n\n第三段内容丁。";
    const d = diffDocuments(old, neu);
    const changed = d.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.status === "changed");
    expect(changed).toHaveLength(2);
    const res = applyAcceptedChanges(old, d.blocks, new Set([changed[0].i]));
    expect(res.applied).toEqual([changed[0].i]);
    expect(res.text).toContain("内容丙");
    expect(res.text).toContain("内容乙"); // rejected change stays old
  });
});

describe("diff apply: added and removed blocks", () => {
  it("inserts an accepted added block after its preceding neighbour", () => {
    const old = "开头段。";
    const neu = "开头段。\n\n新插入的段落。";
    const d = diffDocuments(old, neu);
    const i = firstIndex(d.blocks, "added");
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.applied).toEqual([i]);
    expect(res.text).toBe("开头段。\n\n新插入的段落。");
  });

  it("deletes an accepted removed block", () => {
    const old = "保留段。\n\n被删除的段。";
    const neu = "保留段。";
    const d = diffDocuments(old, neu);
    const i = firstIndex(d.blocks, "removed");
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.text).toBe("保留段。");
    expect(res.text).not.toContain("被删除的段");
  });

  it("reports a skip instead of guessing when the old block cannot be located", () => {
    // The old node's serialized form ("Hello world") does not appear in the
    // old document (hand-edited to something else) — the change must be
    // skipped, never approximated.
    const old = " completely unrelated content ";
    const doc = diffDocuments("Hello world", "Hello brave world");
    // Feed a mismatched "old" text on purpose: block cannot be located.
    const res = applyAcceptedChanges(old, doc.blocks, new Set([0]));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped.length > 0 || doc.blocks[0].status === "added").toBe(true);
  });
});

describe("diff apply: formulas and multi-line collapse", () => {
  it("applies an accepted formula change and keeps the metadata comment", () => {
    const old = "$$\n\\lambda + 1\n$$\n\n<!-- scholarbridge\n{\n  \"schemaVersion\": 1,\n  \"type\": \"math\"\n}\n-->";
    const neu = "$$\n\\alpha + 1\n$$\n\n<!-- scholarbridge\n{\n  \"schemaVersion\": 1,\n  \"type\": \"math\"\n}\n-->";
    const d = diffDocuments(old, neu);
    const i = changedIndex(d.blocks);
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.skipped).toHaveLength(0);
    expect(res.text).toContain("\\alpha");
    expect(res.text).not.toContain("\\lambda");
  });

  it("matches a one-line $$…$$ formula against the three-line serialization", () => {
    const lines = ["before", "$$x=y$$", "after"];
    const old = lines.join("\n");
    const neu = "before\n\n$$\nx=z\n$$\n\nafter";
    const d = diffDocuments(old, neu);
    const i = changedIndex(d.blocks);
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChangesToLines(lines, d.blocks, new Set([i]));
    expect(res.skipped).toHaveLength(0);
    expect(res.text.split("\n")).toContain("x=z");
  });
});

describe("diff apply: insertion ordering with several adds", () => {
  it("inserts two accepted added blocks in document order", () => {
    const old = "锚点段。";
    const neu = "新增一。\n\n锚点段。\n\n新增二。";
    const d = diffDocuments(old, neu);
    const adds = d.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.status === "added");
    expect(adds).toHaveLength(2);
    const res = applyAcceptedChanges(old, d.blocks, new Set(adds.map((a) => a.i)));
    expect(res.applied.length).toBe(2);
    expect(res.text.indexOf("新增一")).toBeLessThan(res.text.indexOf("锚点段。"));
    expect(res.text.indexOf("锚点段。")).toBeLessThan(res.text.indexOf("新增二"));
  });
});

describe("diff apply: pattern-size budgets (R3 P3-5)", () => {
  const manyLines = (n: number, marker = "行"): string =>
    Array.from({ length: n }, (_, i) => `${marker}${i + 1} 内容`).join("\n");

  it("still matches a large block element-wise (collapse fallback is size-gated, not required)", () => {
    // 40 serialized lines: above MAX_COLLAPSE_PATTERN, so only the
    // element-wise match may hit — and it must.
    const old = manyLines(40);
    const neu = manyLines(40).replace("行20 内容", "行20 已修改");
    const d = diffDocuments(old, neu);
    const i = changedIndex(d.blocks);
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.skipped).toHaveLength(0);
    expect(res.text).toContain("行20 已修改");
  });

  it("skips a pattern beyond MAX_PATTERN_LINES instead of scanning unbounded", () => {
    const old = manyLines(2001);
    const neu = manyLines(2001).replace("行1000 内容", "行1000 已修改");
    const d = diffDocuments(old, neu);
    const i = changedIndex(d.blocks);
    expect(i).toBeGreaterThanOrEqual(0);
    const res = applyAcceptedChanges(old, d.blocks, new Set([i]));
    expect(res.applied).toHaveLength(0);
    expect(res.skipped.map((s) => s.index)).toEqual([i]);
    expect(res.text).toBe(old); // nothing was touched
  });
});
