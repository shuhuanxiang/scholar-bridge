import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { t } from "../i18n";
import { LLAMA_NUMBER_RULES, parseLlamaNumber, type LlamaNumberKey, type ScholarBridgeSettings } from "./settings";
import { parseGlossaryYaml } from "./glossary-yaml";

export class ScholarBridgeSettingTab extends PluginSettingTab {
  private settings: ScholarBridgeSettings;
  private onChange: () => void;

  constructor(
    app: App,
    plugin: Plugin,
    settings: ScholarBridgeSettings,
    onChange: () => void,
  ) {
    super(app, plugin);
    this.settings = settings;
    this.onChange = onChange;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName(t("Conversion")).setHeading();
    new Setting(containerEl)
      .setName(t("LaTeX paste handling"))
      .setDesc(t("What to do when pasted text looks like LaTeX."))
      .addDropdown((d) =>
        d
          .addOptions({ auto: t("Auto convert"), ask: t("Ask"), never: t("Never") })
          .setValue(this.settings.pasteMode)
          .onChange(async (v) => {
            this.settings.pasteMode = v as ScholarBridgeSettings["pasteMode"];
            this.onChange();
          }),
      );

    new Setting(containerEl).setName(t("Local translation (llama.cpp)")).setHeading();
    new Setting(containerEl)
      .setName(t("llama-server executable"))
      .setDesc(t("Leave empty to connect to an already running server only."))
      .addText((t) =>
        t
          .setValue(this.settings.llama.executablePath)
          .onChange(async (v) => {
            this.settings.llama.executablePath = v.trim();
            this.onChange();
          }),
      );
    new Setting(containerEl).setName(t("GGUF model file")).addText((t) =>
      t.setValue(this.settings.llama.modelPath).onChange(async (v) => {
        this.settings.llama.modelPath = v.trim();
        this.onChange();
      }),
    );
    new Setting(containerEl).setName(t("Host")).addText((t) =>
      t.setValue(this.settings.llama.host).onChange(async (v) => {
        this.settings.llama.host = v.trim() || "127.0.0.1";
        this.onChange();
      }),
    );
    this.numberSetting(containerEl, "port", "Port");
    this.numberSetting(containerEl, "gpuLayers", "GPU layers", "Number of layers to offload to the GPU (0 = CPU only).");
    this.numberSetting(containerEl, "contextSize", "Context size");
    this.numberSetting(containerEl, "temperature", "Temperature");
    this.numberSetting(containerEl, "topP", "Top p", "Nucleus sampling probability, from 0 to 1.");
    this.numberSetting(containerEl, "topK", "Top k", "Number of token candidates to sample from; 0 disables top-k sampling.");
    this.numberSetting(containerEl, "maxTokens", "Maximum output tokens", "Maximum generated tokens per request, including JSON; 0 uses the server default.");
    this.numberSetting(containerEl, "idleShutdownMinutes", "Idle shutdown (minutes)", "Stop the local server after this many idle minutes; 0 keeps it running.");
    this.numberSetting(containerEl, "requestTimeoutMs", "Request timeout (ms)", "Abort a translation request after this many milliseconds (minimum 1000).");
    new Setting(containerEl)
      .setName(t("Confirm server start"))
      .setDesc(t("Ask before spawning the local llama-server process."))
      .addToggle((t) =>
        t.setValue(this.settings.llama.confirmSpawn).onChange(async (v) => {
          this.settings.llama.confirmSpawn = v;
          this.onChange();
        }),
      );
    new Setting(containerEl)
      .setName(t("Start translator on launch"))
      .setDesc(
        t(
          "Bring llama-server up automatically after Obsidian opens, so translation is always one click away. The confirm dialog above still applies.",
        ),
      )
      .addToggle((t) =>
        t.setValue(this.settings.autoStartTranslator).onChange(async (v) => {
          this.settings.autoStartTranslator = v;
          this.onChange();
        }),
      );

    new Setting(containerEl).setName(t("Translation")).setHeading();
    new Setting(containerEl).setName(t("Source language")).addDropdown((d) =>
      d
        .addOptions({ zh: t("Chinese"), en: t("English") })
        .setValue(this.settings.sourceLanguage)
        .onChange(async (v) => {
          this.settings.sourceLanguage = v;
          this.onChange();
        }),
    );
    new Setting(containerEl).setName(t("Target language")).addDropdown((d) =>
      d
        .addOptions({ zh: t("Chinese"), en: t("English") })
        .setValue(this.settings.targetLanguage)
        .onChange(async (v) => {
          this.settings.targetLanguage = v;
          this.onChange();
        }),
    );
    new Setting(containerEl).setName(t("Translation style")).addDropdown((d) =>
      d
        .addOptions({ academic: t("Academic"), plain: t("Plain"), literal: t("Literal") })
        .setValue(this.settings.translationStyle)
        .onChange(async (v) => {
          this.settings.translationStyle = v as ScholarBridgeSettings["translationStyle"];
          this.onChange();
        }),
    );
    new Setting(containerEl)
      .setName(t("Custom translation prompt"))
      .setDesc(t("Leave empty for the default prompt. Language, style, glossary, JSON and placeholder rules are added automatically."))
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.setValue(this.settings.customPrompt).onChange(async (v) => {
          this.settings.customPrompt = v;
          this.onChange();
        });
      });
    new Setting(containerEl).setName(t("Write mode")).addDropdown((d) =>
      d
        .addOptions({
          "insert-below": t("Insert below source"),
          replace: t("Replace source"),
          "translated-copy": t("Create translated copy"),
          bilingual: t("Bilingual interleave"),
        })
        .setValue(this.settings.writeMode)
        .onChange(async (v) => {
          this.settings.writeMode = v as ScholarBridgeSettings["writeMode"];
          this.onChange();
        }),
    );
    new Setting(containerEl)
      .setName(t("Glossary"))
      .setDesc(
        t(
          "One entry per line: term => fixed translation. Use “term => preserve” to keep a term untranslated. “|” is also accepted as the separator.",
        ),
      )
      .addTextArea((t) =>
        t
          .setPlaceholder("neural network => 神经网络\ntensor => preserve")
          .setValue(serializeGlossary(this.settings.glossary))
          .onChange(async (v) => {
            this.settings.glossary = parseGlossary(v);
            this.onChange();
          }),
      )
      .addButton((b) =>
        b.setButtonText(t("Import YAML…")).onClick(() => {
          new GlossaryImportModal(this.app, {
            onImport: async (imported, skipped) => {
              // Imported entries override colliding flat entries; the rest of
              // the glossary is kept (merge, not replace).
              this.settings.glossary = { ...this.settings.glossary, ...imported };
              this.onChange();
              const importedCount = Object.keys(imported).length;
              const detail = skipped.length ? t(" Skipped {{n}} unusable entr{{suffix}}.", { n: skipped.length, suffix: skipped.length === 1 ? "y" : "ies" }) : "";
              new Notice(t("ScholarBridge: imported {{n}} glossary entr{{suffix}}.{{detail}}", { n: importedCount, suffix: importedCount === 1 ? "y" : "ies", detail }));
              this.display();
            },
          }).open();
        }),
      );

    new Setting(containerEl).setName(t("Diff")).setHeading();
    for (const [key, label] of [
      ["ignoreWhitespace", t("Ignore whitespace")],
      ["ignoreWrappers", t("Ignore Markdown/LaTeX wrapper formatting")],
      ["ignoreCitations", t("Ignore citation/reference changes")],
      ["caseSensitive", t("Case sensitive")],
    ] as const) {
      new Setting(containerEl)
        .setName(label)
        .addToggle((t) =>
          t.setValue(this.settings.diff[key]).onChange(async (v) => {
            this.settings.diff[key] = v;
            this.onChange();
          }),
        );
    }
  }

  private numberSetting(container: HTMLElement, key: LlamaNumberKey, label: string, description?: string): void {
    const rule = LLAMA_NUMBER_RULES[key];
    const setting = new Setting(container).setName(t(label));
    if (description) setting.setDesc(t(description));
    setting.addText((control) => {
      control.inputEl.type = "number";
      control.inputEl.min = String(rule.min);
      control.inputEl.max = String(rule.max);
      control.inputEl.step = rule.integer ? "1" : "any";
      control.setValue(String(this.settings.llama[key])).onChange((text) => {
        const value = parseLlamaNumber(key, text);
        control.inputEl.setCustomValidity(value === null
          ? t("Enter a value between {{min}} and {{max}}.", { min: rule.min, max: rule.max }) : "");
        control.inputEl.setAttribute("aria-invalid", String(value === null));
        if (value === null) return;
        this.settings.llama[key] = value;
        this.onChange();
      });
      control.inputEl.addEventListener("blur", () => control.inputEl.reportValidity());
    });
  }
}

