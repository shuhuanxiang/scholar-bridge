import { stat as fsStat } from "node:fs/promises";
import { MarkdownView, Notice, type Editor } from "obsidian";
import { t } from "../i18n";
import type ScholarBridgePlugin from "../main";
import { parseMarkdown } from "../core/parser/markdown/markdown-parser";
import { hasTranslatableProse, PROMPT_VERSION, translateBlocks, glossaryVersion } from "../translation/translator";
import { ensureTranslatorReady, makeClient } from "./translator-commands";
import { scanFreshness } from "../translation/freshness";
import {
  TRANSLATION_PREVIEW_VIEW_TYPE,
  TranslationPreviewView,
  type PreviewItem,
} from "../views/translation-preview";
import type { ReinsertionInput, SourceRange, WriteMode } from "../translation/reinsertion";
import { validateLlamaSettings, type ScholarBridgeSettings } from "../settings/settings";

/**
 * Translate commands (PRODUCT_REQUIREMENTS.md FR-5).
 * Flow per FR-7: Translate → Preview → Apply (only Apply writes).
 */
export function registerTranslateCommands(plugin: ScholarBridgePlugin): void {
  plugin.addCommand({
    id: "translate-selection",
    name: t("Translate selection"),
    editorCallback: (editor) => {
      // Capture the file path SYNCHRONOUSLY (R2 P1-1): the translation await
      // can take minutes on local inference, and the active note may change
      // meanwhile — a late getActiveFile() would aim the result elsewhere.
      const filePath = plugin.app.workspace.getActiveFile()?.path ?? "";
      void translateTarget(plugin, editor, gatherSelection(editor), filePath);
    },
  });

  plugin.addCommand({
    id: "translate-paragraph",
    name: t("Translate current paragraph"),
    editorCallback: (editor) => {
      const filePath = plugin.app.workspace.getActiveFile()?.path ?? "";
      void translateTarget(plugin, editor, gatherParagraph(editor), filePath);
    },
  });

  plugin.addCommand({
    id: "translate-section",
    name: t("Translate current section"),
    editorCallback: (editor) => {
      const filePath = plugin.app.workspace.getActiveFile()?.path ?? "";
      void translateTarget(plugin, editor, gatherSection(editor), filePath);
    },
  });

  plugin.addCommand({
    id: "translate-changed-blocks",
    name: t("Translate changed blocks"),
    checkCallback: (checking) => {
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file) return false;
      if (checking) return true;
      void translateChangedBlocks(plugin, view.editor, view.file.path);
      return true;
    },
  });

  plugin.addCommand({
    id: "open-translation-preview",
    name: t("Open translation preview"),
    callback: () => void openPreview(plugin),
  });
}

// ---------------------------------------------------------------------------
// Target gathering
// ---------------------------------------------------------------------------

function gatherSelection(editor: Editor): SourceRange | null {
  const sel = editor.listSelections()[0];
  if (!sel) return null;
  const { anchor, head } = sel;
  const startLine = Math.min(anchor.line, head.line);
  const endLine = Math.max(anchor.line, head.line);
  // Replace mode writes whole lines, so translate exactly the full bounding
  // lines — what gets translated must equal what gets replaced.
  const raw = editor.getRange(
    { line: startLine, ch: 0 },
    { line: endLine, ch: editor.getLine(endLine).length },
  );
  if (!raw.trim()) return null;
  return { raw, startLine, endLine };
}

function gatherParagraph(editor: Editor): SourceRange | null {
  const line = editor.getCursor().line;
  if (!editor.getLine(line).trim()) return null;
  let start = line;
  while (start > 0 && editor.getLine(start - 1).trim()) start--;
  let end = line;
  const last = editor.lineCount() - 1;
  while (end < last && editor.getLine(end + 1).trim()) end++;
  return { raw: editor.getRange({ line: start, ch: 0 }, { line: end, ch: editor.getLine(end).length }), startLine: start, endLine: end };
}

