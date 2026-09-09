import { App, Modal } from "obsidian";
import { t } from "../i18n";

/** Minimal confirmation modal used by paste-ask mode and export profiles. */
export class ConfirmModal extends Modal {
  private title: string;
  private message: string;
  private confirmText: string;
  private cancelText: string;
  private onConfirm: () => void;
  private onCancel?: () => void;
  private confirmed = false;

  constructor(
    app: App,
    opts: {
      title: string;
      message: string;
      confirmText?: string;
      cancelText?: string;
      onConfirm: () => void;
      onCancel?: () => void;
    },
  ) {
    super(app);
    this.title = opts.title;
    this.message = opts.message;
    this.confirmText = opts.confirmText ?? t("Confirm");
    this.cancelText = opts.cancelText ?? t("Keep original");
    this.onConfirm = opts.onConfirm;
    this.onCancel = opts.onCancel;
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.title });
    this.contentEl.createEl("p", { text: this.message });
    const buttons = this.contentEl.createDiv("scholar-bridge-button-row");
    buttons
      .createEl("button", { text: this.confirmText, cls: "mod-cta" })
      .addEventListener("click", () => {
        this.confirmed = true;
        this.close();
        this.onConfirm();
      });
    buttons.createEl("button", { text: this.cancelText }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    if (!this.confirmed) this.onCancel?.();
    this.contentEl.empty();
  }
}

/** Choice modal for export profiles. */
export class ChoiceModal extends Modal {
  private title: string;
  private choices: { id: string; label: string }[];
  private onPick: (id: string) => void;

  constructor(
    app: App,
    opts: { title: string; choices: { id: string; label: string }[]; onPick: (id: string) => void },
  ) {
    super(app);
    this.title = opts.title;
    this.choices = opts.choices;
    this.onPick = opts.onPick;
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.title });
    for (const choice of this.choices) {
      this.contentEl
        .createEl("button", { text: choice.label, cls: "mod-cta" })
        .addEventListener("click", () => {
          this.close();
          this.onPick(choice.id);
        });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
