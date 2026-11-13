import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { notices } from "../helpers/obsidian";
import { workflow } from "../helpers/workflow";
import { registerTranslateCommands } from "../../src/editor/translate-commands";
import { registerEditorFeatures } from "../../src/editor/commands";
import { ensureTranslatorReady, makeServerManager } from "../../src/editor/translator-commands";
import { LlamaClient } from "../../src/translation/llama/client";
import { LlamaServerManager } from "../../src/translation/llama/server-manager";
import { buildTranslationBlock, type ReinsertionInput } from "../../src/translation/reinsertion";
import { scanFreshness } from "../../src/translation/freshness";
import { TranslationPreviewView, type PreviewJob } from "../../src/views/translation-preview";
import { DiffView } from "../../src/views/diff-view";
import { parseMarkdown } from "../../src/core/parser/markdown/markdown-parser";
import { exportFolderToLatex } from "../../src/export/project-export";
import { exportNoteToLatex } from "../../src/export/latex-template";
import type { TranslationRequest } from "../../src/translation/provider";
import type { Command, WorkspaceLeaf } from "obsidian";

const active: ReturnType<typeof workflow>[] = [];
const setup = (text = "Source.") => {
  const host = workflow(text);
  active.push(host);
  return host;
};
const input = (raw = "Source.", nodeId = "p_1", translation = "Translated."): ReinsertionInput => ({
  nodeId, translation, range: { raw, startLine: 0, endLine: 0 }, verifyRaw: raw,
  meta: { sourceLanguage: "en", targetLanguage: "zh", model: "test", glossaryVersion: "g", promptVersion: "v1" },
});
const jobFor = (item = input(), mode: PreviewJob["writeMode"] = "insert-below"): PreviewJob => ({
  mode, writeMode: mode, applied: false, filePath: "note.md",
  items: [{ input: item, included: true, edited: false }],
});
function run(host: ReturnType<typeof workflow>, id: string): void {
  const commands = (host.plugin as unknown as { commands: Command[] }).commands;
  const command = commands.find((item) => item.id === id)!;
  if (command.editorCallback) command.editorCallback(host.editor, host.view);
  else command.checkCallback?.(false);
}
async function translate(host: ReturnType<typeof workflow>, id = "translate-selection"): Promise<PreviewJob> {
  registerTranslateCommands(host.plugin);
  run(host, id);
  await vi.waitFor(() => expect(host.preview.currentJob).not.toBeNull());
  return host.preview.currentJob!;
}
const apply = (view: TranslationPreviewView) =>
  (view as unknown as { applyJob(): Promise<void> }).applyJob();

beforeEach(() => {
  notices.length = 0;
  vi.spyOn(LlamaClient.prototype, "health").mockResolvedValue(true);
  vi.spyOn(LlamaClient.prototype, "translate").mockImplementation(async (request) => ({
    blocks: request.blocks.map((block) => ({ id: block.id, translation: `Translated: ${block.text}` })),
    raw: "", model: "test",
  }));
});
afterEach(() => {
  for (const host of active.splice(0)) host.plugin.onunload();
  vi.restoreAllMocks();
});

