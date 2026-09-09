import { Notice } from "obsidian";
import type ScholarBridgePlugin from "../main";
import { LlamaClient } from "../translation/llama/client";
import {
  LlamaServerManager,
  createNodeSpawner,
} from "../translation/llama/server-manager";
import { ConfirmModal } from "./modal";
import { t } from "../i18n";

/**
 * Translator lifecycle UI: status bar (§17.2) + Start/Stop commands (FR-5).
 * Never called during onload — only on explicit user action.
 */
export function registerTranslatorFeatures(plugin: ScholarBridgePlugin): void {
  const statusBar = plugin.addStatusBarItem();
  let lastStatusClass = "";
  const updateStatusBar = (text: string, cls: string) => {
    statusBar.setText(` ${text}`);
    if (lastStatusClass && lastStatusClass !== cls) statusBar.removeClass(lastStatusClass);
    statusBar.addClass(cls);
    lastStatusClass = cls;
  };

  const refresh = () => {
    const manager = plugin.serverManager;
    if (!manager) {
      updateStatusBar(t("○ Translator stopped"), "scholar-bridge-status");
      return;
    }
    switch (manager.status()) {
      case "ready":
        updateStatusBar(t("● Translator ready"), "scholar-bridge-status-ok");
        break;
      case "starting":
        updateStatusBar(t("◐ Loading model"), "scholar-bridge-status-warn");
        break;
      case "error":
        updateStatusBar(t("! Translator error"), "scholar-bridge-status-error");
        break;
      default:
        updateStatusBar(t("○ Translator stopped"), "scholar-bridge-status");
    }
  };
  refresh();

  // Clicking the status item toggles the translator — no command palette trip.
  statusBar.addClass("mod-clickable");
  statusBar.setAttribute("aria-label", "ScholarBridge translator — click to start/stop");
  plugin.registerDomEvent(statusBar, "click", () => {
    const status = plugin.serverManager?.status() ?? "stopped";
    if (status === "starting") {
      new Notice(t("ScholarBridge: translator is starting — wait for it to become ready."));
      return;
    }
    if (status === "ready") void stopTranslator(plugin, refresh);
    else void startTranslator(plugin, refresh);
  });

  const poll = window.setInterval(refresh, 2_000);
  plugin.registerInterval(poll);

  plugin.addCommand({
    id: "start-local-translator",
    name: t("Start local translator"),
    callback: () => void startTranslator(plugin, refresh),
  });

  plugin.addCommand({
    id: "stop-local-translator",
    name: t("Stop local translator"),
    callback: () => void stopTranslator(plugin, refresh),
  });

    plugin.addCommand({
      id: "translator-health",
      name: t("Check translator connection"),
      callback: () =>
        void (async () => {
          try {
            const ok = await makeClient(plugin).health();
            new Notice(
              ok
                ? t("ScholarBridge: llama-server reachable at {{label}}.", { label: clientLabel(plugin) })
                : t("ScholarBridge: no llama-server at {{label}}.", { label: clientLabel(plugin) }),
            );
          } catch (err) {
            new Notice(
              t("ScholarBridge: health check failed — {{msg}}", { msg: err instanceof Error ? err.message : String(err) }),
            );
          }
        })(),
    });
}

/** Bound for waiting out an already-running server start (manager default). */
const STARTING_WAIT_MS = 120_000;

export function makeClient(plugin: ScholarBridgePlugin): LlamaClient {
  const { host, port, modelPath, requestTimeoutMs } = plugin.settings.llama;
  const client = LlamaClient.fromBaseUrl(host, port, modelPath || "local-model", requestTimeoutMs);
  // Contract with translation/llama: fires at the top of every chat() so each
  // translation request re-arms the owned server's idle timer, and fires once
  // the request settles so a long generation is never shut down mid-flight.
  client.onRequestStart = () => plugin.serverManager?.beginRequest();
  client.onRequestEnd = () => plugin.serverManager?.endRequest();
  return client;
}

export function makeServerManager(plugin: ScholarBridgePlugin): LlamaServerManager {
  const llama = plugin.settings.llama;
  return new LlamaServerManager(
    {
      executablePath: llama.executablePath,
      modelPath: llama.modelPath,
      host: llama.host,
      port: llama.port,
      gpuLayers: llama.gpuLayers,
      contextSize: llama.contextSize,
      idleTimeoutMs: llama.idleShutdownMinutes * 60_000,
    },
    makeClient(plugin),
    createNodeSpawner(),
  );
}

