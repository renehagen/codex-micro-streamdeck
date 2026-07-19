import { execFile } from "node:child_process";
import streamDeck from "@elgato/streamdeck";
import {
  AcceptAction,
  BranchAction,
  EffortDownAction,
  EffortUpAction,
  FastModeAction,
  PushToTalkAction,
  RejectAction,
  SessionAction,
  SubmitAction,
  XAction,
  X_APP_BUNDLE_ID
} from "./actions.js";
import { CodexBridge, type BridgeSettings, type BridgeSettingsStore } from "./bridge.js";
import { CodexClient } from "./codex-client.js";
import { CodexIpcClient } from "./codex-ipc.js";
import { CodexStateReader } from "./codex-state.js";
import { MacCodexController } from "./commands.js";

const logError = (message: string, error?: unknown): void => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  streamDeck.logger.error(`${message}${detail ? ` — ${detail}` : ""}`);
};

const store: BridgeSettingsStore = {
  async load(): Promise<BridgeSettings> {
    return streamDeck.settings.getGlobalSettings<BridgeSettings>();
  },
  async save(settings): Promise<void> {
    await streamDeck.settings.setGlobalSettings(settings);
  }
};

const client = new CodexClient({
  onStderr: (line) => streamDeck.logger.warn(`[codex] ${line}`),
  onNotification: (notification) => streamDeck.logger.debug(`[codex] ${notification.method}`)
});
const bridge = new CodexBridge(client, new MacCodexController(), store, {
  settingsUpdater: new CodexIpcClient(),
  stateReader: new CodexStateReader(),
  onError: (error) => logError("Bridgefout", error)
});

const sessionAction = new SessionAction(bridge, logError);
const pushToTalkAction = new PushToTalkAction(bridge, logError);
const launchXApp = (): Promise<void> => new Promise((resolve, reject) => {
  execFile("/usr/bin/open", ["-b", X_APP_BUNDLE_ID], (error) => {
    if (error) reject(error);
    else resolve();
  });
});
streamDeck.actions.registerAction(sessionAction);
streamDeck.actions.registerAction(new EffortUpAction(bridge, logError));
streamDeck.actions.registerAction(new FastModeAction(bridge, logError));
streamDeck.actions.registerAction(new AcceptAction(bridge, logError));
streamDeck.actions.registerAction(new RejectAction(bridge, logError));
streamDeck.actions.registerAction(new BranchAction(bridge, logError));
streamDeck.actions.registerAction(new EffortDownAction(bridge, logError));
streamDeck.actions.registerAction(new XAction(launchXApp, logError));
streamDeck.actions.registerAction(pushToTalkAction);
streamDeck.actions.registerAction(new SubmitAction(bridge, logError));

streamDeck.system.onSystemDidWakeUp(() => void bridge.wake().catch((error: unknown) => logError("Herverbinden na sleep faalde", error)));

let shutdownStarted = false;
const shutdown = (): void => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  sessionAction.dispose();
  void pushToTalkAction.releaseAll()
    .catch((error: unknown) => logError("Push-to-talk vrijgeven bij afsluiten faalde", error))
    .then(() => bridge.stop())
    .catch((error: unknown) => logError("Bridge stoppen bij afsluiten faalde", error))
    .finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await streamDeck.connect();
await bridge.start().catch((error: unknown) => logError("Codex bridge kon bij opstarten niet verbinden", error));
