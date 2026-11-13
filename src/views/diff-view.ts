import { ItemView, Notice, TFile, WorkspaceLeaf, FuzzySuggestModal } from "obsidian";
import { t } from "../i18n";
import type ScholarBridgePlugin from "../main";
import { diffDocuments, type DocumentDiff, type BlockDiff, type InlineChange } from "../diff/structural-diff";
import { applyAcceptedChanges, serializeBlockLines } from "../diff/diff-apply";
import { blockComparableText } from "../diff/node-text";

export const DIFF_VIEW_TYPE = "scholar-bridge-diff-view";

/**
 * Side-by-side semantic diff view (TECHNICAL_DESIGN.md §17.3).
 * v0.3: per-change accept/reject — accepted changes can be applied to the
 * old file; rejected (default) blocks are never written.
 */
export class DiffView extends ItemView {
  private plugin: ScholarBridgePlugin;
  private oldFile: TFile | null = null;
  private newFile: TFile | null = null;
  private result: DocumentDiff | null = null;
  /** Indices into result.blocks whose change should be applied on Apply. */
  private accepted = new Set<number>();
  /** Guards against out-of-order renders when setFiles is called rapidly. */
  private runId = 0;
  private applying = false;
  private applyBar: HTMLElement | null = null;
  private toggles = new Map<number, HTMLButtonElement>();
  private rowObserver: IntersectionObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ScholarBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = false;
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "ScholarBridge diff";
  }

  getIcon(): string {
    return "file-diff";
  }

  async onOpen(): Promise<void> {
    this.renderEmpty();
  }

  async onClose(): Promise<void> {
    // Invalidate any in-flight computeAndRender(): after its awaits it must
    // not render into the detached contentEl (CODE_REVIEW_R2 P3-4).
    this.runId++;
    this.rowObserver?.disconnect();
    this.rowObserver = null;
  }

  setFiles(oldFile: TFile, newFile: TFile): void {
    this.oldFile = oldFile;
    this.newFile = newFile;
    this.result = null;
    this.accepted.clear();
    void this.computeAndRender();
  }

  private renderEmpty(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "Use “ScholarBridge: Compare current note with…” or “Compare two files…” to start.",
      cls: "scholar-bridge-status",
    });
  }

  private async computeAndRender(): Promise<void> {
    if (!this.oldFile || !this.newFile) return;
    const run = ++this.runId;
    try {
      const [oldText, newText] = await Promise.all([
        this.plugin.app.vault.cachedRead(this.oldFile),
        this.plugin.app.vault.cachedRead(this.newFile),
      ]);
      if (run !== this.runId) return;
      const d = this.plugin.settings.diff;
      this.result = diffDocuments(oldText, newText, "markdown", {
        ignoreWhitespace: d.ignoreWhitespace,
        ignoreWrappers: d.ignoreWrappers,
        ignoreCitations: d.ignoreCitations,
        caseSensitive: d.caseSensitive,
        atomicTerms: Object.keys(this.plugin.settings.glossary),
      });
      this.accepted.clear();
      if (run !== this.runId) return;
      this.renderResult();
    } catch (err) {
      if (run !== this.runId) return;
      new Notice(t("ScholarBridge: diff failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        text: "The diff could not be computed (see notice).",
        cls: "scholar-bridge-status",
      });
    }
  }

  private renderResult(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.rowObserver?.disconnect();
    this.rowObserver = null;
    this.toggles.clear();
    this.applyBar = null;
    if (!this.result || !this.oldFile || !this.newFile) return;

    const header = contentEl.createDiv("scholar-bridge-diff-header");
    header.createEl("strong", { text: `${this.oldFile.basename} → ${this.newFile.basename}` });
    const stats = this.result.stats;
    header.createEl("span", {
      text: t("  {{n}} changed · {{a}} added · {{r}} removed", { n: stats.changed, a: stats.added, r: stats.removed }),
      cls: "scholar-bridge-status",
    });

    this.applyBar = header.createDiv("scholar-bridge-diff-applybar");
    this.renderApplyBar();

    const grid = contentEl.createDiv("scholar-bridge-diff-grid");
    const blocks = this.result.blocks;
    let rendered = 0;
    const appendRows = (count: number) => {
      const end = Math.min(blocks.length, rendered + count);
      while (rendered < end) {
        grid.append(this.renderBlockPair(blocks[rendered], rendered));
        rendered++;
      }
    };
    // Defer offscreen rows; toggling acceptance only updates its own controls.
    if (blocks.length > 200 && typeof IntersectionObserver === "function") {
      appendRows(100);
      const sentinel = contentEl.createDiv("scholar-bridge-diff-sentinel");
      this.rowObserver = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        appendRows(100);
        if (rendered === blocks.length) {
          this.rowObserver?.disconnect();
          sentinel.remove();
        }
      }, { root: contentEl, rootMargin: "400px" });
      this.rowObserver.observe(sentinel);
    } else {
      appendRows(blocks.length);
    }
  }

  private renderApplyBar(): void {
    const applyBar = this.applyBar;
    if (!applyBar || !this.oldFile) return;
    applyBar.empty();
    applyBar.hidden = this.accepted.size === 0;
    if (this.accepted.size > 0) {
      applyBar.createEl("span", {
        text: t("{{n}} change(s) accepted", { n: this.accepted.size }),
        cls: "scholar-bridge-status",
      });
      const apply = applyBar.createEl("button", { text: t("Apply to “{{name}}”", { name: this.oldFile.basename }), cls: "mod-cta" });
      apply.disabled = this.applying;
      apply.addEventListener("click", () => void this.applyAccepted());
      const clear = applyBar.createEl("button", { text: t("Clear") });
      clear.disabled = this.applying;
      clear.addEventListener("click", () => {
        if (this.applying) return;
        this.accepted.clear();
        this.updateAcceptance();
      });
    }
  }

  private updateAcceptance(): void {
    for (const [index, toggle] of this.toggles) {
      const accepted = this.accepted.has(index);
      toggle.setText(accepted ? t("Accepted ✓ (click to reject)") : t("Accept change"));
      toggle.classList.toggle("scholar-bridge-diff-accepted", accepted);
      toggle.setAttribute("aria-pressed", String(accepted));
      toggle.disabled = this.applying;
    }
    this.renderApplyBar();
  }

  /** Apply every accepted change to the old file in one atomic write. */
  private async applyAccepted(): Promise<void> {
    if (!this.oldFile || !this.result || this.accepted.size === 0 || this.applying) return;
    this.applying = true;
    this.updateAcceptance();
    const file = this.oldFile;
    const result = this.result;
    const run = this.runId;
    const accepted = new Set(this.accepted);
    const blocks = this.result.blocks;
    try {
      let applied: number[] = [];
      let skipped: { index: number; reason: string }[] = [];
      await this.plugin.app.vault.process(file, (text) => {
        if (this.plugin.lifetime.signal.aborted) throw new Error("plugin unloaded");
        if (run !== this.runId || this.result !== result || this.oldFile !== file) {
          throw new Error("comparison changed before the changes could be applied");
        }
        for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view as { file?: TFile; editor?: { getValue(): string } };
          if (view.file?.path === file.path && view.editor && view.editor.getValue() !== text) {
            throw new Error("the note has unsaved edits; compare again after saving");
          }
        }
        const res = applyAcceptedChanges(text, blocks, accepted);
        applied = res.applied;
        skipped = res.skipped;
        return res.text;
      });
      if (this.result !== result || this.oldFile !== file) return;
      this.accepted.clear();
      if (skipped.length > 0) {
        new Notice(
          t("ScholarBridge: applied {{n}} change(s); skipped {{s}} (original block not found verbatim — the note may have changed).", { n: applied.length, s: skipped.length }),
        );
      } else {
        new Notice(t("ScholarBridge: applied {{n}} change(s) to {{name}}.", { n: applied.length, name: file.basename }));
      }
      await this.computeAndRender();
    } catch (err) {
      new Notice(t("ScholarBridge: apply failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.applying = false;
      this.updateAcceptance();
    }
  }

  private renderBlockPair(block: BlockDiff, index: number): HTMLElement {
    const wrapper = createDiv("scholar-bridge-diff-rowwrap");
    const row = wrapper.createDiv("scholar-bridge-diff-row");
    const left = createDiv(`scholar-bridge-diff-cell scholar-bridge-status-${block.status === "equal" ? "equal" : block.status}`);
    const right = createDiv(`scholar-bridge-diff-cell scholar-bridge-status-${block.status === "equal" ? "equal" : block.status}`);

    switch (block.status) {
      case "equal": {
        const text = this.plainOf(block.newNode ?? block.oldNode);
        left.textContent = text;
        right.textContent = text;
        break;
      }
      case "added": {
        left.textContent = "";
        right.textContent = this.plainOf(block.newNode);
        break;
      }
      case "removed": {
        left.textContent = this.plainOf(block.oldNode);
        right.textContent = "";
        break;
      }
      case "changed": {
        if (block.oldNode?.type === "code" && block.newNode?.type === "code" &&
          block.oldNode.language !== block.newNode.language) {
          left.textContent = serializeBlockLines(block.oldNode).join("\n");
          right.textContent = serializeBlockLines(block.newNode).join("\n");
        } else if (block.tableChanges?.some((cell) => cell.status !== "equal")) {
          left.textContent = this.plainOf(block.oldNode);
          right.textContent = this.plainOf(block.newNode);
          const detail = createDiv("scholar-bridge-diff-table");
          for (const cell of block.tableChanges) {
            if (cell.status === "equal") continue;
            // table-diff reports removed rows against the OLD table
            // (oldRow/newRow when the parallel change has landed).
            const coords = cell as { oldRow?: number; newRow?: number };
            const rowIndex =
              cell.status === "removed" ? (coords.oldRow ?? cell.row) : (coords.newRow ?? cell.row);
            const line = detail.createDiv("scholar-bridge-diff-cellchange");
            line.createEl("span", { text: `r${rowIndex + 1}c${cell.col + 1}`, cls: "scholar-bridge-diff-token" });
            if (cell.oldText) line.createEl("del", { text: cell.oldText });
            if (cell.status === "changed") line.createEl("span", { text: " → " });
            if (cell.newText) line.createEl("ins", { text: cell.newText });
          }
          right.append(detail);
        } else if (block.changes?.some((change) => change.op !== "equal")) {
          left.append(renderInlineChanges(block.changes, "old"));
          right.append(renderInlineChanges(block.changes, "new"));
        } else {
          left.textContent = block.oldNode?.source?.raw ?? this.plainOf(block.oldNode);
          right.textContent = block.newNode?.source?.raw ?? this.plainOf(block.newNode);
        }
        break;
      }
    }
    row.append(left, right);

    // Per-change accept toggle (v0.3): every non-equal block can be marked
    // for application to the old file; default is reject (never write).
    if (block.status !== "equal") {
      const actions = wrapper.createDiv("scholar-bridge-diff-actions");
      const isAccepted = this.accepted.has(index);
      const toggle = actions.createEl("button", {
        text: isAccepted ? t("Accepted ✓ (click to reject)") : t("Accept change"),
        cls: isAccepted ? "scholar-bridge-diff-accepted" : undefined,
      });
      this.toggles.set(index, toggle);
      toggle.disabled = this.applying;
      toggle.setAttribute("aria-pressed", String(isAccepted));
      toggle.addEventListener("click", () => {
        if (this.applying) return;
        if (this.accepted.has(index)) this.accepted.delete(index);
        else this.accepted.add(index);
        toggle.setText(this.accepted.has(index) ? t("Accepted ✓ (click to reject)") : t("Accept change"));
        toggle.classList.toggle("scholar-bridge-diff-accepted", this.accepted.has(index));
        toggle.setAttribute("aria-pressed", String(this.accepted.has(index)));
        this.renderApplyBar();
      });
    }

    return wrapper;
  }

  private plainOf(node: BlockDiff["oldNode"]): string {
    if (!node) return "";
    return blockComparableText(node, {
      ignoreWhitespace: false,
      ignoreWrappers: false,
      ignoreCitations: false,
      caseSensitive: true,
    });
  }
}

