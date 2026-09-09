import { Menu, type Editor } from "obsidian";
import { t } from "../i18n";
import type ScholarBridgePlugin from "../main";

/**
 * One-click access points (user-facing convenience layer):
 * - a ribbon icon opening the full action menu;
 * - an editor context-menu section for the selection-oriented actions.
 * Everything dispatches the existing commands by id, so notices, guards and
 * keyboard equivalents stay in one place.
 */

const CMD_PREFIX = "scholar-bridge";

/** App.commands exists at runtime but is absent from the public typings. */
interface CommandCollection {
  executeCommandById(id: string): boolean;
}

const run = (plugin: ScholarBridgePlugin, id: string): void => {
  const commands = (plugin.app as unknown as { commands: CommandCollection }).commands;
  void commands.executeCommandById(`${CMD_PREFIX}:${id}`);
};

const item = (
  menu: Menu,
  title: string,
  icon: string,
  section: string,
  onOpen: () => void,
): void => {
  menu.addItem((mi) => {
    mi.setTitle(title).setIcon(icon).setSection(section).onClick(onOpen);
  });
};

function buildMenu(plugin: ScholarBridgePlugin): Menu {
  const menu = new Menu();
  const status = plugin.serverManager?.status() ?? "stopped";

  item(
    menu,
    status === "ready" ? t("Stop local translator") : t("Start local translator"),
    status === "ready" ? "square" : "play",
    "translator",
    () => run(plugin, status === "ready" ? "stop-local-translator" : "start-local-translator"),
  );
  item(menu, t("Check translator connection"), "activity", "translator", () =>
    run(plugin, "translator-health"),
  );

  item(menu, t("Translate selection"), "languages", "translate", () =>
    run(plugin, "translate-selection"),
  );
  item(menu, t("Translate current section"), "languages", "translate", () =>
    run(plugin, "translate-section"),
  );
  item(menu, t("Translate changed blocks"), "refresh-cw", "translate", () =>
    run(plugin, "translate-changed-blocks"),
  );
  item(menu, t("Open translation preview"), "eye", "translate", () =>
    run(plugin, "open-translation-preview"),
  );

  item(menu, t("Convert selected LaTeX to Obsidian"), "wand", "latex", () =>
    run(plugin, "convert-selection"),
  );
  item(menu, t("Copy selection as LaTeX"), "copy", "latex", () =>
    run(plugin, "copy-selection-latex"),
  );
  item(menu, t("Export current note to LaTeX"), "file-output", "latex", () =>
    run(plugin, "export-note-latex"),
  );
  item(menu, t("Export folder/project to LaTeX"), "folder-output", "latex", () =>
    run(plugin, "export-folder-latex"),
  );

  item(menu, t("Compare current note with..."), "git-compare", "diff", () =>
    run(plugin, "compare-with-note"),
  );
  item(menu, t("Compare two files..."), "git-compare", "diff", () =>
    run(plugin, "compare-two-files"),
  );
  return menu;
}

/**
 * Editor context menu: when text is selected, surface the three
 * selection-oriented actions at the top of the native right-click menu.
 * Without a selection the ScholarBridge section stays out of the way.
 */
function registerEditorMenu(plugin: ScholarBridgePlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
      const selection = editor.getSelection();
      if (!selection?.trim()) return;
      item(menu, t("Translate selection"), "languages", "scholarbridge", () =>
        run(plugin, "translate-selection"),
      );
      item(menu, t("Copy selection as LaTeX"), "copy", "scholarbridge", () =>
        run(plugin, "copy-selection-latex"),
      );
      item(menu, t("Convert selected LaTeX to Obsidian"), "wand", "scholarbridge", () =>
        run(plugin, "convert-selection"),
      );
    }),
  );
}

export function registerQuickAccess(plugin: ScholarBridgePlugin): void {
  plugin.addRibbonIcon("languages", "ScholarBridge", (evt: MouseEvent) => {
    buildMenu(plugin).showAtMouseEvent(evt);
  });
  registerEditorMenu(plugin);
}
