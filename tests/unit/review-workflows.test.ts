import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type Command, type WorkspaceLeaf } from "obsidian";
import { workflow } from "../helpers/workflow";
import { notices } from "../helpers/obsidian";
import { DiffView } from "../../src/views/diff-view";
import type { DocumentDiff } from "../../src/diff/structural-diff";
import type { PreviewJob } from "../../src/views/translation-preview";
import { registerTranslateCommands } from "../../src/editor/translate-commands";
import { ensureTranslatorReady, makeClient } from "../../src/editor/translator-commands";
import { LlamaClient } from "../../src/translation/llama/client";
import { LlamaServerManager, type SpawnedProcess } from "../../src/translation/llama/server-manager";
import { exportFolderToLatex } from "../../src/export/project-export";
import { parseLatex } from "../../src/core/parser";
import { writeMarkdown } from "../../src/core/writer/markdown/markdown-writer";

const hosts: ReturnType<typeof workflow>[] = [];
const setup = () => { const host = workflow(); hosts.push(host); return host; };
type DiffControls = {
  accepted: Set<number>; result: DocumentDiff;
  applyAccepted(): Promise<void>;
};
async function comparison(old = "Anchor.", next = "Anchor.\n\nAdded.") {
  const host = setup();
  let stored = old;
  const vault = Object.assign(host.app.vault, {
    cachedRead: vi.fn(async (file: TFile) => file.path === "old.md" ? stored : next),
    process: vi.fn(async (_file: TFile, change: (text: string) => string) => { stored = change(stored); }),
  });
  const view = new DiffView({} as WorkspaceLeaf, host.plugin);
  view.setFiles(new TFile("old.md"), new TFile("new.md"));
  await vi.waitFor(() => expect(view.contentEl.querySelector(".scholar-bridge-diff-rowwrap")).not.toBeNull());
  return {
    ...host, vault, view, controls: view as unknown as DiffControls,
    getStored: () => stored, setStored: (value: string) => { stored = value; },
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.plugin.onunload();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  notices.length = 0;
});