function renderInlineChanges(changes: InlineChange[], side: "old" | "new"): HTMLElement {
  const container = createDiv("scholar-bridge-diff-inline");
  for (const change of changes) {
    switch (change.op) {
      case "equal":
        container.append(createSpan({ text: change.text }));
        break;
      case "insert":
        if (side === "new") container.append(createEl("ins", { text: change.text }));
        break;
      case "delete":
        if (side === "old") container.append(createEl("del", { text: change.text }));
        break;
      case "replace":
        if (side === "old") container.append(createEl("del", { text: change.oldText ?? "" }));
        else container.append(createEl("ins", { text: change.text }));
        break;
    }
  }
  return container;
}

/** Fuzzy file picker for diff commands. */
class FilePickerModal extends FuzzySuggestModal<TFile> {
  private plugin: ScholarBridgePlugin;
  private onPick: (file: TFile) => void;

  constructor(plugin: ScholarBridgePlugin, onPick: (file: TFile) => void, placeholder?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = onPick;
    if (placeholder) this.setPlaceholder(placeholder);
  }

  getItems(): TFile[] {
    return this.plugin.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

export function registerDiffView(plugin: ScholarBridgePlugin): void {
  plugin.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, plugin));

  plugin.addCommand({
    id: "compare-with-note",
    name: t("Compare current note with..."),
    checkCallback: (checking) => {
      const active = plugin.app.workspace.getActiveFile();
      if (!active) return false;
      if (checking) return true;
      new FilePickerModal(plugin, (other) => {
        void openDiff(plugin, active, other);
      }, t("Compare with which note?")).open();
      return true;
    },
  });

  plugin.addCommand({
    id: "compare-two-files",
    name: t("Compare two files..."),
    checkCallback: (checking) => {
      if (checking) return plugin.app.vault.getMarkdownFiles().length >= 2;
      new FilePickerModal(plugin, (first) => {
        new FilePickerModal(plugin, (second) => {
          void openDiff(plugin, first, second);
        }, t("…compare against which note?")).open();
      }, t("Compare which note?")).open();
      return true;
    },
  });
}

async function openDiff(plugin: ScholarBridgePlugin, oldFile: TFile, newFile: TFile): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
  const view = leaf.view;
  if (view instanceof DiffView) {
    view.setFiles(oldFile, newFile);
    await plugin.app.workspace.revealLeaf(leaf);
  } else {
    new Notice(t("ScholarBridge: could not open diff view."));
  }
}
