import { MarkdownView, Notice, Plugin, type Editor } from "obsidian";
import { t } from "./i18n";
import {
  DEFAULT_SETTINGS,
  sanitizeGlossary,
  sanitizeLlamaSettings,
  type ScholarBridgeSettings,
} from "./settings/settings";
import { ScholarBridgeSettingTab } from "./settings/settings-tab";
import { SettingsSaveQueue } from "./settings/save-queue";
import { registerEditorFeatures } from "./editor/commands";
import { registerDiffView } from "./views/diff-view";
import {
  autoStartTranslatorIfConfigured,
  registerTranslatorFeatures,
} from "./editor/translator-commands";
import { registerQuickAccess } from "./editor/quick-access";
import { registerTranslateCommands } from "./editor/translate-commands";
import { registerTranslationPreview } from "./views/translation-preview";
import { registerAlgorithmRendering } from "./views/algorithm-render";
import { TranslationCache } from "./translation/cache";
import type { LlamaServerManager } from "./translation/llama/server-manager";
import {
  buildTranslationBlock,
  createTranslatedCopy,
  type ReinsertionInput,
  type WriteMode,
} from "./translation/reinsertion";

/**
 * ScholarBridge — academic writing bridge for Obsidian.
 *
 * Binding rules (PRODUCT_REQUIREMENTS.md §5 / IMPLEMENTATION_PLAN.md §14):
 * - never rewrite user source when parsing is uncertain;
 * - translation previews before any write;
 * - no model startup here: `onload()` must stay cheap.
 */
export default class ScholarBridgePlugin extends Plugin {
  settings: ScholarBridgeSettings = structuredClone(DEFAULT_SETTINGS);
  /** Owned llama-server process; created lazily on explicit user action. */
  serverManager: LlamaServerManager | null = null;
  /** Persistent translation cache (M9); loaded in onload, saved with settings. */
  translationCache: TranslationCache = new TranslationCache();
  private settingsSaves = new SettingsSaveQueue(
    async () => this.saveData(structuredClone({
      ...this.settings,
      translationCache: this.translationCache.toJSON(),
    })),
    (error) => {
      new Notice(t("ScholarBridge: could not save settings — {{msg}}", {
        msg: error instanceof Error ? error.message : String(error),
      }));
    },
  );

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(
      new ScholarBridgeSettingTab(this.app, this, this.settings, () =>
        this.saveSettings(),
      ),
    );

    registerEditorFeatures(this);
    registerDiffView(this);
    registerTranslatorFeatures(this);
    registerTranslateCommands(this);
    registerTranslationPreview(this);
    registerQuickAccess(this);
    registerAlgorithmRendering(this);

    // Opt-in convenience (settings): bring llama-server up once the workspace
    // exists. onload itself stays cheap; the confirm-spawn dialog still
    // applies, so this is never an unattended process spawn.
    this.app.workspace.onLayoutReady(() => {
      void autoStartTranslatorIfConfigured(this);
    });