describe("review: commands, previews and real translation writes", () => {
  it.each(["```python", "~~~~python", "````python"])("excludes the complete %s fence even after internal blank lines", async (fence) => {
    const close = fence.match(/^[`~]+/)![0];
    const host = setup(`Intro.\n\n${fence}\nprint("first")\n\nprint("second")\n${close}\n\nEnd.`);
    const job = await translate(host);
    expect(job.items.map((item) => item.input.range.raw)).toEqual(["Intro.", "End."]);
    const requests = vi.mocked(LlamaClient.prototype.translate).mock.calls;
    expect(JSON.stringify(requests)).not.toContain("print");
    await apply(host.preview);
    expect(host.editor.getValue()).toContain(`${fence}\nprint("first")\n\nprint("second")\n${close}`);
  });

  it("uses whole-document context for a selection entirely inside code", async () => {
    const host = setup('```python\nprint("first")\n\nprint("second")\n```');
    host.editor.setSelection({ line: 3, ch: 0 }, { line: 3, ch: 15 });
    registerTranslateCommands(host.plugin);
    run(host, "translate-selection");
    await vi.waitFor(() => expect(notices.some((notice) => notice.includes("no translatable prose"))).toBe(true));
    expect(LlamaClient.prototype.translate).not.toHaveBeenCalled();
  });

  it("keeps frontmatter and headings out of the replacement ranges", async () => {
    const host = setup("---\ntitle: Title\n---\n# Heading\nBody.\n\n```md\n# Not a heading\n```\n\nTail.");
    const job = await translate(host);
    expect(job.items.map((item) => item.input.range.startLine)).toEqual([4, 10]);
    await host.plugin.applyTranslationJob(job.items.map((item) => item.input), "replace", job.filePath);
    expect(host.editor.getValue()).toMatch(/^---\ntitle: Title\n---\n# Heading\n/);
    expect(host.editor.getValue()).toContain("```md\n# Not a heading\n```");
  });

  it("does not let a code heading truncate section translation", async () => {
    const host = setup("# Real\nIntro.\n\n```md\n# Fake\n```\n\nTail.\n\n# Next\nOutside.");
    host.editor.setSelection({ line: 1, ch: 0 });
    const job = await translate(host, "translate-section");
    expect(job.items.map((item) => item.input.range.raw)).toEqual(["Intro.", "Tail."]);
  });

  it("preserves old translations for failed blocks when applying successful blocks", async () => {
    const first = buildTranslationBlock(input("First original.", "p_1", "KEEP FIRST"));
    const second = buildTranslationBlock(input("Second original.", "p_2", "KEEP SECOND"));
    const host = setup(`First changed.\n\n${first}\n\nSecond changed.\n\n${second}`);
    vi.mocked(LlamaClient.prototype.translate).mockImplementation(async (request) => ({
      blocks: request.blocks.length > 1
        ? [{ id: request.blocks[0].id, translation: "NEW FIRST" }]
        : request.blocks[0].text.startsWith("Second")
          ? []
          : [{ id: request.blocks[0].id, translation: "NEW FIRST" }],
      raw: "", model: "test",
    }));
    const job = await translate(host, "translate-changed-blocks");
    expect(job.items[1]).toMatchObject({ included: false, failed: true });
    const accepts = host.preview.contentEl.querySelectorAll<HTMLButtonElement>(".scholar-bridge-preview-actions button:first-child");
    expect(accepts[1].disabled).toBe(true);
    await apply(host.preview);
    expect(host.editor.getValue()).toContain("NEW FIRST");
    expect(host.editor.getValue()).toContain("KEEP SECOND");
    expect(scanFreshness(host.editor.getValue()).staleEntries).toHaveLength(1);
  });

  it("enables a failed item only after retry succeeds", async () => {
    const first = buildTranslationBlock(input("First original.", "p_1", "KEEP FIRST"));
    const second = buildTranslationBlock(input("Second original.", "p_2", "KEEP SECOND"));
    const host = setup(`First changed.\n\n${first}\n\nSecond changed.\n\n${second}`);
    vi.mocked(LlamaClient.prototype.translate).mockImplementation(async (request) => ({
      blocks: request.blocks.length > 1
        ? [{ id: request.blocks[0].id, translation: "NEW FIRST" }]
        : request.blocks[0].text.startsWith("Second")
          ? []
          : [{ id: request.blocks[0].id, translation: "NEW FIRST" }],
      raw: "", model: "test",
    }));
    await translate(host, "translate-changed-blocks");
    vi.mocked(LlamaClient.prototype.translate).mockImplementation(async (request) => ({
      blocks: request.blocks.map((block) => ({ id: block.id, translation: "NEW SECOND" })),
      raw: "", model: "test",
    }));
    await host.preview.retryHandler!(1);
    expect(host.preview.currentJob!.items[1]).toMatchObject({ failed: false, included: true });
    await apply(host.preview);
    expect(host.editor.getValue()).toContain("NEW SECOND");
    expect(scanFreshness(host.editor.getValue()).staleEntries).toHaveLength(0);
  });

  it("does not apply manually included failed or empty items", async () => {
    const host = setup();
    const job = jobFor(input("Source.", "p_1", ""));
    job.items[0].failed = true;
    host.preview.setJob(job);
    await apply(host.preview);
    expect(host.editor.transaction).not.toHaveBeenCalled();
    expect(host.preview.currentJob).toBe(job);
  });

  it("rejects a stale original source when refreshing an unchanged translation block", async () => {
    const host = setup(`Changed.\n\n${buildTranslationBlock(input("Original.", "p_1", "KEEP OLD"))}`);
    vi.mocked(LlamaClient.prototype.translate).mockImplementation(async (request) => {
      host.editor.setValue(host.editor.getValue().replace("Changed.", "Newer."));
      return { blocks: request.blocks.map((block) => ({ id: block.id, translation: "OUTDATED" })), raw: "", model: "test" };
    });
    const job = await translate(host, "translate-changed-blocks");
    await expect(host.plugin.applyTranslationJob(job.items.map((item) => item.input), job.writeMode, job.filePath)).rejects.toThrow("note has changed");
    expect(host.editor.getValue()).toContain("KEEP OLD");
    expect(host.editor.transaction).not.toHaveBeenCalled();
  });

  it("rechecks the editor after awaiting focus", async () => {
    const host = setup();
    host.app.workspace.revealLeaf.mockImplementation(async () => host.editor.setValue("Changed."));
    await expect(host.plugin.applyTranslationJob([input()], "replace", "note.md")).rejects.toThrow("note has changed");
    expect(host.editor.getValue()).toBe("Changed.");
  });

  it("does not write twice on concurrent Apply calls", async () => {
    const host = setup();
    host.preview.setJob(jobFor());
    await Promise.all([apply(host.preview), apply(host.preview)]);
    expect(host.editor.transaction).toHaveBeenCalledTimes(1);
    expect(host.editor.getValue().split("Translated.")).toHaveLength(2);
  });

  it("preserves a newer preview when an older application finishes", async () => {
    const host = setup();
    let release: () => void = () => {};
    host.app.workspace.revealLeaf.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    host.preview.setJob(jobFor());
    const pending = apply(host.preview);
    const next = jobFor(input("Source.", "p_2", "A different job."));
    host.preview.setJob(next);
    release();
    await pending;
    expect(host.preview.currentJob).toBe(next);
    expect(next.applied).toBe(false);
  });

  it("keeps edited preview text on translated-copy name collisions", async () => {
    const host = setup();
    host.app.vault.getAbstractFileByPath.mockReturnValue(new TFile("note.translated.md") as never);
    const job = jobFor(input("Source.", "p_1", "Hand edited."), "translated-copy");
    host.preview.setJob(job);
    await apply(host.preview);
    expect(host.preview.currentJob).toBe(job);
    expect(job.applied).toBe(false);
    expect(host.app.vault.create).not.toHaveBeenCalled();
    expect(notices.some((notice) => notice.includes("applied 1"))).toBe(false);
  });

  it("does not make damaged trailing metadata replaceable", async () => {
    const bad = buildTranslationBlock(input("Original.")).replace("\n<!-- scholarbridge:translation:end -->", "");
    const host = setup(`Changed.\n\n${bad}\n\n# Unrelated\nKEEP.`);
    registerTranslateCommands(host.plugin);
    run(host, "translate-changed-blocks");
    await vi.waitFor(() => expect(notices.some((notice) => notice.includes("damaged"))).toBe(true));
    expect(LlamaClient.prototype.translate).not.toHaveBeenCalled();
    expect(host.editor.getValue()).toContain("# Unrelated\nKEEP.");
  });
});

describe("review: paste decisions and service configuration", () => {
  it("pastes the original text when the confirmation is dismissed", () => {
    const host = setup("");
    registerEditorFeatures(host.plugin);
    const source = "\\begin{equation}x=y\\end{equation}";
    const preventDefault = vi.fn();
    host.events.get("editor-paste")!({
      clipboardData: { getData: () => source }, preventDefault, defaultPrevented: false,
    }, host.editor, host.view);
    host.app.modals[0].close();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(host.editor.getValue()).toBe(source);
    expect(host.editor.transaction).toHaveBeenCalledOnce();
  });

  it("uses the captured selection even if the cursor moves before confirmation", () => {
    const host = setup("Prefix OLD suffix");
    host.editor.setSelection({ line: 0, ch: 7 }, { line: 0, ch: 10 });
    registerEditorFeatures(host.plugin);
    host.events.get("editor-paste")!({
      clipboardData: { getData: () => "\\begin{equation}x=y\\end{equation}" },
      preventDefault: vi.fn(), defaultPrevented: false,
    }, host.editor, host.view);
    host.editor.setSelection({ line: 0, ch: 0 });
    host.app.modals[0].contentEl.querySelector<HTMLButtonElement>("button")!.click();
    expect(host.editor.getValue()).toMatch(/^Prefix \$\$/);
    expect(host.editor.getValue()).toContain(" suffix");
    expect(host.editor.getValue()).not.toContain("OLD");
  });

  it("refuses a delayed paste after the source note changes", () => {
    const host = setup("Original.");
    registerEditorFeatures(host.plugin);
    host.events.get("editor-paste")!({
      clipboardData: { getData: () => "\\begin{equation}x=y\\end{equation}" },
      preventDefault: vi.fn(), defaultPrevented: false,
    }, host.editor, host.view);
    host.editor.setValue("Newer content.");
    host.app.modals[0].close();
    expect(host.editor.getValue()).toBe("Newer content.");
    expect(host.editor.transaction).not.toHaveBeenCalled();
  });

  it("recreates a stopped manager after model, host or GPU settings change", async () => {
    const host = setup();
    Object.assign(host.plugin.settings.llama, {
      executablePath: "llama-server", modelPath: "old.gguf", confirmSpawn: false,
    });
    const previous = makeServerManager(host.plugin);
    host.plugin.serverManager = previous;
    const stop = vi.spyOn(previous, "stop");
    Object.assign(host.plugin.settings.llama, { modelPath: "new.gguf", port: 8081, gpuLayers: 12 });
    const configs: unknown[] = [];
    vi.spyOn(LlamaServerManager.prototype, "start").mockImplementation(async function () {
      const manager = this as unknown as { cfg: unknown; statusValue: string };
      configs.push(manager.cfg);
      manager.statusValue = "ready";
    });
    expect(await ensureTranslatorReady(host.plugin)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(host.plugin.serverManager).not.toBe(previous);
    expect(configs).toEqual([expect.objectContaining({ modelPath: "new.gguf", port: 8081, gpuLayers: 12 })]);
  });
});

describe("review: diff presentation and complete project assets", () => {
  it("shows nested formatting, links, lists and quotes on added and removed blocks", () => {
    const host = setup();
    const view = new DiffView({} as WorkspaceLeaf, host.plugin);
    const plain = (view as unknown as { plainOf(node: unknown): string }).plainOf.bind(view);
    expect(plain(parseMarkdown("**Critical** *result* [paper](paper.md)").children[0])).toContain("Critical");
    expect(plain(parseMarkdown("- First\n- Second").children[0])).toContain("Second");
    expect(plain(parseMarkdown("> Quoted result.").children[0])).toContain("Quoted result.");
  });

  it("rebases note-relative figures and vault-resolved embeds for project exports", async () => {
    const host = setup();
    const folder = new TFolder("paper");
    const file = new TFile("paper/intro.md");
    Object.assign(folder, { children: [file] });
    const contents = new Map<string, string>();
    host.app.vault.getAbstractFileByPath.mockReturnValue(null);
    const vault = Object.assign(host.app.vault, {
      read: vi.fn(async () => "![Plot](figures/plot.png)\n\n![[global.png]]"),
      createFolder: vi.fn(async () => {}),
      create: vi.fn(async (filePath: string, content: string) => { contents.set(filePath, content); return new TFile(filePath); }),
    });
    host.app.metadataCache.getFirstLinkpathDest.mockImplementation((target: string) =>
      new TFile(target === "global.png" ? "attachments/global.png" : "paper/figures/plot.png") as never);
    await exportFolderToLatex(host.plugin.app, folder, "article");
    const section = contents.get("paper/latex/sections/intro.tex")!;
    expect(section).toContain("{../figures/plot.png}");
    expect(section).toContain("{../../attachments/global.png}");
    expect(contents.get("paper/latex/main.tex")).toContain("\\usepackage{graphicx}");
    expect(vault.create).toHaveBeenCalledTimes(2);
  });

  it("resolves a single note's wikilink to its actual attachment location", async () => {
    const host = setup();
    const contents = new Map<string, string>();
    Object.assign(host.app.vault, {
      read: vi.fn(async () => "![[global.png]]"),
      create: vi.fn(async (filePath: string, content: string) => { contents.set(filePath, content); return new TFile(filePath); }),
    });
    host.app.metadataCache.getFirstLinkpathDest.mockReturnValue(new TFile("attachments/global.png") as never);
    await exportNoteToLatex(host.plugin.app, new TFile("paper/intro.md"), "article");
    expect(contents.get("paper/intro.tex")).toContain("{../attachments/global.png}");
  });
});
