import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const bindingsPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "keybindings.json");
const required = [
  { command: "composer.increaseReasoningEffort", key: "F13" },
  { command: "composer.toggleFastMode", key: "F14" },
  { command: "approval.approve", key: "F15", preservedDefault: "Enter" },
  { command: "approval.decline", key: "F16", preservedDefault: "Escape" },
  { command: "forkThread", key: "F17" },
  { command: "composer.decreaseReasoningEffort", key: "F18" },
  { command: "composer.submit", key: "F19" }
];

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

await mkdir(dirname(bindingsPath), { recursive: true });
const hadFile = await exists(bindingsPath);
let bindings = [];

if (hadFile) {
  const source = await readFile(bindingsPath, "utf8");
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.command !== "string" || !(typeof entry.key === "string" || entry.key === null))) {
    throw new Error(`${bindingsPath} heeft niet het verwachte keybindings-formaat; er is niets gewijzigd.`);
  }
  bindings = parsed;
}

for (const item of required) {
  const commandEntries = bindings.filter((entry) => entry.command === item.command);
  if (commandEntries.some((entry) => entry.key === null)) {
    throw new Error(`${item.command} is expliciet uitgeschakeld (key:null); er is niets gewijzigd.`);
  }

  const keyOwner = bindings.find((entry) => entry.key === item.key && entry.command !== item.command);
  if (keyOwner) {
    throw new Error(`${item.key} is al gekoppeld aan ${keyOwner.command}; er is niets gewijzigd.`);
  }

  if (commandEntries.length === 0 && item.preservedDefault) {
    bindings.push({ command: item.command, key: item.preservedDefault });
  }
  if (!commandEntries.some((entry) => entry.key === item.key)) {
    bindings.push({ command: item.command, key: item.key });
  }
}

if (hadFile) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await copyFile(bindingsPath, `${bindingsPath}.${stamp}.bak`);
}

const temporary = `${bindingsPath}.codex-micro.tmp`;
await writeFile(temporary, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, bindingsPath);

console.log(`Codex Micro-sneltoetsen staan in ${bindingsPath}.`);
console.log("Herstart de Codex-desktopapp één keer om ze te activeren.");
