import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeLlamaSettings } from "../../src/settings/settings";
import { workflow } from "../helpers/workflow";

describe("translation generation settings", () => {
  it("preserves valid sampling values, including disabled top-k and server-default token limits", () => {
    const settings = sanitizeLlamaSettings({
      ...DEFAULT_SETTINGS.llama, topP: 0.8, topK: 0, maxTokens: 0,
    });
    expect(settings).toMatchObject({ topP: 0.8, topK: 0, maxTokens: 0 });
  });

  it("bounds saved sampling values and replaces malformed values with defaults", () => {
    expect(sanitizeLlamaSettings({
      ...DEFAULT_SETTINGS.llama, topP: 2, topK: -1, maxTokens: 2_000_000,
    })).toMatchObject({ topP: 1, topK: 0, maxTokens: 1_000_000 });
    expect(sanitizeLlamaSettings({
      ...DEFAULT_SETTINGS.llama, topP: NaN, topK: Infinity, maxTokens: "512" as unknown as number,
    })).toMatchObject({
      topP: DEFAULT_SETTINGS.llama.topP,
      topK: DEFAULT_SETTINGS.llama.topK,
      maxTokens: DEFAULT_SETTINGS.llama.maxTokens,
    });
  });

  it("loads old saved settings with new defaults and preserves a custom prompt", async () => {
    const host = workflow();
    Object.assign(host.plugin, {
      loadData: async () => ({ llama: { temperature: 0.4 }, customPrompt: "Use concise prose." }),
    });
    await (host.plugin as unknown as { loadSettings(): Promise<void> }).loadSettings();
    expect(host.plugin.settings.llama).toMatchObject({
      temperature: 0.4, topP: 0.95, topK: 40, maxTokens: 0,
    });
    expect(host.plugin.settings.customPrompt).toBe("Use concise prose.");
    host.plugin.onunload();
  });

  it("replaces malformed saved custom prompts with the default", async () => {
    const host = workflow();
    Object.assign(host.plugin, { loadData: async () => ({ customPrompt: { text: "bad" } }) });
    await (host.plugin as unknown as { loadSettings(): Promise<void> }).loadSettings();
    expect(host.plugin.settings.customPrompt).toBe("");
    host.plugin.onunload();
  });
});
