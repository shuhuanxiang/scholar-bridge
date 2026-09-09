import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import type ScholarBridgePlugin from "../main";
import type { ReinsertionInput, WriteMode } from "../translation/reinsertion";

export const TRANSLATION_PREVIEW_VIEW_TYPE = "scholar-bridge-translation-preview";

/**
 * Translation preview (TECHNICAL_DESIGN.md §17.4).
 *
 * Per block: source, proposed translation, Accept / Retry / Edit / Reject.
 * Only the global `Apply` button writes to the note. A job is bound to the
 * file it was translated from; Apply refuses to touch any other note.
 */

export interface PreviewItem {
  input: ReinsertionInput;
  included: boolean;
  edited: boolean;
}

export interface PreviewJob {
  /** Display mode: how blocks interleave in the preview. */
  mode: WriteMode;
  /** Real write mode carried through to Apply (may differ from `mode`). */
  writeMode: WriteMode;
  items: PreviewItem[];
  applied: boolean;
  /** Vault path of the note the line ranges refer to. */
  filePath: string;
}

export class TranslationPreviewView extends ItemView {
  private plugin: ScholarBridgePlugin;
  private job: PreviewJob | null = null;
  /** Indices with a retry request in flight; their buttons render disabled. */
  private retryingIndices = new Set<number>();
  /** Wired by the translate command so Retry re-runs a single block. */
  retryHandler: ((index: number) => Promise<void>) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ScholarBridgePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TRANSLATION_PREVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "ScholarBridge translation preview";
  }

  getIcon(): string {
    return "languages";
  }

  async onOpen(): Promise<void> {
    if (!this.job) this.renderEmpty();
  }

  setJob(job: PreviewJob): void {
    this.job = job;
    this.render();
  }

  /** Current job, or null after Discard — lets Retry verify identity after awaits. */
  get currentJob(): PreviewJob | null {
    return this.job;
  }

  /** Track an in-flight retry so its button cannot fire twice. */
  setRetrying(index: number, inFlight: boolean): void {
    if (inFlight) this.retryingIndices.add(index);
    else this.retryingIndices.delete(index);
    this.render();
  }

  private renderEmpty(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "Run “ScholarBridge: Translate selection / paragraph / section” to fill this preview.",
      cls: "scholar-bridge-status",
    });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const job = this.job;
    if (!job) {
      this.renderEmpty();
      return;
    }

    const header = contentEl.createDiv("scholar-bridge-preview-header");
    header.createEl("strong", { text: `Translation preview — ${job.items.length} block(s)` });
    const controls = header.createDiv("scholar-bridge-preview-controls");
    controls.createEl("button", { text: t("Apply"), cls: "mod-cta" }).addEventListener("click", () => {
      void this.applyJob();
    });
    controls.createEl("button", { text: t("Discard all") }).addEventListener("click", () => {
      this.job = null;
      this.renderEmpty();
    });

    job.items.forEach((item, index) => {
      contentEl.append(this.renderItem(item, index));
    });
  }

  private renderItem(item: PreviewItem, index: number): HTMLElement {
    const card = createDiv("scholar-bridge-preview-card");

    const sourceRow = card.createDiv("scholar-bridge-preview-row");
    sourceRow.createEl("span", { text: t("Source"), cls: "scholar-bridge-preview-label" });
    sourceRow.createEl("div", { text: item.input.range.raw, cls: "scholar-bridge-preview-source" });

    const translationRow = card.createDiv("scholar-bridge-preview-row");
    translationRow.createEl("span", {
      text: item.edited ? t("Translation (edited)") : t("Translation"),
      cls: "scholar-bridge-preview-label",
    });
    const textarea = translationRow.createDiv("scholar-bridge-preview-translation").createEl("textarea", {
      cls: "scholar-bridge-preview-textarea",
    });
    textarea.value = item.input.translation;
    // `input` (not `change`) so an Apply right after typing cannot drop the
    // last edit when the textarea never lost focus.
    textarea.addEventListener("input", () => {
      item.input.translation = textarea.value;
      item.edited = true;
    });

    const actions = card.createDiv("scholar-bridge-preview-actions");
    const acceptBtn = actions.createEl("button", {
      text: item.included ? t("✓ Accepted") : t("Accept"),
      cls: item.included ? "mod-cta" : "",
    });
    acceptBtn.addEventListener("click", () => {
      item.included = !item.included;
      this.render();
    });
    const retryBtn = actions.createEl("button", { text: t("Retry") });
    retryBtn.disabled = this.retryingIndices.has(index);
    retryBtn.addEventListener("click", () => {
      void this.retryHandler?.(index);
    });
    actions.createEl("button", { text: t("Edit") }).addEventListener("click", () => {
      textarea.focus();
      textarea.select();
    });
    const rejectBtn = actions.createEl("button", { text: t("Reject") });
    // A retry is in flight for this index — removing the item now would
    // shift indices under the retry's result write-back (CODE_REVIEW_R2 P3-5).
    rejectBtn.disabled = this.retryingIndices.has(index);
    rejectBtn.addEventListener("click", () => {
      this.retryingIndices.delete(index);
      this.job?.items.splice(index, 1);
      this.render();
    });

    return card;
  }

  private async applyJob(): Promise<void> {
    const job = this.job;
    if (!job || job.applied) return;
    const included = job.items.filter((i) => i.included);
    if (!included.length) {
      new Notice(t("ScholarBridge: nothing accepted to apply."));
      return;
    }
    try {
      // The target note is resolved by path inside applyTranslationJob — the
      // preview does not have to be (and usually is not) the active leaf.
      await this.plugin.applyTranslationJob(
        included.map((i) => i.input),
        job.writeMode,
        job.filePath,
      );
      job.applied = true;
      new Notice(t("ScholarBridge: applied {{n}} translation block(s).", { n: included.length }));
      this.job = null;
      this.renderEmpty();
    } catch (err) {
      new Notice(t("ScholarBridge: apply failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  }
}

export function registerTranslationPreview(plugin: ScholarBridgePlugin): void {
  plugin.registerView(TRANSLATION_PREVIEW_VIEW_TYPE, (leaf) => new TranslationPreviewView(leaf, plugin));
}