describe("review: diff application and rendering", () => {
  it("locks before the first await and inserts an accepted addition once", async () => {
    const host = await comparison();
    host.view.contentEl.querySelector<HTMLButtonElement>(".scholar-bridge-diff-actions button")!.click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    host.vault.process.mockImplementation(async (_file, change) => {
      await gate;
      host.setStored(change(host.getStored()));
    });
    const first = host.controls.applyAccepted();
    const second = host.controls.applyAccepted();
    expect(host.vault.process).toHaveBeenCalledTimes(1);
    expect(host.view.contentEl.querySelector<HTMLButtonElement>(".scholar-bridge-diff-actions button")!.disabled).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(host.getStored()).toBe("Anchor.\n\nAdded.");
  });

  it("keeps stale source intact and requires a fresh acceptance after recomputing", async () => {
    const host = await comparison("Alpha.\n\nAlpha.", "Changed.\n\nAlpha.");
    host.view.contentEl.querySelector<HTMLButtonElement>(".scholar-bridge-diff-actions button")!.click();
    host.setStored("Hand edited.\n\nAlpha.");
    await host.controls.applyAccepted();
    expect(host.getStored()).toBe("Hand edited.\n\nAlpha.");
    expect(host.controls.accepted.size).toBe(0);
  });

  it("refuses disk writes over a newer editor buffer", async () => {
    const host = await comparison("Old.", "New.");
    host.view.contentEl.querySelector<HTMLButtonElement>(".scholar-bridge-diff-actions button")!.click();
    const open = host.app.workspace.getLeavesOfType("markdown")[0].view;
    Object.assign(open, { file: new TFile("old.md"), editor: host.editor });
    host.editor.setValue("Unsaved edits.");
    await host.controls.applyAccepted();
    expect(host.getStored()).toBe("Old.");
    expect(notices.some((notice) => notice.includes("unsaved"))).toBe(true);
  });

  it("toggles one row without replacing neighboring DOM or resetting scroll", async () => {
    const host = await comparison("Old.\n\nAnchor.", "New.\n\nAnchor.");
    const rows = [...host.view.contentEl.querySelectorAll(".scholar-bridge-diff-rowwrap")];
    host.view.contentEl.scrollTop = 123;
    const toggle = host.view.contentEl.querySelector<HTMLButtonElement>(".scholar-bridge-diff-actions button")!;
    toggle.click();
    expect([...host.view.contentEl.querySelectorAll(".scholar-bridge-diff-rowwrap")]).toEqual(rows);
    expect(host.view.contentEl.contains(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(host.view.contentEl.scrollTop).toBe(123);
  });

  it("shows language and alignment changes in the displayed source", async () => {
    const code = await comparison("```js\nx\n```", "```py\nx\n```");
    expect(code.view.contentEl.textContent).toContain("```js");
    expect(code.view.contentEl.textContent).toContain("```py");
    const table = await comparison("| A |\n| :--- |\n| X |", "| A |\n| ---: |\n| X |");
    expect(table.view.contentEl.textContent).toContain(":---");
    expect(table.view.contentEl.textContent).toContain("---:");
  });

  it("loads long comparisons in batches and releases its observer when closed", async () => {
    let notify!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe(): void {}
      disconnect = disconnect;
    });
    const source = Array.from({ length: 250 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    const host = await comparison(source, source + "\n\nAdded.");
    expect(host.view.contentEl.querySelectorAll(".scholar-bridge-diff-rowwrap")).toHaveLength(100);
    const first = host.view.contentEl.querySelector(".scholar-bridge-diff-rowwrap");
    notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
    expect(host.view.contentEl.querySelectorAll(".scholar-bridge-diff-rowwrap")).toHaveLength(200);
    notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
    expect(host.view.contentEl.querySelectorAll(".scholar-bridge-diff-rowwrap")).toHaveLength(251);
    expect(host.view.contentEl.querySelector(".scholar-bridge-diff-rowwrap")).toBe(first);
    await host.view.onClose();
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("review: preview and plugin lifetime", () => {
  it("opens the current preview without losing edited or accepted content", async () => {
    const host = setup();
    const job: PreviewJob = {
      mode: "insert-below", writeMode: "insert-below", applied: false, filePath: "note.md",
      items: [{
        input: {
          nodeId: "p_1", translation: "Hand edited.",
          range: { raw: "Source.", startLine: 0, endLine: 0 },
          meta: { sourceLanguage: "en", targetLanguage: "zh", model: "m", glossaryVersion: "g", promptVersion: "v1" },
        },
        included: true, edited: true,
      }],
    };
    host.preview.setJob(job);
    registerTranslateCommands(host.plugin);
    const commands = (host.plugin as unknown as { commands: Command[] }).commands;
    commands.find((command) => command.id === "open-translation-preview")!.callback!();
    await vi.waitFor(() => expect(host.app.workspace.revealLeaf).toHaveBeenCalled());
    expect(host.preview.currentJob).toBe(job);
    expect(host.preview.currentJob!.items[0].input.translation).toBe("Hand edited.");
  });

  it("cancels a pending startup confirmation on unload", async () => {
    const host = setup();
    Object.assign(host.plugin.settings.llama, { executablePath: "server", modelPath: "model.gguf" });
    const start = vi.spyOn(LlamaServerManager.prototype, "start").mockResolvedValue();
    const pending = ensureTranslatorReady(host.plugin);
    expect(host.app.modals).toHaveLength(1);
    const button = host.app.modals[0].contentEl.querySelector<HTMLButtonElement>("button")!;
    host.plugin.onunload();
    expect(await pending).toBe(false);
    button.click();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(host.plugin.serverManager).toBeNull();
  });

  it("refuses translation writes after unload", async () => {
    const host = setup();
    host.plugin.onunload();
    await expect(host.plugin.applyTranslationJob([], "replace", "note.md")).rejects.toThrow();
    expect(host.editor.transaction).not.toHaveBeenCalled();
  });

  it("aborts a request in flight when its plugin lifetime ends", async () => {
    const controller = new AbortController();
    const client = new LlamaClient({
      baseUrl: "http://127.0.0.1:8080", model: "m", signal: controller.signal,
      fetchImpl: (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
      })) as typeof fetch,
    });
    const request = client.chat([{ role: "user", content: "Hello" }], 0.2);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "aborted" });
  });

  it("keeps request accounting bound to its original manager across concurrent calls", () => {
    const host = setup();
    const owner = new LlamaServerManager({
      executablePath: "server", modelPath: "model.gguf", host: "127.0.0.1", port: 8080,
      gpuLayers: 0, contextSize: 4096, idleTimeoutMs: 0,
    }, { health: async () => false, translate: async () => { throw new Error("unused"); } }, () => { throw new Error("unused"); });
    host.plugin.serverManager = owner;
    const begin = vi.spyOn(owner, "beginRequest");
    const end = vi.spyOn(owner, "endRequest");
    const client = makeClient(host.plugin);
    client.onRequestStart!();
    client.onRequestStart!();
    host.plugin.serverManager = null;
    client.onRequestEnd!();
    client.onRequestEnd!();
    expect(begin).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
  });

  it("does not spawn after Stop cancels the initial health probe", async () => {
    let finish!: (healthy: boolean) => void;
    const spawner = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { killed: boolean; kill(): boolean };
      child.killed = false;
      child.kill = () => { child.killed = true; child.emit("exit", 0); return true; };
      return child as unknown as SpawnedProcess;
    });
    const manager = new LlamaServerManager({
      executablePath: "server", modelPath: "model.gguf", host: "127.0.0.1", port: 8080,
      gpuLayers: 0, contextSize: 4096, idleTimeoutMs: 0,
    }, {
      health: () => new Promise<boolean>((resolve) => { finish = resolve; }),
      translate: async () => { throw new Error("unused"); },
    }, spawner);
    const pending = manager.start();
    await manager.stop();
    finish(false);
    await pending;
    expect(spawner).not.toHaveBeenCalled();
    expect(manager.status()).toBe("stopped");
  });
});

