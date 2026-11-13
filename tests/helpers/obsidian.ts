/** Minimal host double; workflow tests still call the real commands and views. */
function createElement(tag: string, options?: string | { text?: string; cls?: string }): HTMLElement {
  const element = document.createElement(tag);
  if (typeof options === "string") element.className = options;
  else {
    if (options?.text) element.textContent = options.text;
    if (options?.cls) element.className = options.cls;
  }
  return element;
}

Object.defineProperties(HTMLElement.prototype, {
  empty: { configurable: true, value(this: HTMLElement) { this.replaceChildren(); } },
  createEl: { configurable: true, value(this: HTMLElement, tag: string, options?: { text?: string; cls?: string }) {
    const element = createElement(tag, options);
    this.append(element);
    return element;
  } },
  createDiv: { configurable: true, value(this: HTMLElement, options?: string | { text?: string; cls?: string }) {
    const element = createElement("div", options);
    this.append(element);
    return element;
  } },
  createSpan: { configurable: true, value(this: HTMLElement, options?: { text?: string; cls?: string }) {
    const element = createElement("span", options);
    this.append(element);
    return element;
  } },
  setText: { configurable: true, value(this: HTMLElement, text: string) { this.textContent = text; } },
  setAttr: { configurable: true, value(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); } },
  addClass: { configurable: true, value(this: HTMLElement, value: string) { this.classList.add(value); } },
  removeClass: { configurable: true, value(this: HTMLElement, value: string) { this.classList.remove(value); } },
});
Object.assign(globalThis, {
  createDiv: (options?: string | { text?: string; cls?: string }) => createElement("div", options),
  createSpan: (options?: { text?: string; cls?: string }) => createElement("span", options),
  createEl: createElement,
});

export const moment = { locale: () => "en" };
export const notices: string[] = [];
export class Notice {
  constructor(message: string) { notices.push(message); }
}
export class Plugin {
  commands: { id: string; [key: string]: unknown }[] = [];
  manifest = { version: "test" };
  constructor(public app: unknown) {}
  addCommand(command: { id: string; [key: string]: unknown }): void { this.commands.push(command); }
  registerEvent(): void {}
  async saveData(): Promise<void> {}
}
export class ItemView {
  contentEl = createElement("div");
  constructor(public leaf: unknown) {}
}
export class MarkdownView extends ItemView {}
export class WorkspaceLeaf {}
export class TFile {
  extension: string;
  basename: string;
  parent: TFolder | null = null;
  constructor(public path = "") {
    this.extension = path.split(".").at(-1) ?? "";
    this.basename = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  }
}
export class TFolder {
  children: (TFile | TFolder)[] = [];
  constructor(public path = "") {}
}
export class Modal {
  contentEl = createElement("div");
  constructor(public app: { modals: Modal[] }) {}
  open(): void { this.app.modals.push(this); (this as unknown as { onOpen?: () => void }).onOpen?.(); }
  close(): void { (this as unknown as { onClose?: () => void }).onClose?.(); }
}
export class FuzzySuggestModal extends Modal {}
export class PluginSettingTab {}
export class Setting {}
export class Menu {}
export class MarkdownRenderChild {}
export const MarkdownRenderer = { async render(): Promise<void> {} };
export const normalizePath = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/");
