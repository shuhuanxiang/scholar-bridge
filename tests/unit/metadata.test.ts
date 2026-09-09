import { describe, expect, it } from "vitest";
import {
  decodeMetaComment,
  decodeTranslationStart,
  encodeMetaComment,
  encodeTranslationEnd,
  encodeTranslationStart,
  isTranslationEnd,
  stableStringify,
} from "../../src/core/ir/metadata";

describe("ScholarBridge metadata comments", () => {
  it("round-trips a meta comment deterministically", () => {
    const encoded = encodeMetaComment({
      type: "equation",
      environment: "equation",
      label: "eq:loss",
    });
    expect(encoded).toBe(
      '<!-- scholarbridge\n{"environment":"equation","label":"eq:loss","schemaVersion":1,"type":"equation"}\n-->',
    );
    const decoded = decodeMetaComment(encoded.slice(4, -4));
    expect(decoded).toEqual({
      schemaVersion: 1,
      type: "equation",
      environment: "equation",
      label: "eq:loss",
    });
  });

  it("serializes with sorted keys regardless of construction order", () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("returns null for malformed or foreign comments", () => {
    expect(decodeMetaComment("a normal html comment")).toBeNull();
    expect(decodeMetaComment("scholarbridge {not json")).toBeNull();
    expect(decodeMetaComment("scholarbridge []")).toBeNull();
  });

  it("round-trips translation metadata", () => {
    const meta = {
      schemaVersion: 1,
      sourceNodeId: "p_14",
      sourceLanguage: "zh",
      targetLanguage: "en",
      sourceHash: "abc123",
      model: "qwen2.5-7b",
      glossaryVersion: "g1",
      promptVersion: "p1",
      status: "fresh" as const,
    };
    const start = encodeTranslationStart(meta);
    expect(start).toContain("scholarbridge:translation:start");
    const decoded = decodeTranslationStart(start.slice(4, -4));
    expect(decoded).toEqual(meta);
    expect(isTranslationEnd(encodeTranslationEnd().slice(4, -4))).toBe(true);
    expect(encodeTranslationEnd()).toBe("<!-- scholarbridge:translation:end -->");
  });

  it("rejects translation start without a sourceNodeId", () => {
    expect(
      decodeTranslationStart('scholarbridge:translation:start {"schemaVersion":1}'),
    ).toBeNull();
  });
});