    // Scaffold placeholder; real commands are registered per milestone.
    this.addCommand({
      id: "status",
      name: t("Show plugin status"),
      callback: () => {
        new Notice(
          t("ScholarBridge {{v}} — scaffold loaded (desktop-only).", { v: this.manifest.version }),
        );
      },
    });
  }

  /**
   * Write accepted translations in one editor transaction (FR-6/FR-7).
   * `translated-copy` creates a sibling note instead of editing the source.
   *
   * The write target is resolved by the job's source file path across ALL
   * open markdown leaves — never by the active leaf — because Apply is
   * clicked inside the preview, which is usually the active leaf itself.
   */
  async applyTranslationJob(
    inputs: ReinsertionInput[],
    mode: WriteMode,
    filePath: string,
  ): Promise<void> {
    const view = this.findMarkdownViewByPath(filePath);
    if (!view || !view.file) {
      throw new Error(
        `note “${filePath}” is not open in any editor — reopen it and re-run Translate`,
      );
    }
    const editor = view.editor;

    this.validateTranslationInputs(editor, inputs);

    if (mode === "translated-copy") {
      const lines = editor.getValue().split("\n");
      const out = createTranslatedCopy(lines, inputs);
      const newPath = `${filePath.replace(/\.md$/, "")}.translated.md`;
      const existing = this.app.vault.getAbstractFileByPath(newPath);
      if (existing) {
        throw new Error(t("ScholarBridge: {{path}} already exists.", { path: newPath }));
      }
      await this.app.vault.create(newPath, out.join("\n"));
      return;
    }

    // CodeMirror transactions require changes sorted ASCENDING by position
    // (they apply atomically against the original document — CODE_REVIEW_R2
    // P1-2). The old descending order threw for multi-block jobs.
    const sorted = [...inputs].sort((a, b) => a.range.startLine - b.range.startLine);
    const lastLine = editor.lineCount() - 1;
    const changes = sorted.map((input) => {
      const block = buildTranslationBlock(input, mode);
      if (mode === "replace") {
        return {
          from: { line: input.range.startLine, ch: 0 },
          to: { line: input.range.endLine, ch: editor.getLine(input.range.endLine).length },
          text: block,
        };
      }
      // insert-below / bilingual: translation lands under the untouched source.
      // When the source is the last line there is no next line to anchor to —
      // append at the end of the document instead.
      if (input.range.endLine >= lastLine) {
        return {
          from: { line: lastLine, ch: editor.getLine(lastLine).length },
          to: { line: lastLine, ch: editor.getLine(lastLine).length },
          text: `\n${block}\n`,
        };
      }
      return {
        from: { line: input.range.endLine + 1, ch: 0 },
        to: { line: input.range.endLine + 1, ch: 0 },
        text: `\n${block}\n`,
      };
    });
    await this.app.workspace.revealLeaf(view.leaf);
    if (view.file?.path !== filePath) {
      throw new Error("the note has changed since translation — re-run Translate");
    }
    this.validateTranslationInputs(editor, inputs);
    editor.transaction({ changes });
  }

  private validateTranslationInputs(editor: Editor, inputs: ReinsertionInput[]): void {
    const lineCount = editor.lineCount();
    for (const input of inputs) {
      if (!input.translation.trim()) throw new Error("translation is empty — retry this block");
      const checks = [
        { ...input.range, raw: input.verifyRaw },
        ...(input.verifySource ? [input.verifySource] : []),
      ];
      for (const range of checks) {
        if (
          !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) ||
          range.startLine < 0 || range.endLine < range.startLine || range.endLine >= lineCount ||
          (range.raw !== undefined && editor.getRange(
            { line: range.startLine, ch: 0 },
            { line: range.endLine, ch: editor.getLine(range.endLine).length },
          ) !== range.raw)
        ) {
          throw new Error("the note has changed since translation — re-run Translate");
        }
      }
    }
  }

  /** First open markdown editor whose file matches the job's source path. */
  private findMarkdownViewByPath(filePath: string): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === filePath) return view;
    }
    return null;
  }

  /**
   * Initiates the llama-server shutdown synchronously: stop() sends SIGTERM
   * immediately and self-bounds with the force-kill timer, so the owned
   * process never outlives the plugin (Obsidian does not await onunload).
   */
  onunload(): void {
    void this.settingsSaves.flush();
    const manager = this.serverManager;
    this.serverManager = null;
    if (!manager) return;
    manager.stop().catch(() => {
      /* shutdown errors must never block unload */
    });
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<ScholarBridgeSettings> & {
      translationCache?: unknown;
    } | null;
    // The cache is stored beside the settings in data.json; keep it out of
    // the typed settings object.
    const { translationCache: storedCache, ...storedSettings } = stored ?? {};
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...storedSettings,
      // Clamp stored numbers: they come from a user-editable data.json and
      // end up in spawn arguments / request URLs.
      llama: sanitizeLlamaSettings({ ...DEFAULT_SETTINGS.llama, ...(stored?.llama ?? {}) }),
      diff: { ...DEFAULT_SETTINGS.diff, ...(stored?.diff ?? {}) },
      // A corrupted/hand-edited data.json must not degrade the glossary into
      // a char-indexed object (CODE_REVIEW_R2 P3-3).
      glossary: sanitizeGlossary(stored?.glossary),
    } as ScholarBridgeSettings;
    // fromJSON drops non-string garbage from a hand-edited file.
    this.translationCache = TranslationCache.fromJSON(storedCache);
  }

  async saveSettings(): Promise<void> {
    await this.settingsSaves.schedule();
  }
}
