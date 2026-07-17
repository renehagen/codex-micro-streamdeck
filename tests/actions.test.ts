import type { KeyDownEvent, KeyUpEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { describe, expect, it, vi } from "vitest";
import { PushToTalkAction, SessionAction } from "../src/actions.js";
import type { CodexBridge, SessionView } from "../src/bridge.js";

describe("SessionAction", () => {
  it("logs asynchronous key-image update failures from a bridge refresh", async () => {
    let listener: ((sessions: readonly SessionView[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      subscribe: vi.fn((next: (sessions: readonly SessionView[]) => void) => {
        listener = next;
        return unsubscribe;
      })
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new SessionAction(bridge, logError);
    Reflect.set(action, "updateAll", vi.fn(async () => { throw new Error("device losgekoppeld"); }));

    listener?.([]);
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith("Sessieweergave kon niet worden bijgewerkt", expect.any(Error)));
    action.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("PushToTalkAction", () => {
  it("holds dictation from key-down until key-up", async () => {
    const bridge = {
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn(async () => undefined)
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new PushToTalkAction(bridge, logError);
    const key = {
      id: "mic-1",
      setState: vi.fn(async () => undefined),
      showAlert: vi.fn(async () => undefined)
    };

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    expect(bridge.startDictation).toHaveBeenCalledTimes(1);
    expect(bridge.stopDictation).not.toHaveBeenCalled();
    expect(key.setState).toHaveBeenCalledWith(1);

    await action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    expect(bridge.stopDictation).toHaveBeenCalledTimes(1);
    expect(key.setState).toHaveBeenLastCalledWith(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("returns to idle and alerts when dictation cannot start", async () => {
    const bridge = {
      startDictation: vi.fn(async () => { throw new Error("microfoon geweigerd"); }),
      stopDictation: vi.fn(async () => undefined)
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new PushToTalkAction(bridge, logError);
    const key = {
      id: "mic-2",
      setState: vi.fn(async () => undefined),
      showAlert: vi.fn(async () => undefined)
    };

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);

    expect(key.setState).not.toHaveBeenCalledWith(1);
    expect(key.setState).toHaveBeenLastCalledWith(0);
    expect(key.showAlert).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("Push-to-talk kon niet starten", expect.any(Error));
  });

  it("releases dictation when activating the Stream Deck state fails", async () => {
    const bridge = {
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn(async () => undefined)
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new PushToTalkAction(bridge, logError);
    const key = {
      id: "mic-state-failure",
      setState: vi.fn()
        .mockRejectedValueOnce(new Error("device verdween"))
        .mockResolvedValue(undefined),
      showAlert: vi.fn(async () => undefined)
    };

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    expect(bridge.stopDictation).toHaveBeenCalledTimes(1);
    expect(key.setState).toHaveBeenLastCalledWith(0);
    expect(key.showAlert).toHaveBeenCalledTimes(1);

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    expect(bridge.startDictation).toHaveBeenCalledTimes(2);
    await action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    expect(bridge.stopDictation).toHaveBeenCalledTimes(2);
  });

  it("sends one release for concurrent key-up and disappearance", async () => {
    let resolveStart!: () => void;
    const bridge = {
      startDictation: vi.fn(() => new Promise<void>((resolve) => { resolveStart = resolve; })),
      stopDictation: vi.fn(async () => undefined)
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new PushToTalkAction(bridge, logError);
    const key = {
      id: "mic-race",
      setState: vi.fn(async () => undefined),
      showAlert: vi.fn(async () => undefined)
    };

    const keyDown = action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledTimes(1));
    const keyUp = action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    const disappear = action.onWillDisappear({ action: { id: key.id } } as unknown as WillDisappearEvent);
    resolveStart();
    await Promise.all([keyDown, keyUp, disappear]);

    expect(bridge.stopDictation).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("waits for an in-flight release during shutdown and ignores new presses", async () => {
    let resolveStop!: () => void;
    const bridge = {
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }))
    } as unknown as CodexBridge;
    const action = new PushToTalkAction(bridge, vi.fn());
    const key = {
      id: "mic-shutdown",
      setState: vi.fn(async () => undefined),
      showAlert: vi.fn(async () => undefined)
    };

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    const keyUp = action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    await vi.waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledTimes(1));
    const shutdown = action.releaseAll();
    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    expect(bridge.startDictation).toHaveBeenCalledTimes(1);

    resolveStop();
    await Promise.all([keyUp, shutdown]);
    expect(bridge.stopDictation).toHaveBeenCalledTimes(1);
  });

  it("clears its active state even when releasing dictation fails", async () => {
    const bridge = {
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn()
        .mockRejectedValueOnce(new Error("key-up geweigerd"))
        .mockResolvedValue(undefined)
    } as unknown as CodexBridge;
    const logError = vi.fn();
    const action = new PushToTalkAction(bridge, logError);
    const key = {
      id: "mic-release-failure",
      setState: vi.fn(async () => undefined),
      showAlert: vi.fn(async () => undefined)
    };

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    await action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    expect(key.setState).toHaveBeenLastCalledWith(0);
    expect(key.showAlert).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("Push-to-talk kon niet stoppen", expect.any(Error));

    await action.onKeyDown({ action: key } as unknown as KeyDownEvent);
    await action.onKeyUp({ action: key } as unknown as KeyUpEvent);
    expect(bridge.startDictation).toHaveBeenCalledTimes(2);
    expect(bridge.stopDictation).toHaveBeenCalledTimes(2);
  });
});
