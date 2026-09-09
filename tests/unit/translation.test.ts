import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import {
  protectBlock,
  restorePlaceholders,
  validateProtection,
  relevantGlossary,
} from "../../src/translation/protector";
import {
  collectTranslatableBlocks,
  hasTranslatableProse,
  translateBlocks,
  TranslationValidationError,
  glossaryVersion,
} from "../../src/translation/translator";
import type { TranslationProvider, TranslationResult } from "../../src/translation/provider";
import { ProviderError } from "../../src/translation/provider";

describe("Translation protection (TEST_PLAN §10)", () => {
  const glossary = { FedContra: "preserve", "federated learning": "联邦学习" };

  it("protects math, wikilinks, glossary terms and restores them exactly", () => {
    const text = "We optimize $\\theta_0$ using **FedContra** and evaluate it on [[SafetyBench]].";
    const { protectedText, placeholders } = protectBlock(text, { glossary });

    expect(protectedText).not.toContain("$\\theta_0$");
    expect(protectedText).not.toContain("[[SafetyBench]]");
    expect(protectedText).not.toContain("FedContra");
    expect(protectedText).toMatch(/⟦MATH_001⟧/);
    expect(protectedText).toMatch(/⟦LINK_001⟧/);
    expect(protectedText).toMatch(/⟦TERM_001⟧/);

    const restored = restorePlaceholders(protectedText, placeholders);
    expect(restored).toBe(text);
  });

  it("protects code spans, citations and URLs", () => {
    const text = "See `model.eval()`, \\citep{liu2024}, and https://example.com/paper.";
    const { protectedText, placeholders } = protectBlock(text);
    expect(protectedText).not.toContain("`model.eval()`");
    expect(protectedText).not.toContain("\\citep{liu2024}");
    expect(protectedText).not.toContain("https://example.com");
    const kinds = placeholders.map((p) => p.kind);
    expect(kinds).toContain("CODE");
    expect(kinds).toContain("CITE");
    expect(kinds).toContain("LINK");
  });

  it("keeps offsets intact when protection rules cross positions (regression)", () => {
    // code (later rule) appears BEFORE math (earlier rule): the old
    // rule-order replacement corrupted offsets here.
    const text = "We use `code` here and then $x+y$ later.";
    const { protectedText, placeholders } = protectBlock(text, {});
    expect(protectedText).toBe("We use ⟦CODE_001⟧ here and then ⟦MATH_001⟧ later.");
    expect(restorePlaceholders(protectedText, placeholders)).toBe(text);

    const reversed = "Compare $a|b$ with `cmd` now.";
    const p2 = protectBlock(reversed, {});
    expect(restorePlaceholders(p2.protectedText, p2.placeholders)).toBe(reversed);
  });

  it("collects only prose blocks — code is never sent for translation", () => {
    const doc = parseMarkdown(
      "我们提出一种新的联邦学习防御方法。\n\n```python\nmodel.eval()\n```\n\n$$\nx = y\n$$\n\nShort.\n",
    );
    const blocks = collectTranslatableBlocks(doc);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[0].sourceText).toContain("联邦学习");
    const allText = blocks.map((b) => b.sourceText).join("\n");
    expect(allText).not.toContain("model.eval()");
    expect(allText).not.toContain("x = y");
  });

  it("detects prose presence", () => {
    expect(hasTranslatableProse("This has words $x$")).toBe(true);
    expect(hasTranslatableProse("$\\theta_0$ `code` https://x.y")).toBe(false);
  });

  it("selects only relevant glossary entries", () => {
    const relevant = relevantGlossary("We study backbone networks.", {
      "federated learning": "联邦学习",
      backbone: "主干网络",
    });
    expect(Object.keys(relevant)).toEqual(["backbone"]);
  });

  it("covers glossary terms inside math spans instead of nesting TERM tokens (regression)", () => {
    // {pi: preserve} on a formula: the math span must win, so no TERM token
    // lands inside the span value (which validation could never see again).
    const text = "We sum $pi + r$.";
    const { protectedText, placeholders } = protectBlock(text, { glossary: { pi: "preserve" } });
    expect(placeholders.filter((p) => p.kind === "TERM")).toHaveLength(0);
    expect(protectedText).toBe("We sum ⟦MATH_001⟧.");
    expect(restorePlaceholders(protectedText, placeholders)).toBe(text);
  });

  it("translates a block whose preserve term sits inside math", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => ({
        blocks: req.blocks.map((b) => ({ id: b.id, translation: b.text.replace("sum", "求和") })),
        raw: "",
        model: "m",
      }),
    };
    const res = await translateBlocks(
      provider,
      [{ nodeId: "p_1", type: "paragraph", sourceText: "We sum $pi + r$." }],
      {
        glossary: { pi: "preserve" },
        sourceLanguage: "en",
        targetLanguage: "zh",
        style: "academic",
      },
    );
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0].translation).toBe("We 求和 $pi + r$.");
  });

  it("still protects plain-prose preserve terms as restored TERM spans", () => {
    const text = "FedContra beats the baselines.";
    const { protectedText, placeholders } = protectBlock(text, { glossary: { FedContra: "preserve" } });
    expect(protectedText).toContain("⟦TERM_001⟧");
    expect(protectedText).not.toContain("FedContra");
    expect(restorePlaceholders(protectedText, placeholders)).toBe(text);
  });

  it("applies translate-action glossary entries only on real word matches", () => {
    expect(relevantGlossary("We study backbone networks.", { backbone: "主干网络" })).toEqual({
      backbone: "主干网络",
    });
    expect(relevantGlossary("An ML model.", { ML: "机器学习" })).toEqual({ ML: "机器学习" });
    expect(relevantGlossary("She said hi.", { AI: "人工智能" })).toEqual({});
  });

  it("uses script-aware term boundaries for protect and relevantGlossary", () => {
    // "AI" inside "said" must not be matched (old code produced s⟦TERM_001⟧d).
    const said = protectBlock("She said hi.", { glossary: { AI: "preserve" } });
    expect(said.protectedText).toBe("She said hi.");
    expect(said.placeholders).toHaveLength(0);

    expect(protectBlock("AI and robots.", { glossary: { AI: "preserve" } }).protectedText).toContain("⟦TERM_001⟧");
    expect(protectBlock("An AI-based filter.", { glossary: { AI: "preserve" } }).protectedText).toContain("⟦TERM_001⟧");
    // "ML" inside "HTML" must not be matched.
    expect(protectBlock("Use HTML now.", { glossary: { ML: "preserve" } }).protectedText).toBe("Use HTML now.");
    // CJK terms keep substring matching inside compounds.
    const cjk = protectBlock("监督机器学习模型。", { glossary: { 机器学习: "preserve" } });
    expect(cjk.protectedText).toContain("⟦TERM_001⟧");
    expect(restorePlaceholders(cjk.protectedText, cjk.placeholders)).toBe("监督机器学习模型。");

    expect(relevantGlossary("She said hi.", { AI: "人工智能" })).toEqual({});
    expect(relevantGlossary("An AI-based filter.", { AI: "人工智能" })).toEqual({ AI: "人工智能" });
    expect(relevantGlossary("监督机器学习模型。", { 机器学习: "machine learning" })).toEqual({
      机器学习: "machine learning",
    });
  });

  it("mirrors the parser's currency-safe inline math rules", () => {
    // The closing $ must not be space-preceded: "$5. The next sentence $" is
    // prose, only "$x$" is math.
    const mixed = protectBlock("It costs $5. The next sentence $x$ is math.", {});
    expect(mixed.protectedText).toBe("It costs $5. The next sentence ⟦MATH_001⟧ is math.");
    expect(restorePlaceholders(mixed.protectedText, mixed.placeholders)).toBe(
      "It costs $5. The next sentence $x$ is math.",
    );

    // Currency: "$5 and $10" protects nothing.
    const currency = protectBlock("It costs $5 and $10 total.", {});
    expect(currency.placeholders).toHaveLength(0);
    expect(currency.protectedText).toBe("It costs $5 and $10 total.");

    // Real math is still protected.
    const real = protectBlock("Energy: $E=mc^2$ indeed.", {});
    expect(real.protectedText).toBe("Energy: ⟦MATH_001⟧ indeed.");
    expect(restorePlaceholders(real.protectedText, real.placeholders)).toBe("Energy: $E=mc^2$ indeed.");
  });
});

