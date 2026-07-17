import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type CodexCommand =
  | "effort-up"
  | "fast-mode"
  | "accept"
  | "reject"
  | "branch"
  | "effort-down"
  | "submit";

export const COMMAND_BINDINGS: Record<CodexCommand, { command: string; key: string; keyCode: number }> = {
  "effort-up": { command: "composer.increaseReasoningEffort", key: "F13", keyCode: 105 },
  "fast-mode": { command: "composer.toggleFastMode", key: "F14", keyCode: 107 },
  accept: { command: "approval.approve", key: "F15", keyCode: 113 },
  reject: { command: "approval.decline", key: "F16", keyCode: 106 },
  branch: { command: "forkThread", key: "F17", keyCode: 64 },
  "effort-down": { command: "composer.decreaseReasoningEffort", key: "F18", keyCode: 79 },
  submit: { command: "composer.submit", key: "F19", keyCode: 80 }
};

type SpawnCommand = (executable: string, args: readonly string[]) => Promise<void>;
type Pause = (milliseconds: number) => Promise<void>;

const CODEX_BUNDLE_ID = "com.openai.codex";
const DICTATION_KEY_CODE = 2;
const DICTATION_FLAGS = 393_216; // control + shift
const NAVIGATION_SETTLE_MS = 1_000;

const defaultPause: Pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const defaultSpawn: SpawnCommand = (executable, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], { stdio: "ignore" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${executable} stopte met code ${code ?? "onbekend"}`)));
});

function keybindingsPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "keybindings.json");
}

export class MacCodexController {
  constructor(
    private readonly run: SpawnCommand = defaultSpawn,
    private readonly pause: Pause = defaultPause
  ) {}

  async openThread(threadId: string): Promise<void> {
    if (!/^[0-9a-f-]{20,}$/i.test(threadId)) throw new Error("Ongeldig Codex thread-id");
    await this.activateCodex();
    await this.run("/usr/bin/osascript", ["-e", waitForCodexScript()]);
    await this.run("/usr/bin/open", ["-b", CODEX_BUNDLE_ID, `codex://threads/${threadId}`]);
    await this.pause(NAVIGATION_SETTLE_MS);
    await this.run("/usr/bin/osascript", ["-e", waitForCodexScript()]);
  }

  async invoke(command: CodexCommand): Promise<void> {
    await this.assertBinding(command);
    await this.activateCodex();
    try {
      await this.run("/usr/bin/osascript", [
        "-e", commandAppleScript(command)
      ]);
    } catch (error) {
      throw new Error(
        "Codex-commando kon niet worden verstuurd; controleer Toegankelijkheid en Invoerbewaking voor Stream Deck.",
        { cause: error }
      );
    }
  }

  startDictation(): Promise<void> {
    return this.sendDictationEvent(true);
  }

  stopDictation(): Promise<void> {
    return this.sendDictationEvent(false);
  }

  private async sendDictationEvent(isKeyDown: boolean): Promise<void> {
    if (isKeyDown) {
      await this.activateCodex();
      await this.run("/usr/bin/osascript", ["-e", waitForCodexScript()]);
    }
    try {
      await this.run("/usr/bin/osascript", [
        "-l", "JavaScript",
        "-e", dictationEventScript(isKeyDown)
      ]);
    } catch (error) {
      if (isKeyDown) {
        throw new Error("Push-to-talk vereist macOS-toegankelijkheidstoegang voor Stream Deck", { cause: error });
      }
      throw error;
    }
  }

  private activateCodex(): Promise<void> {
    return this.run("/usr/bin/open", ["-b", CODEX_BUNDLE_ID]);
  }

  private async assertBinding(command: CodexCommand): Promise<void> {
    const path = keybindingsPath();
    await access(path, constants.R_OK).catch(() => {
      throw new Error("Codex Micro-sneltoetsen ontbreken; voer eerst `npm run setup` uit en herstart Codex.");
    });
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const expected = COMMAND_BINDINGS[command];
    if (!Array.isArray(parsed) || !parsed.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const binding = entry as { command?: unknown; key?: unknown };
      return binding.command === expected.command && binding.key === expected.key;
    })) {
      throw new Error(`Sneltoets ${expected.key} voor ${expected.command} ontbreekt; voer \`npm run setup\` uit.`);
    }
  }
}

function waitForCodexScript(): string {
  return `tell application "System Events"
  set codexReady to false
  repeat 80 times
    try
      set frontmostProcess to first application process whose frontmost is true
      set frontmostBundle to bundle identifier of frontmostProcess
      if frontmostBundle is "${CODEX_BUNDLE_ID}" and (count of windows of frontmostProcess) > 0 then
        set codexReady to true
        exit repeat
      end if
    end try
    delay 0.05
  end repeat
  if codexReady is false then error "Codex kon niet volledig worden geactiveerd"
end tell`;
}

export function commandAppleScript(command: CodexCommand): string {
  const { keyCode } = COMMAND_BINDINGS[command];
  return `${waitForCodexScript()}
tell application "System Events" to key code ${keyCode}`;
}

export function dictationEventScript(isKeyDown: boolean): string {
  const permissionCheck = isKeyDown
    ? `ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]); ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []]); if (!Boolean($.CGPreflightPostEventAccess()) && !Boolean($.CGRequestPostEventAccess())) throw new Error("Stream Deck heeft toegankelijkheidstoegang nodig voor push-to-talk"); `
    : "";
  return `ObjC.import("AppKit"); ObjC.import("CoreGraphics"); ${permissionCheck}const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${CODEX_BUNDLE_ID}"); if (Number(apps.count) < 1) throw new Error("Codex-proces niet gevonden"); const pid = Number(apps.objectAtIndex(0).processIdentifier); const keyEvent = $.CGEventCreateKeyboardEvent(null, ${DICTATION_KEY_CODE}, ${isKeyDown}); $.CGEventSetFlags(keyEvent, ${DICTATION_FLAGS}); $.CGEventPostToPid(pid, keyEvent);`;
}
