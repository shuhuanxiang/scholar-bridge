import { describe, expect, it } from "vitest";
import { cacheKey, TranslationCache, CACHE_MAX_ENTRIES } from "../../src/translation/cache";

const base = {
  sourceText: "我们提出一种新的联邦学习防御方法。",
  sourceLanguage: "zh",
  targetLanguage: "en",
  style: "academic",
  modelIdentity: "models/qwen.gguf",
  promptVersion: "p1",
  glossaryVersion: "g1",
};

describe("cache key (R3 P3-2: dual-lane 64-bit hash)", () => {
  it("is stable for identical ingredients", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });

  it("distinguishes every key ingredient", () => {
    const variants = [
      { ...base, sourceText: base.sourceText + "。" },
      { ...base, sourceLanguage: "en", targetLanguage: "zh" },
      { ...base, style: "plain" },
      { ...base, temperature: 0.7 },
      { ...base, modelIdentity: "models/other.gguf" },
      { ...base, promptVersion: "p2" },
      { ...base, glossaryVersion: "g2" },
    ];
    const keys = new Set([cacheKey(base), ...variants.map((v) => cacheKey(v))]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it("stays sensitive on long sources (no truncation at one lane's width)", () => {
    const long = "联邦学习安全研究。".repeat(2000); // 18k chars
    const a = cacheKey({ ...base, sourceText: long });
    const b = cacheKey({ ...base, sourceText: long + "差异" });
    expect(a).not.toBe(b);
  });

  it("treats an undefined temperature as its own bucket, distinct from 0", () => {
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, temperature: undefined }),
      cacheKey({ ...base, temperature: 0 }),
    ]);
    expect(keys.size).toBe(2);
  });
});

describe("TranslationCache LRU bound", () => {
  it("evicts the least-recently-used entry past the bound", () => {
    const cache = new TranslationCache();
    for (let i = 0; i < CACHE_MAX_ENTRIES; i++) cache.put(`k${i}`, `v${i}`);
    cache.get("k0"); // refresh k0 → k1 is now the LRU victim
    cache.put("new", "vnew");
    expect(cache.get("k0")).toBe("v0");
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("new")).toBe("vnew");
  });

  it("round-trips through JSON and drops non-string garbage", () => {
    const cache = new TranslationCache();
    cache.put("a", "甲");
    const restored = TranslationCache.fromJSON({
      version: 1,
      entries: { ...cache.toJSON().entries, bad: 42 as unknown as string },
    });
    expect(restored.get("a")).toBe("甲");
    expect(restored.size).toBe(1);
  });
});