describe("Protection validation (TEST_PLAN §11)", () => {
  it("fails when a placeholder disappears, and translation is rejected", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async () =>
        ({
          blocks: [
            // model dropped ⟦MATH_001⟧
            { id: "p_1", translation: "We optimize using FedContra." },
          ],
          raw: "",
          model: "m",
        }) as TranslationResult,
    };
    const err = await translateBlocks(provider, [{ nodeId: "p_1", type: "paragraph", sourceText: "We optimize $x+y$ using FedContra." }], {
      glossary: { FedContra: "preserve" },
      sourceLanguage: "en",
      targetLanguage: "zh",
      style: "academic",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationValidationError);
    expect((err as TranslationValidationError).problems.join(" ")).toContain("MATH_001");
  });
  it("fails on duplicated or unknown placeholders", () => {
    const { placeholders } = protectBlock("a $x$ b", {});
    const dup = validateProtection("a ⟦MATH_001⟧ b ⟦MATH_001⟧", placeholders);
    expect(dup.ok).toBe(false);
    expect(dup.problems.join(" ")).toContain("duplicated");

    const unknown = validateProtection("a ⟦MATH_002⟧ b", placeholders);
    expect(unknown.ok).toBe(false);
    expect(unknown.problems.join(" ")).toContain("unknown");
  });
});