function gatherSection(editor: Editor): SourceRange | null {
  const line = editor.getCursor().line;
  const headings = parseMarkdown(editor.getValue()).children.filter((node) => node.type === "heading");
  const heading = headings.filter((node) => (node.source?.startLine ?? Infinity) <= line).at(-1);
  const headingLine = heading?.source?.startLine ?? -1;
  const level = heading?.level ?? null;
  // Body starts below the heading so replace mode never deletes the heading.
  const start = level !== null ? headingLine + 1 : 0;
  let end = editor.lineCount() - 1;
  if (level !== null) {
    const next = headings.find((node) => (node.source?.startLine ?? -1) >= start && node.level <= level);
    if (next) end = next.source!.startLine! - 1;
  }
  while (end >= start && !editor.getLine(end).trim()) end--;
  if (start > end) return null;
  const raw = editor.getRange({ line: start, ch: 0 }, { line: end, ch: editor.getLine(end).length });
  return raw.trim() ? { raw, startLine: start, endLine: end } : null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Persistent cache plumbing (M9, TECHNICAL_DESIGN.md §15). Deliberately NOT
 * applied to preview Retry — a retry asks for a fresh translation by design.
 */
async function cacheOptions(plugin: ScholarBridgePlugin) {
  return {
    cache: plugin.translationCache,
    modelIdentity: await modelIdentity(plugin),
    onCacheDirty: () => void plugin.saveSettings(),
  };
}

/**
 * Cache-key model identity (R3 P3-3): a configured GGUF file contributes its
 * size and mtime, so replacing the model in place invalidates cached
 * translations instead of serving output from the old weights. Connect-only
 * mode only knows the endpoint. Stat failures degrade to the path alone.
 */
async function modelIdentity(plugin: ScholarBridgePlugin): Promise<string> {
  const { modelPath, host, port } = plugin.settings.llama;
  if (!modelPath) return `${host}:${port}`;
  try {
    const st = await nodeStat(modelPath);
    if (st?.isFile()) return `${modelPath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    /* unreadable/outside-vault path: path-only identity */
  }
  return modelPath;
}

async function nodeStat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number } | null> {
  return fsStat(path);
}

/** Share generation settings across ordinary translations, retries and refreshes. */
function generationOptions(settings: ScholarBridgeSettings) {
  validateLlamaSettings(settings.llama);
  return {
    temperature: settings.llama.temperature,
    topP: settings.llama.topP,
    topK: settings.llama.topK,
    maxTokens: settings.llama.maxTokens,
    customPrompt: settings.customPrompt,
    contextSize: settings.llama.contextSize,
  };
}

/**
 * Use full-document syntax context so partial selections inside code, math,
 * metadata and stored translations cannot masquerade as prose.
 */
function splitParagraphs(editor: Editor, range: SourceRange): SourceRange[] {
  const parts: SourceRange[] = [];
  for (const node of parseMarkdown(editor.getValue()).children) {
    if (node.type !== "paragraph" || node.source?.startLine === undefined || node.source.endLine === undefined) continue;
    const startLine = Math.max(range.startLine, node.source.startLine);
    const endLine = Math.min(range.endLine, node.source.endLine);
    if (startLine > endLine) continue;
    const raw = editor.getRange(
      { line: startLine, ch: 0 },
      { line: endLine, ch: editor.getLine(endLine).length },
    );
    if (hasTranslatableProse(raw)) parts.push({ raw, startLine, endLine });
  }
  return parts;
}

async function translateTarget(
  plugin: ScholarBridgePlugin,
  editor: Editor,
  range: SourceRange | null,
  filePath: string,
): Promise<void> {
  if (!range) {
    new Notice(t("ScholarBridge: nothing to translate at the cursor."));
    return;
  }
  const parts = splitParagraphs(editor, range);
  if (parts.length === 0) {
    new Notice(t("ScholarBridge: selection contains no translatable prose."));
    return;
  }

  try {
    const settings = structuredClone(plugin.settings);
    if (!(await ensureTranslatorReady(plugin))) {
      new Notice(translatorNotReadyMessage(plugin));
      return;
    }
    const nodeIdOf = (part: SourceRange): string =>
      `p_${part.startLine}_${Math.abs(hashString(part.raw)).toString(16).slice(0, 8)}`;
    const blocks = parts.map((part) => ({
      nodeId: nodeIdOf(part),
      type: "paragraph" as const,
      sourceText: part.raw.trim(),
    }));
    const { blocks: results, model, problems } = await translateBlocks(
      makeClient(plugin),
      blocks,
      {
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        style: settings.translationStyle,
        glossary: settings.glossary,
        signal: plugin.lifetime.signal,
        ...generationOptions(settings),
        ...(await cacheOptions(plugin)),
      },
    );
    const byId = new Map(results.map((r) => [r.nodeId, r]));
    const items: PreviewItem[] = [];
    for (const part of parts) {
      const nodeId = nodeIdOf(part);
      const result = byId.get(nodeId);
      items.push({
        input: {
          nodeId,
          translation: result?.translation ?? "",
          range: part,
          // Apply-time guard: the target lines must still hold this exact source.
          verifyRaw: part.raw,
          meta: {
            sourceLanguage: settings.sourceLanguage,
            targetLanguage: settings.targetLanguage,
            model,
            glossaryVersion: result?.glossaryVersion ?? glossaryVersion(settings.glossary),
            promptVersion: PROMPT_VERSION,
          },
        },
        included: Boolean(result),
        edited: false,
        failed: !result,
      });
    }
    if (items.every((item) => item.failed)) {
      const detail = problems?.join("; ") ?? "";
      throw new Error(detail || "no paragraphs were translated");
    }
    const failed = items.filter((item) => item.failed).length;
    if (failed > 0) {
      new Notice(t("ScholarBridge: {{n}} paragraph(s) could not be translated — retry them from the preview.", { n: failed }));
    }
    await showPreview(plugin, items, settings.writeMode, filePath);
  } catch (err) {
    if (plugin.lifetime.signal.aborted) return;
    new Notice(t("ScholarBridge: translation failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
  }
}

/** User-facing reason why `ensureTranslatorReady` returned false. */
function translatorNotReadyMessage(plugin: ScholarBridgePlugin): string {
  const detail = plugin.serverManager?.lastErrorMessage();
  if (detail) return t("ScholarBridge: translator not ready — {{detail}}", { detail });
  return plugin.settings.llama.executablePath
    ? t("ScholarBridge: local translator failed to become ready.")
    : t("ScholarBridge: llama-server is not reachable (start it or configure the executable).");
}

export async function showPreview(
  plugin: ScholarBridgePlugin,
  items: PreviewItem[],
  writeMode: WriteMode,
  filePath: string,
): Promise<void> {
  if (plugin.lifetime.signal.aborted) return;
  // Reuse an existing preview leaf: a fresh tab per Translate run would pile
  // up one stale view per invocation.
  const existing = plugin.app.workspace.getLeavesOfType(TRANSLATION_PREVIEW_VIEW_TYPE)[0];
  const leaf = existing ?? plugin.app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: TRANSLATION_PREVIEW_VIEW_TYPE, active: true });
  if (plugin.lifetime.signal.aborted) return;
  const view = leaf.view as TranslationPreviewView;
  if (!view || view.getViewType() !== TRANSLATION_PREVIEW_VIEW_TYPE) {
    new Notice(t("ScholarBridge: could not open preview."));
    return;
  }
  view.retryHandler = (index) => retryItem(plugin, view, index);
  view.setJob({
    // translated-copy previews with the insert-below interleave; the copy
    // itself is written at Apply time (job.writeMode).
    mode: writeMode === "translated-copy" ? "insert-below" : writeMode,
    writeMode,
    items,
    applied: false,
    filePath,
  });
  await plugin.app.workspace.revealLeaf(leaf);
}

async function retryItem(
  plugin: ScholarBridgePlugin,
  view: TranslationPreviewView,
  index: number,
): Promise<void> {
  const job = view.currentJob;
  const item = job?.items[index];
  if (!job || !item) return;
  view.setRetrying(index, true);
  try {
    if (!(await ensureTranslatorReady(plugin))) throw new Error(translatorNotReadyMessage(plugin));
    const { blocks, model } = await translateBlocks(
      makeClient(plugin),
      [{ nodeId: item.input.nodeId, type: "paragraph", sourceText: item.input.range.raw.trim() }],
      {
        sourceLanguage: item.input.meta.sourceLanguage,
        targetLanguage: item.input.meta.targetLanguage,
        style: plugin.settings.translationStyle,
        glossary: plugin.settings.glossary,
        signal: plugin.lifetime.signal,
        ...generationOptions(plugin.settings),
      },
    );
    // The job may have been discarded, applied or replaced while the request
    // ran — only write the result back if THIS job is still on screen and the
    // item is still at that index (a concurrent Reject splices items, R2 P3-5).
    const live = findPreviewView(plugin, job.filePath);
    if (!live || live.currentJob !== job) return;
    if (job.items[index] !== item) return;
    if (blocks[0]) {
      item.input.translation = blocks[0].translation;
      if (item.failed) item.included = true;
      item.failed = false;
      item.edited = false;
      item.input.meta.model = model;
      item.input.meta.glossaryVersion = blocks[0].glossaryVersion;
      item.input.meta.promptVersion = PROMPT_VERSION;
      live.setJob({
        mode: job.mode,
        writeMode: job.writeMode,
        items: job.items,
        applied: false,
        filePath: job.filePath,
      });
    }
  } catch (err) {
    if (plugin.lifetime.signal.aborted) return;
    new Notice(t("ScholarBridge: retry failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
  } finally {
    view.setRetrying(index, false);
  }
}

function findPreviewView(plugin: ScholarBridgePlugin, filePath: string): TranslationPreviewView | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType(TRANSLATION_PREVIEW_VIEW_TYPE)) {
    const view = leaf.view;
    if (view instanceof TranslationPreviewView && view.currentJob?.filePath === filePath) {
      return view;
    }
  }
  return null;
}

function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return hash | 0;
}

/**
 * Translate changed blocks (TECHNICAL_DESIGN.md §14): scan stale
 * translations, re-translate their sources, and let Apply replace each stale
 * block with refreshed translation + updated hash.
 */
async function translateChangedBlocks(
  plugin: ScholarBridgePlugin,
  editor: Editor,
  filePath: string,
): Promise<void> {
  const docText = editor.getValue();
  const docLines = docText.split("\n");
  const report = scanFreshness(docText);
  if (report.invalidStartLines.length > 0) {
    new Notice(t("ScholarBridge: skipped {{n}} damaged translation block(s).", { n: report.invalidStartLines.length }));
  }
  if (report.entries.length === 0) {
    if (report.invalidStartLines.length > 0) return;
    new Notice(t("ScholarBridge: this note has no stored translations."));
    return;
  }
  if (report.staleEntries.length === 0) {
    new Notice(t("ScholarBridge: all translations are up to date."));
    return;
  }

  const stale = report.staleEntries;
  // One request per language pair: a single note can hold blocks translated
  // in different directions, and sending them all under the first block's
  // pair would translate the rest the wrong way round.
  const groups = new Map<
    string,
    { sourceLanguage: string; targetLanguage: string; blocks: { nodeId: string; type: "paragraph"; sourceText: string }[] }
  >();
  for (const entry of stale) {
    const key = `${entry.meta.sourceLanguage}→${entry.meta.targetLanguage}`;
    let group = groups.get(key);
    if (!group) {
      group = { sourceLanguage: entry.meta.sourceLanguage, targetLanguage: entry.meta.targetLanguage, blocks: [] };
      groups.set(key, group);
    }
    group.blocks.push({
      nodeId: entry.sourceNodeId,
      type: "paragraph",
      sourceText: entry.sourceRaw,
    });
  }
  try {
    if (!(await ensureTranslatorReady(plugin))) {
      new Notice(translatorNotReadyMessage(plugin));
      return;
    }
    const byId = new Map<string, { translation: string; glossaryVersion?: string }>();
    let model = "";
    for (const group of groups.values()) {
      const { blocks: results, model: groupModel } = await translateBlocks(makeClient(plugin), group.blocks, {
        sourceLanguage: group.sourceLanguage,
        targetLanguage: group.targetLanguage,
        style: plugin.settings.translationStyle,
        glossary: plugin.settings.glossary,
        signal: plugin.lifetime.signal,
        ...generationOptions(plugin.settings),
        ...(await cacheOptions(plugin)),
      });
      model = model || groupModel;
      for (const r of results) byId.set(r.nodeId, r);
    }
    const items: PreviewItem[] = stale.map((entry) => {
      const translated = byId.get(entry.sourceNodeId);
      const input: ReinsertionInput = {
        nodeId: entry.sourceNodeId,
        translation: translated?.translation ?? "",
        // replace mode overwrites exactly the stale translation block
        range: {
          raw: entry.sourceRaw,
          startLine: entry.translationStartLine,
          endLine: entry.translationEndLine,
        },
        // The range covers the TRANSLATION block, so the apply-time guard
        // must expect the block text as scanned at command start.
        verifyRaw: docLines
          .slice(entry.translationStartLine, entry.translationEndLine + 1)
          .join("\n"),
        verifySource: {
          raw: docLines.slice(entry.sourceStartLine, entry.sourceEndLine + 1).join("\n"),
          startLine: entry.sourceStartLine,
          endLine: entry.sourceEndLine,
        },
        writeMode: entry.meta.writeMode ?? "insert-below",
        meta: {
          sourceLanguage: entry.meta.sourceLanguage,
          targetLanguage: entry.meta.targetLanguage,
          model,
          glossaryVersion: translated?.glossaryVersion ?? entry.meta.glossaryVersion,
          promptVersion: PROMPT_VERSION,
        },
      };
      const failed = !translated?.translation.trim();
      return { input, included: !failed, edited: false, failed };
    });
    // Same failure report as translateTarget: blocks dropped by the per-block
    // fallback reach the preview with an empty translation — point at Retry.
    const failed = items.filter((it) => !it.input.translation.trim()).length;
    if (failed > 0) {
      new Notice(t("ScholarBridge: {{n}} paragraph(s) could not be translated — retry them from the preview.", { n: failed }));
    }
    await showPreview(plugin, items, "replace", filePath);
  } catch (err) {
    if (plugin.lifetime.signal.aborted) return;
    new Notice(t("ScholarBridge: retranslation failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
  }
}

async function openPreview(plugin: ScholarBridgePlugin): Promise<void> {
  if (plugin.lifetime.signal.aborted) return;
  const existing = plugin.app.workspace.getLeavesOfType(TRANSLATION_PREVIEW_VIEW_TYPE)[0];
  if (existing) {
    await plugin.app.workspace.revealLeaf(existing);
    return;
  }
  await showPreview(plugin, [], "insert-below", plugin.app.workspace.getActiveFile()?.path ?? "");
}
