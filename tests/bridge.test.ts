import { describe, expect, it, vi } from "vitest";
import {
  CodexBridge,
  type BridgeSettings,
  type BridgeSettingsStore,
  type DesktopController,
  type RecentThreadSource,
  type ThreadSettingsUpdater
} from "../src/bridge.js";
import type { CodexThreadSummary } from "../src/codex-client.js";
import type { ThreadStateReader } from "../src/codex-state.js";

const thread = (id: string, name: string): CodexThreadSummary => ({
  id,
  name,
  preview: name,
  path: null,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: "idle" }
});

const threads = (listRecentThreads: RecentThreadSource["listRecentThreads"]): RecentThreadSource => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  listRecentThreads
});

const controller = (
  openThread: DesktopController["openThread"] = vi.fn(async () => undefined),
  invoke: DesktopController["invoke"] = vi.fn(async () => undefined)
): DesktopController => ({
  openThread,
  invoke,
  startDictation: vi.fn(async () => undefined),
  stopDictation: vi.fn(async () => undefined)
});

const store = (initial: BridgeSettings = {}): BridgeSettingsStore & { save: ReturnType<typeof vi.fn> } => ({
  load: vi.fn(async () => initial),
  save: vi.fn(async () => undefined)
});

const updater = (
  updateThreadSettings: ThreadSettingsUpdater["updateThreadSettings"] = vi.fn(async () => undefined)
): ThreadSettingsUpdater => ({ updateThreadSettings });

