import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_BINDINGS,
  MacCodexController,
  commandAppleScript,
  dictationEventScript
} from "../src/commands.js";

describe("Codex command mapping", () => {
  it("uses a unique keyboard action for every hardware command", () => {
    const keys = Object.values(COMMAND_BINDINGS).map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["F13", "F14", "F15", "F16", "F17", "F18", "Enter"]);
  });

  it("opens only valid Codex thread deep links", async () => {
    const run = vi.fn(async (_executable: string, _args: readonly string[]) => undefined);
    const controller = new MacCodexController(run);
    await controller.openThread("019f6ee1-b6e0-7312-9547-230f6747d083");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/usr/bin/open", ["-b", "com.openai.codex", "codex://threads/019f6ee1-b6e0-7312-9547-230f6747d083"]);
    expect(run.mock.calls.filter(([executable]) => executable === "/usr/bin/osascript")).toHaveLength(0);
    await expect(controller.openThread("bad/value")).rejects.toThrow("Ongeldig");
  });

  it.each([
    ["effort-up", 105],
    ["fast-mode", 107],
    ["accept", 113],
    ["reject", 106],
    ["branch", 64],
    ["effort-down", 79],
    ["submit", 36]
  ] as const)("sends one key without manipulating the composer for %s", (command, keyCode) => {
    const script = commandAppleScript(command);
    expect(script).not.toContain("AXShowMenu");
    expect(script).not.toContain("click at");
    expect(script).not.toContain("AXFocusedUIElement");
    expect(script.match(new RegExp(`key code ${keyCode}(?!\\d)`, "g"))).toHaveLength(1);
    expect(script.trim().endsWith(`key code ${keyCode}`)).toBe(true);
  });

  it("holds and releases the documented dictation shortcut", async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const run = vi.fn(async (executable: string, args: readonly string[]) => {
      calls.push([executable, args]);
    });
    const controller = new MacCodexController(run);
    await controller.startDictation();
    await controller.stopDictation();

    const scripts = calls.map(([, args]) => args.join(" "));
    expect(scripts.filter((script) => script.includes("CGEventPost(0, keyEvent)"))).toHaveLength(2);
    expect(scripts).toContainEqual(expect.stringContaining("CreateKeyboardEvent(null, 2, true)"));
    expect(scripts).toContainEqual(expect.stringContaining("CreateKeyboardEvent(null, 2, false)"));
    expect(scripts.join(" ")).not.toContain("CGPreflightPostEventAccess");
    expect(scripts.join(" ")).not.toContain("CGRequestPostEventAccess");
    expect(scripts.join(" ")).not.toContain("keystroke");
    const keyUpCall = calls.at(-1);
    expect(keyUpCall?.[0]).toBe("/usr/bin/osascript");
    expect(keyUpCall?.[1].join(" ")).toContain("CreateKeyboardEvent(null, 2, false)");
    expect(keyUpCall?.[1].join(" ")).toContain("runningApplicationsWithBundleIdentifier(\"com.openai.codex\")");
    expect(keyUpCall?.[1].join(" ")).toContain("CGEventPost(0, keyEvent)");
    expect(keyUpCall?.[1].join(" ")).not.toContain("CGPreflightPostEventAccess");
    expect(dictationEventScript(true)).not.toContain("CGEventCreateMouseEvent");
    expect(dictationEventScript(false)).not.toContain("CGEventCreateMouseEvent");
    expect(scripts.join(" ")).not.toContain("CGEventPostToPid");
    expect(calls.filter(([executable]) => executable === "/usr/bin/open")).toHaveLength(0);
    expect(calls.filter(([, args]) => args.join(" ").includes("System Events"))).toHaveLength(0);
    expect(dictationEventScript(true)).toContain("app.activateWithOptions");
    expect(dictationEventScript(true)).toContain("Date.now() + 1000");
    expect(dictationEventScript(false)).not.toContain("app.activateWithOptions");
  });
});
