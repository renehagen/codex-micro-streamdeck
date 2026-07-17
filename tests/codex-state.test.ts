import { describe, expect, it, vi } from "vitest";
import { CodexStateReader } from "../src/codex-state.js";

describe("CodexStateReader", () => {
  it("reads the current effort from the local Codex state database", async () => {
    const runSqlite = vi.fn(async (_executable: string, _args: readonly string[]) => JSON.stringify([{
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh",
      updated_at_ms: 1234
    }]));
    const reader = new CodexStateReader({
      databasePath: "/tmp/state.sqlite",
      sqliteExecutable: "/usr/bin/sqlite3",
      runSqlite
    });

    await expect(reader.readThreadControls("019f6ee1-b6e0-7312-9547-230f6747d083")).resolves.toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      updatedAt: 1234
    });
    expect(runSqlite).toHaveBeenCalledOnce();
    expect(runSqlite.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      "-readonly",
      "-json",
      "/tmp/state.sqlite"
    ]));
    expect(runSqlite.mock.calls[0]?.[1]?.at(-1)).toContain("reasoning_effort");
  });

  it("returns an empty state when the thread is absent", async () => {
    const reader = new CodexStateReader({ runSqlite: async () => "[]" });
    await expect(reader.readThreadControls("019f6ee1-b6e0-7312-9547-230f6747d083")).resolves.toEqual({});
  });

  it("rejects an invalid id before invoking sqlite", async () => {
    const runSqlite = vi.fn(async (_executable: string, _args: readonly string[]) => "[]");
    const reader = new CodexStateReader({ runSqlite });
    await expect(reader.readThreadControls("'; DROP TABLE threads; --")).rejects.toThrow("Ongeldig");
    expect(runSqlite).not.toHaveBeenCalled();
  });
});
