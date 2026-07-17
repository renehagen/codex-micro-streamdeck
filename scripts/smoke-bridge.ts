import { CodexBridge } from "../src/bridge.js";
import { CodexClient } from "../src/codex-client.js";
import { MacCodexController } from "../src/commands.js";

const client = new CodexClient({ onStderr: (line) => console.error(`[codex] ${line}`) });
const bridge = new CodexBridge(
  client,
  new MacCodexController(),
  { load: async () => ({}), save: async () => undefined },
  { pollIntervalMs: 60_000, onError: () => undefined }
);

try {
  await bridge.start();
  console.log(JSON.stringify(bridge.currentSessions.map(({ slot, threadId, status, selected }) => ({ slot, threadId, status, selected }))));
} finally {
  await bridge.stop();
}
