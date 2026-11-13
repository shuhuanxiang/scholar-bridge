import { vi } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import type { App, Editor, EditorPosition, EditorTransaction, WorkspaceLeaf } from "obsidian";
import ScholarBridgePlugin from "../../src/main";
import { TranslationPreviewView } from "../../src/views/translation-preview";

export function createEditor(initial: string) {
  let value = initial;
  let anchor: EditorPosition = { line: 0, ch: 0 };
  let head: EditorPosition = { line: value.split("\n").length - 1, ch: value.split("\n").at(-1)!.length };
  const offset = (position: EditorPosition): number => {
    const lines = value.split("\n");
    if (position.line < 0 || position.line >= lines.length || position.ch > lines[position.line].length) {
      throw new Error("invalid editor position");
    }
    return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.ch;
  };
  const editor = {
    getValue: () => value,
    setValue: (next: string) => { value = next; },
    getLine: (line: number) => value.split("\n")[line],
    lineCount: () => value.split("\n").length,
    getCursor: () => head,
    setSelection: (nextAnchor: EditorPosition, nextHead = nextAnchor) => { anchor = nextAnchor; head = nextHead; },
    listSelections: () => [{ anchor, head }],
    getSelection: () => value.slice(Math.min(offset(anchor), offset(head)), Math.max(offset(anchor), offset(head))),
    getRange: (from: EditorPosition, to: EditorPosition) => value.slice(offset(from), offset(to)),
    transaction: vi.fn((transaction: EditorTransaction) => {
      const edits = (transaction.changes ?? []).map((change) => ({
        from: offset(change.from), to: offset(change.to ?? change.from), text: change.text,
      }));
      for (let i = 1; i < edits.length; i++) {
        if (edits[i].from < edits[i - 1].to) throw new Error("overlapping or unsorted edits");
      }
      for (const edit of [...edits].reverse()) value = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    }),
    replaceSelection: (text: string) => {
      const from = offset(anchor) < offset(head) ? anchor : head;
      const to = from === anchor ? head : anchor;
      editor.transaction({ changes: [{ from, to, text }] });
    },
  };
  return editor as typeof editor & Editor;
}

export function workflow(initial = "Source.") {
  const editor = createEditor(initial);
  const events = new Map<string, (...args: unknown[]) => void>();
  const markdownLeaf = {} as WorkspaceLeaf;
  const previewLeaf = { setViewState: vi.fn(async () => {}) } as unknown as WorkspaceLeaf;
  const view = Object.assign(new MarkdownView(markdownLeaf), { editor, file: new TFile("note.md") });
  Object.assign(markdownLeaf, { view });
  const app = {
    modals: [] as { close(): void; contentEl: HTMLElement }[],
    vault: {
      getAbstractFileByPath: vi.fn(() => null),
      create: vi.fn(async () => new TFile()),
    },
    metadataCache: { getFirstLinkpathDest: vi.fn(() => null) },
    workspace: {
      getActiveFile: () => view.file,
      getActiveViewOfType: () => view,
      getLeavesOfType: (type: string) => type === "markdown" ? [markdownLeaf] : [previewLeaf],
      getLeaf: () => previewLeaf,
      revealLeaf: vi.fn(async () => {}),
      on: (name: string, handler: (...args: unknown[]) => void) => { events.set(name, handler); },
    },
  };
  const plugin = new ScholarBridgePlugin(app as unknown as App, {} as never);
  const preview = new TranslationPreviewView(previewLeaf, plugin);
  Object.assign(previewLeaf, { view: preview });
  return { editor, events, app, plugin, preview, view };
}