/** Glossary as editable text: `term => translation` (or `|`) per line. */
function serializeGlossary(glossary: Record<string, string>): string {
  return Object.entries(glossary)
    .map(([term, value]) => `${term} => ${value}`)
    .join("\n");
}

/** Lines without a recognizable `term => value` separator are skipped. */
function parseGlossary(text: string): Record<string, string> {
  const glossary: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    const sep = entry.includes("=>") ? "=>" : "|";
    const idx = entry.indexOf(sep);
    if (idx <= 0) continue;
    const term = entry.slice(0, idx).trim();
    const value = entry.slice(idx + sep.length).trim();
    if (!term || !value) continue;
    // protector.ts treats any-case "preserve" as keep-verbatim; normalize it.
    glossary[term] = value.toLowerCase() === "preserve" ? "preserve" : value;
  }
  return glossary;
}

/** Paste-in YAML import modal (TECHNICAL_DESIGN.md §16 nested form). */
class GlossaryImportModal extends Modal {
  private onImport: (imported: Record<string, string>, skipped: string[]) => Promise<void>;

  constructor(
    app: App,
    opts: { onImport: (imported: Record<string, string>, skipped: string[]) => Promise<void> },
  ) {
    super(app);
    this.onImport = opts.onImport;
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: t("Import glossary from YAML") });
    this.contentEl.createEl("p", {
      text: t(
        "Nested form: a term line, then indented “action: preserve” or “zh: translation”. Imported entries override colliding ones.",
      ),
    });
    const textarea = this.contentEl.createEl("textarea", { cls: "scholar-bridge-import-textarea" });
    textarea.rows = 12;
    textarea.setAttr("placeholder", "FedContra:\n  action: preserve\n\nfederated learning:\n  zh: 联邦学习");
    const buttons = this.contentEl.createDiv("scholar-bridge-button-row");
    buttons
      .createEl("button", { text: t("Import"), cls: "mod-cta" })
      .addEventListener("click", () => {
        const { entries, skipped } = parseGlossaryYaml(textarea.value);
        void this.onImport(entries, skipped);
        this.close();
      });
    buttons.createEl("button", { text: t("Cancel") }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
