import {
  action,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import type { CodexBridge, SessionView } from "./bridge.js";
import type { CodexCommand } from "./commands.js";
import { renderSessionKey, svgDataUri } from "./key-image.js";

type LogError = (message: string, error?: unknown) => void;

interface SessionSettings extends JsonObject {
  slot?: number;
}

@action({ UUID: "com.renehagen.codex-micro.session" })
export class SessionAction extends SingletonAction<SessionSettings> {
  private readonly unsubscribe: () => void;

  constructor(private readonly bridge: CodexBridge, private readonly logError: LogError) {
    super();
    this.unsubscribe = bridge.subscribe((sessions) => {
      void this.updateAll(sessions).catch((error: unknown) => this.logError("Sessieweergave kon niet worden bijgewerkt", error));
    });
  }

  override async onWillAppear(ev: WillAppearEvent<SessionSettings>): Promise<void> {
    await this.bridge.start().catch(async (error: unknown) => {
      this.logError("Codex bridge kon niet starten", error);
      await ev.action.showAlert();
    });
    if (ev.action.isKey()) await this.updateAction(ev.action, this.bridge.currentSessions);
  }

  override async onKeyDown(ev: KeyDownEvent<SessionSettings>): Promise<void> {
    const slot = ev.action.coordinates?.column ?? ev.payload.settings.slot ?? 0;
    try {
      await this.bridge.selectSlot(slot);
    } catch (error) {
      this.logError(`Sessieknop ${slot + 1} faalde`, error);
      await ev.action.showAlert();
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async updateAll(sessions: readonly SessionView[]): Promise<void> {
    await Promise.all(this.actions.map(async (instance) => {
      if (instance.isKey()) await this.updateAction(instance, sessions);
    }).toArray());
  }

  private async updateAction(actionInstance: KeyDownEvent<SessionSettings>["action"], sessions: readonly SessionView[]): Promise<void> {
    const slot = actionInstance.coordinates?.column ?? (await actionInstance.getSettings<SessionSettings>()).slot ?? 0;
    const session = sessions[slot];
    const image = renderSessionKey(session ?? {
      slot,
      threadId: "",
      title: "GEEN SESSIE",
      status: "idle",
      selected: false
    });
    await actionInstance.setImage(svgDataUri(image));
  }
}

abstract class CodexCommandAction extends SingletonAction {
  protected constructor(
    private readonly bridge: CodexBridge,
    private readonly command: CodexCommand,
    private readonly logError: LogError
  ) {
    super();
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try {
      await this.bridge.perform(this.command);
      await ev.action.showOk();
    } catch (error) {
      this.logError(`Codex-commando ${this.command} faalde`, error);
      await ev.action.showAlert();
    }
  }
}

@action({ UUID: "com.renehagen.codex-micro.effort-up" })
export class EffortUpAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "effort-up", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.fast-mode" })
export class FastModeAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "fast-mode", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.accept" })
export class AcceptAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "accept", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.reject" })
export class RejectAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "reject", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.branch" })
export class BranchAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "branch", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.effort-down" })
export class EffortDownAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "effort-down", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.agent" })
export class SubmitAction extends CodexCommandAction {
  constructor(bridge: CodexBridge, logError: LogError) { super(bridge, "submit", logError); }
}

@action({ UUID: "com.renehagen.codex-micro.push-to-talk" })
export class PushToTalkAction extends SingletonAction {
  private readonly active = new Map<string, Promise<void>>();
  private readonly pendingReleases = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private readonly bridge: CodexBridge, private readonly logError: LogError) { super(); }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.closing || this.active.has(ev.action.id) || this.pendingReleases.has(ev.action.id)) return;
    const start = Promise.resolve().then(() => this.bridge.startDictation());
    this.active.set(ev.action.id, start);
    try {
      await start;
      if (this.active.get(ev.action.id) !== start) return;
      await ev.action.setState(1);
      if (this.active.get(ev.action.id) !== start) await this.resetState(ev.action);
    } catch (error) {
      await this.release(ev.action.id).catch((cleanupError: unknown) => {
        if (cleanupError !== error) this.logError("Push-to-talk cleanup na startfout faalde", cleanupError);
      });
      await this.resetState(ev.action);
      this.logError("Push-to-talk kon niet starten", error);
      await ev.action.showAlert().catch((alertError: unknown) => this.logError("Push-to-talk waarschuwing kon niet worden getoond", alertError));
    }
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    await this.release(ev.action.id).catch((error: unknown) => {
      this.logError("Push-to-talk kon niet stoppen", error);
      return ev.action.showAlert().catch((alertError: unknown) => this.logError("Push-to-talk waarschuwing kon niet worden getoond", alertError));
    });
    await this.resetState(ev.action);
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    await this.release(ev.action.id).catch((error: unknown) => this.logError("Push-to-talk cleanup faalde", error));
  }

  async releaseAll(): Promise<void> {
    this.closing = true;
    const releases = new Set<Promise<void>>(this.pendingReleases.values());
    for (const actionId of [...this.active.keys()]) releases.add(this.release(actionId));
    for (const release of this.pendingReleases.values()) releases.add(release);
    const results = await Promise.allSettled(releases);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Niet alle push-to-talk-toetsen konden worden vrijgegeven");
  }

  private release(actionId: string): Promise<void> {
    const pending = this.pendingReleases.get(actionId);
    if (pending) return pending;
    const start = this.active.get(actionId);
    if (!start) return Promise.resolve();
    this.active.delete(actionId);
    const release = (async () => {
      await start;
      await this.bridge.stopDictation();
    })();
    this.pendingReleases.set(actionId, release);
    void release.then(
      () => { if (this.pendingReleases.get(actionId) === release) this.pendingReleases.delete(actionId); },
      () => { if (this.pendingReleases.get(actionId) === release) this.pendingReleases.delete(actionId); }
    );
    return release;
  }

  private async resetState(actionInstance: KeyDownEvent["action"] | KeyUpEvent["action"]): Promise<void> {
    await actionInstance.setState(0).catch((error: unknown) => this.logError("Push-to-talk toetsstatus kon niet worden hersteld", error));
  }
}