describe("Structured output validation (§12)", () => {
  it("rejects missing and unknown block ids (batch degrades to per-block, problems reported)", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async () =>
        ({
          blocks: [
            { id: "p_1", translation: "ok" },
            { id: "p_99", translation: "intruder" },
          ],
          raw: "",
          model: "m",
        }) as TranslationResult,
    };
    // The batch (and every per-block retry — the provider ignores the request)
    // fails §12 validation, so no block yields a translation and each failure
    // lands in `problems` instead of failing the whole run.
    const res = await translateBlocks(
      provider,
      [
        { nodeId: "p_1", type: "paragraph", sourceText: "hello" },
        { nodeId: "p_2", type: "paragraph", sourceText: "world" },
      ],
      { sourceLanguage: "en", targetLanguage: "zh", style: "academic" },
    );
    const problems = (res.problems ?? []).join(" ");
    expect(problems).toContain("missing block p_2");
    expect(problems).toContain("unknown block p_99");
    expect(res.blocks).toHaveLength(0);
  });

  it("passes valid batches through with glossary version attached", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => ({
        blocks: req.blocks.map((b) => ({ id: b.id, translation: b.text.toUpperCase() })),
        raw: "",
        model: "m",
      }),
    };
    const results = await translateBlocks(
      provider,
      [{ nodeId: "p_1", type: "paragraph", sourceText: "hello world" }],
      { sourceLanguage: "en", targetLanguage: "zh", style: "academic", glossary: { a: "b" } },
    );
    expect(results.blocks).toHaveLength(1);
    expect(results.blocks[0].translation).toBe("HELLO WORLD");
    expect(results.model).toBe("m");
    expect(results.blocks[0].glossaryVersion).toBe(glossaryVersion({ a: "b" }));
  });

  it("rejects an empty translation for a non-empty source", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => ({
        blocks: req.blocks.map((b) => ({ id: b.id, translation: "" })),
        raw: "",
        model: "m",
      }),
    };
    const err = await translateBlocks(
      provider,
      [{ nodeId: "p_1", type: "paragraph", sourceText: "hello world" }],
      { sourceLanguage: "en", targetLanguage: "zh", style: "academic" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranslationValidationError);
    expect((err as TranslationValidationError).problems.join(" ")).toMatch(/empty translation/);
  });
});

describe("Batch chunking (context overflow guard)", () => {
  // Each source is 88 protected chars, so a 200-char budget forces 3 chunks.
  const mkBlocks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      nodeId: `p_${i + 1}`,
      type: "paragraph",
      sourceText: `block ${i + 1} ${"x".repeat(80)}`,
    }));
  const opts = { sourceLanguage: "en", targetLanguage: "zh", style: "academic", chunkCharBudget: 200 };

  it("splits large batches by the char budget and merges results in order", async () => {
    const batchSizes: number[] = [];
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => {
        batchSizes.push(req.blocks.length);
        return {
          blocks: req.blocks.map((b) => ({ id: b.id, translation: b.text.toUpperCase() })),
          raw: "",
          model: "m",
        };
      },
    };
    const res = await translateBlocks(provider, mkBlocks(6), opts);
    expect(batchSizes).toEqual([2, 2, 2]);
    expect(res.blocks.map((b) => b.nodeId)).toEqual(["p_1", "p_2", "p_3", "p_4", "p_5", "p_6"]);
    expect(res.problems).toBeUndefined();
  });

  it("a malformed chunk fails only its own blocks", async () => {
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => {
        if (req.blocks.some((b) => b.id === "p_3")) {
          throw new ProviderError("malformed", "model returned garbage");
        }
        return {
          blocks: req.blocks.map((b) => ({ id: b.id, translation: b.text.toUpperCase() })),
          raw: "",
          model: "m",
        };
      },
    };
    const res = await translateBlocks(provider, mkBlocks(6), opts);
    expect(res.blocks.map((b) => b.nodeId)).toEqual(["p_1", "p_2", "p_5", "p_6"]);
    expect(res.model).toBe("m");
    expect(res.problems?.join(" ")).toContain("p_3");
    expect(res.problems?.join(" ")).toContain("p_4");
  });

  it("threads opts.temperature into the provider request (R3 P2-1)", async () => {
    // The settings-tab Temperature was stored but never sent: every request
    // rode the client's `?? 0.2` default. The option must reach the request.
    const seen: (number | undefined)[] = [];
    const provider: TranslationProvider = {
      health: async () => true,
      translate: async (req) => {
        seen.push(req.temperature);
        return {
          blocks: req.blocks.map((b) => ({ id: b.id, translation: b.text.toUpperCase() })),
          raw: "",
          model: "m",
        };
      },
    };
    await translateBlocks(provider, mkBlocks(1), { ...opts, temperature: 0.7 });
    await translateBlocks(provider, mkBlocks(1), opts);
    expect(seen).toEqual([0.7, undefined]);
  });
});
