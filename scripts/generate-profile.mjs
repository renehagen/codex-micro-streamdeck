import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createProfileActions, DEVICE_MODEL, PROFILE_NAME } from "./profile-layout.mjs";

const execFile = promisify(execFileCallback);
const profileId = "7A0E1164-9D84-47DE-BD93-43E037D18B44";
const currentPage = "A95F9CF7-1B5B-43F6-A9D6-A4E890AD50FA";
const defaultPage = "CB1B503B-4FB0-4C38-A810-5B9E33F49D1D";
const outputDirectory = path.resolve("com.renehagen.codex-micro.sdPlugin", "profiles");
const output = path.join(outputDirectory, "Codex Micro - Stream Deck MK.2.streamDeckProfile");
const temporary = await mkdtemp(path.join(tmpdir(), "codex-micro-profile-"));
const profileRoot = path.join(temporary, `${profileId}.sdProfile`);

const writeJson = async (destination, value) => {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

try {
  await writeJson(path.join(profileRoot, "manifest.json"), {
    Device: { Model: DEVICE_MODEL, UUID: "" },
    Name: PROFILE_NAME,
    Pages: {
      Current: currentPage.toLowerCase(),
      Default: defaultPage.toLowerCase(),
      Pages: [currentPage.toLowerCase()]
    },
    Version: "3.0"
  });

  const page = (actions) => ({
    Controllers: [{ Actions: actions, Type: "Keypad" }],
    Icon: "",
    Name: ""
  });
  await writeJson(path.join(profileRoot, "Profiles", currentPage, "manifest.json"), page(createProfileActions()));
  await writeJson(path.join(profileRoot, "Profiles", defaultPage, "manifest.json"), page(null));
  await mkdir(path.join(profileRoot, "Profiles", currentPage, "Images"), { recursive: true });
  await mkdir(path.join(profileRoot, "Profiles", defaultPage, "Images"), { recursive: true });

  await mkdir(outputDirectory, { recursive: true });
  await rm(output, { force: true });
  await execFile("/usr/bin/zip", ["-q", "-r", output, path.basename(profileRoot)], { cwd: temporary });
  console.log(`Profielpakket gegenereerd: ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
