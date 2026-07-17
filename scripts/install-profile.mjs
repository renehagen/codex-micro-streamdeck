import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createProfileActions, DEVICE_MODEL, PROFILE_NAME } from "./profile-layout.mjs";

const actions = createProfileActions();

const profilesRoot = path.join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "ProfilesV3");
const candidates = (await readdir(profilesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.endsWith(".sdProfile"));

let target;
for (const candidate of candidates) {
  const root = path.join(profilesRoot, candidate.name);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.Device?.Model !== DEVICE_MODEL) continue;
  if (manifest.Name === PROFILE_NAME) {
    target = { root, manifestPath, manifest };
    break;
  }
  if (!target && manifest.Name === "Profile 1") target = { root, manifestPath, manifest };
}

if (!target) {
  throw new Error("Geen leeg 'Profile 1'-profiel voor de aangesloten Stream Deck MK.2 gevonden.");
}

const currentPage = target.manifest.Pages?.Current;
if (typeof currentPage !== "string") throw new Error("Het doelprofiel heeft geen huidige pagina.");
const pageManifestPath = path.join(target.root, "Profiles", currentPage.toUpperCase(), "manifest.json");
const existingPage = JSON.parse(await readFile(pageManifestPath, "utf8"));
const existingActions = existingPage.Controllers?.[0]?.Actions;
if (target.manifest.Name !== PROFILE_NAME && existingActions && Object.keys(existingActions).length > 0) {
  throw new Error("'Profile 1' is niet leeg; de bestaande knoppen zijn niet overschreven.");
}

const backupRoot = path.join(tmpdir(), `codex-micro-profile-backup-${Date.now()}`);
await mkdir(backupRoot, { recursive: true });
await copyFile(target.manifestPath, path.join(backupRoot, "profile-manifest.json"));
await copyFile(pageManifestPath, path.join(backupRoot, "page-manifest.json"));

target.manifest.Name = PROFILE_NAME;
const pageManifest = {
  Controllers: [{ Actions: actions, Type: "Keypad" }],
  Icon: "",
  Name: ""
};

const atomicJsonWrite = async (destination, value) => {
  const temporary = `${destination}.codex-micro-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
};

await atomicJsonWrite(target.manifestPath, target.manifest);
await atomicJsonWrite(pageManifestPath, pageManifest);

console.log(`Profiel geïnstalleerd: ${target.root}`);
console.log(`Back-up: ${backupRoot}`);
console.log(`Knoppen: ${Object.keys(actions).length}`);
