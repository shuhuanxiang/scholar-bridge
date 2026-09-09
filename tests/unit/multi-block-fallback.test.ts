import { describe, expect, it, vi } from "vitest";
import { translateBlocks, TranslationValidationError } from "../../src/translation/translator";
import { ProviderError, type TranslationProvider } from "../../src/translation/provider";
import type { TranslationCache } from "../../src/translation/cache";

/**
 * Multi-block batches are validated all-or-nothing: one dropped id, one
 * unknown id, or one mangled placeholder rejects the entire chunk. Small
 * translation models drop ids precisely as the batch grows, so "translate
 * several paragraphs" failed while single paragraphs succeeded. The fix:
 * a failed multi-block chunk falls back to per-block requests. These tests
 * pin that fallback and the preserved single-block semantics.
 */

const opts = { sourceLanguage: "zh", targetLanguage: "en", style: "academic" };

const threeBlocks = [
  { nodeId: "b_1", type: "paragraph" as const, sourceText: "第一段。" },
  { nodeId: "b_2", type: "paragraph" as const, sourceText: "第二段。" },
  { nodeId: "b_3", type: "paragraph" as const, sourceText: "第三段。" },
];

const providerReturning = (
  respond: (req: { blocks: { id: string; text: string }[] }) => { blocks: { id: string; translation: string }[] },
  onCall?: () => void,
): TranslationProvider =>
  ({
    translate: async (req: any) => {
      onCall?.();
      return { ...respond(req.blocks), raw: "", model: "m" };
    },
  }) as unknown as TranslationProvider;

describe("multi-block validation fallback", () => {
  it("rescues a batch whose response dropped ids by retrying per block", async () => {
    let calls = 0;
    // Always answers with only the FIRST requested block: a valid single-block
    // response, but a batch response missing ids → validation error.
    const provider = providerReturning(
      (blocks) => ({ blocks: [{ id: blocks[0].id, translation: `T:${blocks[0].text}` }] }),
      () => {
        calls++;
      },
    );

    const res = await translateBlocks(provider, threeBlocks, opts);

    // 1 batch call + 3 per-block retries (the batch result is discarded).
    expect(calls).toBe(4);
    expect(res.problems).toBeUndefined();
    expect(res.blocks.map((b) => b.nodeId)).toEqual(["b_1", "b_2", "b_3"]);
    expect(res.blocks.every((b) => b.translation.startsWith("T:"))).toBe(true);
  });

  it("reports only the blocks that still fail per-block", async () => {
    const provider = providerReturning((blocks) =>
      blocks.length > 1 || blocks[0].text.includes("坏")
        ? { blocks: [{ id: "ghost_id", translation: "x" }] } // unknown id → invalid
        : { blocks: [{ id: blocks[0].id, translation: `OK:${blocks[0].text}` }] },
    );

    const res = await translateBlocks(
      provider,
      [
        threeBlocks[0],
        { nodeId: "b_2", type: "paragraph" as const, sourceText: "坏段落。" },
        threeBlocks[2],
      ],
      opts,
    );

    expect(res.blocks.map((b) => b.nodeId)).toEqual(["b_1", "b_3"]);
    expect(res.problems).toHaveLength(1);
    expect(res.problems?.[0]).toContain("b_2");
  });

  it("keeps the single-block contract: a failed lone block throws", async () => {
    const provider = providerReturning(() => ({ blocks: [] }));
    await expect(
      translateBlocks(provider, [threeBlocks[0]], opts),
    ).rejects.toThrow(TranslationValidationError);
  });

  it("does not spin per-block retries for transport errors", async () => {
    let calls = 0;
    const provider = {
      translate: async () => {
        calls++;
        throw new ProviderError("unavailable", "server down");
      },
    } as unknown as TranslationProvider;

    await expect(
      translateBlocks(provider, threeBlocks, opts), // one chunk of 3 → throws
    ).rejects.toThrow("server down");
    expect(calls).toBe(1);
  });

  it("caches per-block fallback results and fires the persist hook", async () => {
    const put = vi.fn();
    const cache = { get: () => undefined, put } as unknown as TranslationCache;
    const onCacheDirty = vi.fn();
    // Same drop-ids model as above: batch fails, singles succeed.
    const provider = providerReturning((blocks) => ({
      blocks: [{ id: blocks[0].id, translation: `T:${blocks[0].text}` }],
    }));

    const res = await translateBlocks(provider, threeBlocks, {
      ...opts,
      cache,
      onCacheDirty,
    });

    expect(res.problems).toBeUndefined();
    expect(put).toHaveBeenCalledTimes(3);
    expect(onCacheDirty).toHaveBeenCalledTimes(1);
  });
});
