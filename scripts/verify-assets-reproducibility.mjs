import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const imageDirectory = "com.renehagen.codex-micro.sdPlugin/images";

const generateAndHash = async (timezone) => {
  await execFile(process.execPath, ["scripts/generate-assets.mjs"], {
    env: { ...process.env, TZ: timezone }
  });
  const names = (await readdir(imageDirectory))
    .filter((name) => name.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const digest = createHash("sha256");
  for (const name of names) {
    const data = await readFile(path.join(imageDirectory, name));
    digest.update(`${name}\0${data.length}\0`);
    digest.update(data);
  }
  return { count: names.length, hash: digest.digest("hex") };
};

const first = await generateAndHash("UTC");
const second = await generateAndHash("Pacific/Honolulu");
if (first.count !== second.count || first.hash !== second.hash) {
  throw new Error(
    `PNG generation is not byte-reproducible: ${first.count}/${first.hash} != ${second.count}/${second.hash}`
  );
}
console.log(`Byte-reproducible PNG set (${first.count} files) SHA-256: ${first.hash}`);
