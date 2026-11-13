import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLatex, parseMarkdown } from "../../src/core/parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";
import { writeLatexFragment } from "../../src/core/writer/latex/latex-writer";
import { protectBlock, restorePlaceholders } from "../../src/translation/protector";
import { translateBlocks } from "../../src/translation/translator";
import { estimateRequestTokens } from "../../src/translation/prompt";
import { LlamaClient } from "../../src/translation/llama/client";
import { TranslationCache } from "../../src/translation/cache";
import { DEFAULT_SETTINGS, LLAMA_NUMBER_RULES, parseLlamaNumber, sanitizeLlamaSettings, validateLlamaSettings } from "../../src/settings/settings";
import type { TranslationProvider, TranslationRequest } from "../../src/translation/provider";

const options = { sourceLanguage: "en", targetLanguage: "zh", style: "academic" };
const echo: TranslationProvider = {
  health: async () => true,
  translate: async (request) => ({
    blocks: request.blocks.map((block) => ({ id: block.id, translation: block.text })),
    raw: "", model: "m",
  }),
};
afterEach(() => vi.restoreAllMocks());

describe("review: complete protection boundaries", () => {
  it.each([
    String.raw`See \citep[see][p.~5]{smith2024} here.`,
    String.raw`See \citep[see {Section ]}][p.~5]{smith2024} here.`,
    String.raw`Keep \custom[escaped \] and \[ brackets]{arg} here.`,
    "See [wiki](https://x.test/Thing_(test)) here.",
    'See [title](https://x.test "A (title)") here.',
    "See [nested [label]](https://x.test/a_(b)) here.",
    String.raw`Keep \custom*[option={x}]{outer {inner}}{tail} here.`,
  ])("protects the complete construct in %s", (source) => {
    const protectedBlock = protectBlock(source);
    expect(protectedBlock.placeholders).toHaveLength(1);
    expect(protectedBlock.protectedText).toMatch(/^(?:See|Keep) \u27e6(?:CITE|LINK|RAW)_001\u27e7 here\.$/);
    expect(restorePlaceholders(protectedBlock.protectedText, protectedBlock.placeholders)).toBe(source);
  });

  it("keeps citation keys and inline LaTeX metadata outside model-editable text", async () => {
    const source = writeMarkdown(parseLatex(String.raw`Keep \custom{one}{two} and \citep[see]{smith2024}.`)).trim();
    const result = await translateBlocks({
      ...echo,
      translate: async (request) => ({
        blocks: request.blocks.map((block) => ({
          id: block.id,
          translation: block.text.replace(/smith2024/g, "WRONG").replace(/scholarbridge/g, "WRONG"),
        })), raw: "", model: "m",
      }),
    }, [{ nodeId: "p_1", type: "paragraph", sourceText: source }], options);
    const latex = writeLatexFragment(parseMarkdown(result.blocks[0].translation));
    expect(latex).toContain("\\custom{one}{two}");
    expect(latex).toContain("\\citep[see]{smith2024}");
    expect(latex).not.toContain("WRONG");
  });
});

describe("review: strictly typed model responses", () => {
  it.each([
    null, [], { blocks: [null] }, { blocks: [{ id: 1, translation: "text" }] },
    { blocks: [{ id: "p_1", translation: { bad: true } }] },
    { blocks: [{ id: "p_1", translation: 123 }] },
    { blocks: [{ id: "p_1", translation: false }] },
  ])("rejects malformed structured output %j before caching", async (payload) => {
    const client = new LlamaClient({ baseUrl: "http://127.0.0.1:8080", model: "m" });
    vi.spyOn(client, "chat").mockResolvedValue({ content: JSON.stringify(payload), model: "m" });
    const cache = new TranslationCache();
    await expect(translateBlocks(client, [{ nodeId: "p_1", type: "paragraph", sourceText: "Source." }], {
      ...options, cache,
    })).rejects.toMatchObject({ kind: "malformed" });
    expect(cache.size).toBe(0);
  });
});

describe("review: complete translation context budgets", () => {
  it("budgets custom instructions, JSON, glossary and the configured output allowance", async () => {
    const requests: TranslationRequest[] = [];
    const provider = { ...echo, translate: async (request: TranslationRequest) => {
      requests.push(request);
      return echo.translate(request);
    } };
    const source = "A neural network improves results. ".repeat(80).trim();
    const result = await translateBlocks(provider, [{ nodeId: "p_1", type: "paragraph", sourceText: source }], {
      ...options, contextSize: 4096, maxTokens: 1536,
      customPrompt: "Be concise. ".repeat(100),
      glossary: { "neural network": "fixed neural network" },
    });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => estimateRequestTokens(request) <= 4096)).toBe(true);
    expect(result.blocks[0].translation).toBe(source);
  });

  it("fails before sending a prompt that cannot fit even with one source character", async () => {
    const translate = vi.fn(echo.translate);
    await expect(translateBlocks({ ...echo, translate }, [{
      nodeId: "p_1", type: "paragraph", sourceText: "Source.",
    }], { ...options, contextSize: 1024, customPrompt: "instruction ".repeat(300) }))
      .rejects.toMatchObject({ kind: "config" });
    expect(translate).not.toHaveBeenCalled();
  });

  it("never spends more than the context on an explicit output token limit", async () => {
    const translate = vi.fn(echo.translate);
    await expect(translateBlocks({ ...echo, translate }, [{
      nodeId: "p_1", type: "paragraph", sourceText: "Source.",
    }], { ...options, contextSize: 4096, maxTokens: 4096 })).rejects.toMatchObject({ kind: "config" });
    expect(translate).not.toHaveBeenCalled();
  });

  it("discards an otherwise valid late response when the job was cancelled", async () => {
    const controller = new AbortController();
    const cache = new TranslationCache();
    await expect(translateBlocks({
      ...echo, translate: async (request) => { controller.abort(); return echo.translate(request); },
    }, [{ nodeId: "p_1", type: "paragraph", sourceText: "Source." }], {
      ...options, signal: controller.signal, cache,
    })).rejects.toThrow();
    expect(cache.size).toBe(0);
  });
});

describe("review: shared numeric configuration constraints", () => {
  it.each(Object.entries(LLAMA_NUMBER_RULES))("enforces the same bounds for %s", (key, rule) => {
    const field = key as keyof typeof LLAMA_NUMBER_RULES;
    expect(parseLlamaNumber(field, String(rule.min))).toBe(rule.min);
    expect(parseLlamaNumber(field, String(rule.max))).toBe(rule.max);
    expect(parseLlamaNumber(field, String(rule.min - 1))).toBeNull();
    expect(parseLlamaNumber(field, String(rule.max + 1))).toBeNull();
    expect(parseLlamaNumber(field, "")).toBeNull();
    expect(parseLlamaNumber(field, "10garbage")).toBeNull();
    const sanitized = sanitizeLlamaSettings({ ...DEFAULT_SETTINGS.llama, [field]: rule.min - 1 });
    expect(sanitized[field]).toBe(rule.min);
    expect(() => validateLlamaSettings({ ...DEFAULT_SETTINGS.llama, [field]: rule.min - 1 })).toThrow();
  });
});