describe("CodexBridge lifecycle", () => {
  it("can retry startup after the first refresh fails", async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("tijdelijke thread/list-fout"))
      .mockResolvedValue([]);
    const source = threads(list);
    const bridge = new CodexBridge(source, controller(), store(), { pollIntervalMs: 60_000 });

    await expect(bridge.start()).rejects.toThrow("tijdelijke thread/list-fout");
    await expect(bridge.start()).resolves.toBeUndefined();

    expect(source.start).toHaveBeenCalledTimes(2);
    expect(source.stop).toHaveBeenCalledTimes(1);
    await bridge.stop();
  });

  it("does not select or mark a session read when navigation fails", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const second = thread("019f6ead-4756-7e70-9d38-cd791811a234", "Tweede");
    const persistence = store({ selectedThreadId: first.id, seenAt: { [first.id]: 10, [second.id]: 10 }, initializedAt: 10 });
    const openThread = vi.fn(async () => { throw new Error("open faalde"); });
    const bridge = new CodexBridge(threads(vi.fn(async () => [first, second])), controller(openThread), persistence, { pollIntervalMs: 60_000, now: () => 20 });
    await bridge.start();
    persistence.save.mockClear();

    await expect(bridge.selectSlot(1)).rejects.toThrow("open faalde");

    expect(bridge.currentSessions[0]?.selected).toBe(true);
    expect(bridge.currentSessions[1]?.selected).toBe(false);
    expect(persistence.save).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("mirrors the Codex app mouse selection in the session row", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const second = thread("019f6ead-4756-7e70-9d38-cd791811a234", "Tweede");
    const persistence = store({
      selectedThreadId: first.id,
      seenAt: { [first.id]: 10, [second.id]: 10 },
      initializedAt: 10
    });
    const readActiveThread = vi.fn(async () => second.id);
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first, second])),
      controller(),
      persistence,
      {
        pollIntervalMs: 60_000,
        now: () => 20,
        settingsUpdater: {
          updateThreadSettings: vi.fn(async () => undefined),
          readActiveThread
        }
      }
    );

    await bridge.start();

    expect(readActiveThread).toHaveBeenCalledWith([first.id, second.id]);
    expect(bridge.currentSessions.map(({ threadId, selected }) => [threadId, selected]))
      .toEqual([[first.id, false], [second.id, true]]);
    expect(persistence.save).toHaveBeenCalledWith(expect.objectContaining({
      selectedThreadId: second.id,
      seenAt: expect.objectContaining({ [second.id]: 20 })
    }));
    await bridge.stop();
  });

  it("waits for an in-flight session navigation before sending a command", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const second = thread("019f6ead-4756-7e70-9d38-cd791811a234", "Tweede");
    let finishNavigation!: () => void;
    const openThread = vi.fn(() => new Promise<void>((resolve) => { finishNavigation = resolve; }));
    const desktop = controller(openThread);
    const bridge = new CodexBridge(threads(vi.fn(async () => [first, second])), desktop, store(), { pollIntervalMs: 60_000 });
    await bridge.start();

    const selecting = bridge.selectSlot(1);
    const performing = bridge.perform("accept");
    await Promise.resolve();
    expect(desktop.invoke).not.toHaveBeenCalled();

    finishNavigation();
    await Promise.all([selecting, performing]);
    expect(desktop.invoke).toHaveBeenCalledWith("accept");
    await bridge.stop();
  });

  it("serializes rapid session selections before a following command", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const second = thread("019f6ead-4756-7e70-9d38-cd791811a234", "Tweede");
    const releases: Array<() => void> = [];
    const openThread = vi.fn((_threadId: string) => new Promise<void>((resolve) => releases.push(resolve)));
    const invoke = vi.fn(async () => undefined);
    const bridge = new CodexBridge(threads(vi.fn(async () => [first, second])), controller(openThread, invoke), store(), { pollIntervalMs: 60_000 });
    await bridge.start();

    const selectSecond = bridge.selectSlot(1);
    const selectFirst = bridge.selectSlot(0);
    const performing = bridge.perform("accept");
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalled();

    releases[0]?.();
    await vi.waitFor(() => expect(openThread).toHaveBeenCalledTimes(2));
    expect(openThread.mock.calls.map(([threadId]) => threadId)).toEqual([second.id, first.id]);
    expect(invoke).not.toHaveBeenCalled();

    releases[1]?.();
    await Promise.all([selectSecond, selectFirst, performing]);
    expect(invoke).toHaveBeenCalledWith("accept");
    expect(bridge.currentSessions[0]?.selected).toBe(true);
    expect(bridge.currentSessions[1]?.selected).toBe(false);
    await bridge.stop();
  });

  it("blocks a command queued behind a failed session navigation", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const invoke = vi.fn(async () => undefined);
    const openThread = vi.fn(async () => { throw new Error("deeplink faalde"); });
    const bridge = new CodexBridge(threads(vi.fn(async () => [first])), controller(openThread, invoke), store(), { pollIntervalMs: 60_000 });
    await bridge.start();

    const selection = bridge.selectSlot(0);
    const performing = bridge.perform("accept");
    await expect(selection).rejects.toThrow("deeplink faalde");
    await expect(performing).rejects.toThrow("deeplink faalde");
    expect(invoke).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("updates effort and Fast through live thread settings without invoking a keyboard shortcut", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const invoke = vi.fn(async () => undefined);
    const updateThreadSettings = vi.fn(async () => undefined);
    const persistence = store({
      selectedThreadId: first.id,
      seenAt: { [first.id]: 10 },
      initializedAt: 10,
      threadControls: {
        [first.id]: {
          model: "test-model",
          reasoningEffort: "medium",
          serviceTier: null,
          updatedAt: 10
        }
      }
    });
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first])),
      controller(undefined, invoke),
      persistence,
      {
        pollIntervalMs: 60_000,
        now: () => 20,
        settingsUpdater: updater(updateThreadSettings),
        stateReader: {
          // Simulates SQLite lagging one write behind during rapid presses.
          readThreadControls: async () => ({
            model: "test-model",
            reasoningEffort: "medium",
            updatedAt: 15
          })
        },
        loadModelCatalog: async () => [{
          slug: "test-model",
          defaultReasoningLevel: "medium",
          effortOrder: ["low", "medium", "high", "xhigh"],
          serviceTiers: ["priority"]
        }]
      }
    );
    await bridge.start();
    persistence.save.mockClear();

    await bridge.perform("effort-up");
    await bridge.perform("effort-up");
    await bridge.perform("fast-mode");
    await bridge.perform("fast-mode");

    expect(updateThreadSettings.mock.calls).toEqual([
      [first.id, { effort: "high" }],
      [first.id, { effort: "xhigh" }],
      [first.id, { serviceTier: "priority" }],
      [first.id, { serviceTier: null }]
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(persistence.save).toHaveBeenCalledTimes(4);
    await bridge.stop();
  });

  it("rechecks the app selection immediately before changing effort", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const second = thread("019f6ead-4756-7e70-9d38-cd791811a234", "Tweede");
    const updateThreadSettings = vi.fn(async () => undefined);
    const readActiveThread = vi.fn()
      .mockResolvedValueOnce(first.id)
      .mockResolvedValueOnce(second.id);
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first, second])),
      controller(),
      store({
        selectedThreadId: first.id,
        seenAt: { [first.id]: 10, [second.id]: 10 },
        initializedAt: 10,
        threadControls: {
          [second.id]: {
            model: "test-model",
            reasoningEffort: "medium",
            serviceTier: null,
            updatedAt: 10
          }
        }
      }),
      {
        pollIntervalMs: 60_000,
        now: () => 20,
        settingsUpdater: { updateThreadSettings, readActiveThread },
        stateReader: { readThreadControls: async () => ({ updatedAt: 10 }) },
        loadModelCatalog: async () => [{
          slug: "test-model",
          defaultReasoningLevel: "medium",
          effortOrder: ["low", "medium", "high"],
          serviceTiers: ["priority"]
        }]
      }
    );
    await bridge.start();

    await bridge.perform("effort-up");

    expect(updateThreadSettings).toHaveBeenCalledWith(second.id, { effort: "high" });
    expect(bridge.currentSessions[1]?.selected).toBe(true);
    await bridge.stop();
  });

  it.each(["effort-up", "effort-down", "fast-mode"] as const)(
    "uses the native %s composer command for a new session without a thread id",
    async (command) => {
      const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
      const invoke = vi.fn(async () => undefined);
      const updateThreadSettings = vi.fn(async () => undefined);
      const readActiveThread = vi.fn(async () => null);
      const bridge = new CodexBridge(
        threads(vi.fn(async () => [first])),
        controller(undefined, invoke),
        store({ selectedThreadId: first.id }),
        {
          pollIntervalMs: 60_000,
          settingsUpdater: { updateThreadSettings, readActiveThread }
        }
      );
      await bridge.start();

      await bridge.perform(command);

      expect(invoke).toHaveBeenCalledWith(command);
      expect(updateThreadSettings).not.toHaveBeenCalled();
      await bridge.stop();
    }
  );

  it("opens the selected task and retries when ChatGPT has no renderer owner yet", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const openThread = vi.fn(async () => undefined);
    const invoke = vi.fn(async () => undefined);
    const noOwner = Object.assign(new Error("Geen owner"), { code: "no-client-found" });
    const updateThreadSettings = vi.fn()
      .mockRejectedValueOnce(noOwner)
      .mockResolvedValueOnce(undefined);
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first])),
      controller(openThread, invoke),
      store(),
      {
        pollIntervalMs: 60_000,
        settingsUpdater: updater(updateThreadSettings)
      }
    );
    await bridge.start();

    await bridge.perform("fast-mode");

    expect(openThread).toHaveBeenCalledWith(first.id);
    expect(updateThreadSettings).toHaveBeenCalledTimes(2);
    expect(updateThreadSettings).toHaveBeenLastCalledWith(first.id, { serviceTier: "priority" });
    expect(invoke).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("uses the fast local Codex state over stale persisted widget state", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const updateThreadSettings = vi.fn(async () => undefined);
    const stateReader: ThreadStateReader = {
      readThreadControls: vi.fn(async () => ({
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        updatedAt: 20
      }))
    };
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first])),
      controller(),
      store({
        selectedThreadId: first.id,
        seenAt: { [first.id]: 10 },
        initializedAt: 10,
        threadControls: {
          [first.id]: {
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            serviceTier: null,
            updatedAt: 10
          }
        }
      }),
      {
        pollIntervalMs: 60_000,
        settingsUpdater: { updateThreadSettings },
        stateReader,
        loadModelCatalog: async () => [{
          slug: "gpt-5.6-sol",
          defaultReasoningLevel: "low",
          effortOrder: ["low", "medium", "high", "xhigh", "ultra"],
          serviceTiers: ["priority"]
        }]
      }
    );
    await bridge.start();

    await bridge.perform("effort-down");

    expect(updateThreadSettings.mock.calls).toEqual([
      [first.id, { effort: "xhigh" }]
    ]);
    await bridge.stop();
  });

  it("does not wait for the live ChatGPT snapshot before changing Fast", async () => {
    const first = thread("019f6ee1-b6e0-7312-9547-230f6747d083", "Eerste");
    const updateThreadSettings = vi.fn(async () => undefined);
    let finishSnapshot!: (state: Record<string, unknown>) => void;
    const readThreadState = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      finishSnapshot = resolve;
    }));
    const bridge = new CodexBridge(
      threads(vi.fn(async () => [first])),
      controller(),
      store({
        selectedThreadId: first.id,
        seenAt: { [first.id]: 10 },
        initializedAt: 10,
        threadControls: {
          [first.id]: {
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            serviceTier: null,
            updatedAt: 10
          }
        }
      }),
      {
        pollIntervalMs: 60_000,
        settingsUpdater: { updateThreadSettings, readThreadState },
        stateReader: { readThreadControls: async () => ({ updatedAt: 10 }) },
        loadModelCatalog: async () => [{
          slug: "gpt-5.6-sol",
          defaultReasoningLevel: "low",
          effortOrder: ["low", "medium", "high", "xhigh", "ultra"],
          serviceTiers: ["priority"]
        }]
      }
    );
    await bridge.start();
    await vi.waitFor(() => expect(readThreadState).toHaveBeenCalledOnce());

    await expect(bridge.perform("fast-mode")).resolves.toBeUndefined();
    expect(updateThreadSettings).toHaveBeenCalledWith(first.id, { serviceTier: "priority" });

    finishSnapshot({ latestThreadSettings: { serviceTier: "priority" } });
    await bridge.stop();
  });
});
