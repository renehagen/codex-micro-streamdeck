import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const profile = "com.renehagen.codex-micro.sdPlugin/profiles/Codex Micro - Stream Deck MK.2.streamDeckProfile";

const generateAndHash = async (timezone) => {
  await execFile(process.execPath, ["scripts/generate-profile.mjs"], {
    env: { ...process.env, TZ: timezone }
  });
  return createHash("sha256").update(await readFile(profile)).digest("hex");
};

const timezones = ["UTC", "Europe/Amsterdam", "Pacific/Honolulu"];
const hashes = [];
for (const timezone of timezones) {
  hashes.push(await generateAndHash(timezone));
}
if (new Set(hashes).size !== 1) {
  throw new Error(`Profile generation differs by timezone: ${hashes.join(" != ")}`);
}
console.log(`Timezone-independent profile SHA-256: ${hashes[0]}`);