describe("review: preflighted project exports", () => {
  function project(notes: { name: string; markdown: string }[]) {
    const host = setup();
    const folder = new TFolder("paper");
    folder.children = notes.map((note) => new TFile(`paper/${note.name}.md`));
    const source = new Map(notes.map((note) => [`paper/${note.name}.md`, note.markdown]));
    const output = new Map<string, string>();
    const vault = Object.assign(host.app.vault, {
      read: vi.fn(async (file: TFile) => source.get(file.path)!),
      createFolder: vi.fn(async () => {}),
      create: vi.fn(async (path: string, content: string) => { output.set(path, content); return new TFile(path); }),
    });
    return { ...host, folder, output, vault };
  }

  it("keeps every colliding title in a separate portable section file", async () => {
    const host = project(["a?", "a*", "a-2", "100% ablation"].map((name, index) => ({
      name, markdown: `Distinct content ${index}.`,
    })));
    const plan = await exportFolderToLatex(host.plugin.app, host.folder, "article");
    expect(new Set(plan.sectionFiles.map((path) => path.toLowerCase())).size).toBe(4);
    expect(host.output.size).toBe(5);
    for (let index = 0; index < 4; index++) {
      expect([...host.output.values()].some((text) => text.includes(`Distinct content ${index}.`))).toBe(true);
    }
    expect(host.output.get(plan.mainTex)).toContain("% Source: paper/100% ablation.md");
    expect(host.output.get(plan.mainTex)).not.toMatch(/\\input\{[^}\n]*%/);
  });

  it("lifts a retained document preamble into the project entry point", async () => {
    const host = project([{
      name: "intro",
      markdown: writeMarkdown(parseLatex("\\documentclass{article}\n\\newcommand{\\foo}{IMPORTANT}\n\\begin{document}\nUse \\foo.\n\\end{document}")),
    }]);
    await exportFolderToLatex(host.plugin.app, host.folder, "article");
    expect(host.output.get("paper/latex/main.tex")).toContain("\\newcommand{\\foo}{IMPORTANT}");
    expect(host.output.get("paper/latex/sections/intro.tex")).toContain("Use \\foo.");
  });

  it("detects incompatible preambles before creating or overwriting anything", async () => {
    const host = project(["article", "book"].map((documentClass, index) => ({
      name: `note-${index}`,
      markdown: writeMarkdown(parseLatex(`\\documentclass{${documentClass}}\n\\begin{document}Body.\\end{document}`)),
    })));
    await expect(exportFolderToLatex(host.plugin.app, host.folder, "article")).rejects.toThrow("different LaTeX preambles");
    expect(host.vault.createFolder).not.toHaveBeenCalled();
    expect(host.vault.create).not.toHaveBeenCalled();
  });
});
