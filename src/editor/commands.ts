import { Notice, MarkdownView, TFile, TFolder, type Editor } from "obsidian";
import { t } from "../i18n";
import type ScholarBridgePlugin from "../main";
import { parseMarkdown } from "../core/parser/markdown/markdown-parser";
import {
  writeLatexFragment,
} from "../core/writer/latex/latex-writer";
import { convertLatexFragment, looksLikeLatex } from "./paste-handler";
import { ChoiceModal, ConfirmModal } from "./modal";
import { exportNoteToLatex, latexExportPath } from "../export/latex-template";
import { exportFolderToLatex } from "../export/project-export";

/**
 * Command + paste registration (PRODUCT_REQUIREMENTS.md FR-1–FR-3).
 */
export function registerEditorFeatures(plugin: ScholarBridgePlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on(
      "editor-paste",
      (evt: ClipboardEvent, editor: Editor) => {
        if (plugin.settings.pasteMode === "never") return;
        if (evt.defaultPrevented) return;
        const text = evt.clipboardData?.getData("text/plain") ?? "";
        if (!text || !looksLikeLatex(text)) return;

        evt.preventDefault();
        const converted = convertLatexFragment(text);
        if (converted === null) {
          // Low confidence: never destroy the pasted source.
          editor.replaceSelection(text);
          return;
        }
        if (plugin.settings.pasteMode === "auto") {
          insertAsOneTransaction(editor, converted);
          new Notice(t("ScholarBridge: converted pasted LaTeX."));
          return;
        }
        new ConfirmModal(plugin.app, {
          title: t("LaTeX detected"),
          message: t("Convert the pasted LaTeX to Obsidian Markdown?"),
          confirmText: t("Convert"),
          onConfirm: () => insertAsOneTransaction(editor, converted),
        }).open();
      },
    ),
  );

  plugin.addCommand({
    id: "convert-selection",
    name: t("Convert selected LaTeX to Obsidian"),
    editorCallback: (editor: Editor) => {
      const selection = editor.getSelection();
      const source = selection || "";
      if (!source.trim()) {
        new Notice(t("ScholarBridge: select LaTeX text first."));
        return;
      }
      const converted = convertLatexFragment(source);
      if (converted === null) {
        new Notice(t("ScholarBridge: nothing recognizable — source kept as-is."));
        return;
      }
      insertAsOneTransaction(editor, converted);
    },
  });

  plugin.addCommand({
    id: "export-note-latex",
    name: t("Export current note to LaTeX"),
    checkCallback: (checking: boolean) => {
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return false;
      if (checking) return true;
      new ChoiceModal(plugin.app, {
        title: t("Export profile"),
        choices: [
          { id: "fragment", label: t("LaTeX fragment") },
          { id: "article", label: t("Complete article") },
          { id: "ctexart", label: t("Chinese/mixed article (ctexart)") },
        ],
        onPick: (id) => void exportCurrentNote(plugin, view, id as "fragment" | "article" | "ctexart"),
      }).open();
      return true;
    },
  });

  plugin.addCommand({
    id: "copy-selection-latex",
    name: t("Copy selection as LaTeX"),
    editorCallback: async (editor: Editor) => {
      const selection = editor.getSelection();
      const source = selection || editor.getValue();
      try {
        // Parsing can throw on unexpected input: keep it inside the guard so
        // the failure surfaces as a notice rather than an unhandled rejection.
        const latex = writeLatexFragment(parseMarkdown(source));
        await navigator.clipboard.writeText(latex);
        new Notice(t("ScholarBridge: LaTeX copied to clipboard."));
      } catch (err) {
        new Notice(
          t("ScholarBridge: could not write to the clipboard — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }),
        );
      }
    },
  });

  plugin.addCommand({
    id: "export-folder-latex",
    name: t("Export folder/project to LaTeX"),
    checkCallback: (checking: boolean) => {
      // The project is the active note's folder (M11 layout: one note per
      // section); the command is offered when that folder holds notes.
      const active = plugin.app.workspace.getActiveFile();
      const parent = active?.parent;
      if (!active || !parent) return false;
      if (checking) return true;
      new ChoiceModal(plugin.app, {
        title: t("Export folder “{{name}}” to LaTeX", { name: parent.name }),
        choices: [
          { id: "article", label: t("Complete article (main.tex + sections/)") },
          { id: "ctexart", label: t("Chinese/mixed article (ctexart)") },
        ],
        onPick: (id) => void exportFolder(plugin, parent, id as "article" | "ctexart"),
      }).open();
      return true;
    },
  });
}

/** FR-3 third command + M11: folder/project → latex/main.tex + sections/. */
async function exportFolder(
  plugin: ScholarBridgePlugin,
  folder: TFolder,
  profile: "article" | "ctexart",
): Promise<void> {
  try {
    // An existing project export is only replaced after an explicit
    // confirmation, mirroring the single-note export policy.
    await exportFolderToLatex(plugin.app, folder, profile);
    new Notice(
      t("ScholarBridge: project exported to {{path}} (sections/ alongside).", { path: `${folder.path}/latex/main.tex` }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("overwrite confirmation required:")) {
      new Notice(t("ScholarBridge export failed: {{msg}}", { msg: message }));
      return;
    }
    const overwrite = await new Promise<boolean>((resolve) => {
      new ConfirmModal(plugin.app, {
        title: t("Overwrite existing project export?"),
        message: t("Some files under {{dir}} already exist ({{list}}). Replace them with the freshly exported LaTeX?", { dir: `${folder.path}/latex`, list: message.replace("overwrite confirmation required: ", "") }),
        confirmText: t("Overwrite"),
        cancelText: t("Cancel"),
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }).open();
    });
    if (!overwrite) return;
    try {
      await exportFolderToLatex(plugin.app, folder, profile, { overwrite: true });
      new Notice(
        t("ScholarBridge: project exported to {{path}} (sections/ alongside).", { path: `${folder.path}/latex/main.tex` }),
      );
    } catch (err2) {
      new Notice(
        t("ScholarBridge export failed: {{msg}}", { msg: err2 instanceof Error ? err2.message : String(err2) }),
      );
    }
  }
}

/** Single editor transaction so conversion is undoable in one step. */
function insertAsOneTransaction(editor: Editor, text: string): void {
  editor.replaceSelection(text);
}

async function exportCurrentNote(
  plugin: ScholarBridgePlugin,
  view: MarkdownView,
  profile: "fragment" | "article" | "ctexart",
): Promise<void> {
  const file = view.file;
  if (!file) return;
  try {
    // An existing export is only replaced after an explicit confirmation —
    // exporting is cheap, losing a hand-edited .tex is not.
    const texPath = latexExportPath(file);
    if (plugin.app.vault.getAbstractFileByPath(texPath) instanceof TFile) {
      const overwrite = await new Promise<boolean>((resolve) => {
        new ConfirmModal(plugin.app, {
          title: t("Overwrite existing export?"),
          message: t("{{path}} already exists. Replace it with the LaTeX exported from this note?", { path: texPath }),
          confirmText: t("Overwrite"),
          cancelText: t("Cancel"),
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }).open();
      });
      if (!overwrite) return;
    }
    const written = await exportNoteToLatex(plugin.app, file, profile, { overwrite: true });
    new Notice(t("ScholarBridge: exported to {{path}}", { path: written }));
  } catch (err) {
    new Notice(t("ScholarBridge export failed: {{msg}}", { msg: err instanceof Error ? err.message : String(err) }));
  }
}