export function clientLabel(plugin: ScholarBridgePlugin): string {
  return `http://${plugin.settings.llama.host}:${plugin.settings.llama.port}`;
}

/**
 * Make a translator usable before a translation request: connect-only health
 * probe, or spawn the configured local server (honouring `confirmSpawn`).
 * Starting on the first translation request is an allowed moment (§10.3);
 * plugin load is not.
 */
/**
 * Shared in-flight ensure flow (R2 P2-6): the check-then-act below spans the
 * confirm modal's await, so two concurrent translation commands would both
 * pass the `!plugin.serverManager` check and each spawn a manager — the
 * second overwriting the first leaks its process. A second caller instead
 * joins the pending promise.
 */
let pendingEnsure: Promise<boolean> | null = null;

export async function ensureTranslatorReady(plugin: ScholarBridgePlugin): Promise<boolean> {
  if (plugin.serverManager?.status() === "ready") return true;
  if (pendingEnsure) return pendingEnsure;
  pendingEnsure = ensureTranslatorReadyOnce(plugin).finally(() => {
    pendingEnsure = null;
  });
  return pendingEnsure;
}

async function ensureTranslatorReadyOnce(plugin: ScholarBridgePlugin): Promise<boolean> {
  if (plugin.serverManager?.status() === "ready") return true;
  const llama = plugin.settings.llama;
  if (llama.executablePath && llama.modelPath) {
    if (!plugin.serverManager) {
      if (llama.confirmSpawn) {
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(plugin.app, {
            title: t("Start local translator?"),
            message: t("ScholarBridge is about to spawn llama-server on {{label}}.", { label: clientLabel(plugin) }),
            confirmText: t("Start"),
            cancelText: t("Not now"),
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }).open();
        });
        if (!confirmed) return false;
      }
      plugin.serverManager = makeServerManager(plugin);
    }
    if (
      plugin.serverManager.status() === "stopped" ||
      plugin.serverManager.status() === "error"
    ) {
      await plugin.serverManager.start();
    }
    if (plugin.serverManager.status() === "starting") {
      // A start is already in flight (e.g. the user clicked Start moments
      // ago): wait it out (bounded) instead of reporting a spurious failure.
      await plugin.serverManager.waitUntilReady(STARTING_WAIT_MS);
    }
    return plugin.serverManager.status() === "ready";
  }
  return makeClient(plugin).health();
}

export async function startTranslator(
  plugin: ScholarBridgePlugin,
  refresh: () => void = () => {},
): Promise<void> {
  try {
    if (!plugin.settings.llama.executablePath) {
      // Connect-only mode: probe the manually started server.
      const ok = await makeClient(plugin).health();
      new Notice(
        ok
          ? t("ScholarBridge: external llama-server is reachable (connect-only mode).")
          : t("ScholarBridge: no running llama-server found and no executable configured."),
      );
      return;
    }
    const ok = await ensureTranslatorReady(plugin);
    new Notice(
      ok
        ? t("ScholarBridge: local translator ready.")
        : t("ScholarBridge: local translator is not running."),
    );
  } catch (err) {
    const detail = plugin.serverManager?.lastErrorMessage();
    new Notice(
      t("ScholarBridge: local translator failed to start — {{detail}}", { detail: detail ?? (err instanceof Error ? err.message : String(err)) }),
    );
  } finally {
    refresh();
  }
}

export async function stopTranslator(
  plugin: ScholarBridgePlugin,
  refresh: () => void = () => {},
): Promise<void> {
  if (plugin.serverManager) {
    await plugin.serverManager.stop();
    new Notice(t("ScholarBridge: local translator stopped."));
  } else {
    new Notice(t("ScholarBridge: no local translator is owned by the plugin."));
  }
  refresh();
}

/**
 * Convenience entry point for the ribbon/status-bar UI: start the translator
 * when the user asked for it at launch (setting), after the workspace layout
 * is ready — never from onload's cheap path (§10.3), and the confirm-spawn
 * modal still applies.
 */
export async function autoStartTranslatorIfConfigured(plugin: ScholarBridgePlugin): Promise<void> {
  if (!plugin.settings.autoStartTranslator) return;
  if (plugin.serverManager?.status() === "ready") return;
  await startTranslator(plugin);
}
