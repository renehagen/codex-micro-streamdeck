import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { JsonObject } from "@elgato/utils";
import type { CodexThreadSummary } from "./codex-client.js";
import type { CodexThreadSettingsUpdate } from "./codex-ipc.js";
import type { StoredThreadControls, ThreadStateReader } from "./codex-state.js";
import type { CodexCommand } from "./commands.js";
import type { SessionStatus } from "./status.js";
import { analyzeRollout } from "./status.js";
import {
  loadModelCatalog,
  modelControlsFor,
  nextReasoningEffort,
  parseLatestThreadSettings,
  parseLiveThreadControls,
  toggleFastServiceTier,
  type ModelCatalog
} from "./thread-controls.js";

const POLL_INTERVAL_MS = 1_500;
const LIVE_CONTROLS_REFRESH_INTERVAL_MS = 30_000;
const MAX_TAIL_BYTES = 48 * 1024 * 1024;

export interface BridgeSettings extends JsonObject {
  selectedThreadId?: string;
  seenAt?: Record<string, number>;
  initializedAt?: number;
  threadControls?: Record<string, PersistedThreadControls>;
}

export interface PersistedThreadControls extends JsonObject {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
  updatedAt?: number;
}

export interface BridgeSettingsStore {
  load(): Promise<BridgeSettings>;
  save(settings: BridgeSettings): Promise<void>;
}

export interface RecentThreadSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  listRecentThreads(limit?: number): Promise<CodexThreadSummary[]>;
}

export interface DesktopController {
  openThread(threadId: string): Promise<void>;
  invoke(command: CodexCommand): Promise<void>;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
}

export interface ThreadSettingsUpdater {
  updateThreadSettings(threadId: string, settings: CodexThreadSettingsUpdate): Promise<void>;
  readThreadState?(threadId: string): Promise<Record<string, unknown>>;
  readActiveThread?(threadIds: readonly string[]): Promise<string | null>;
}

export interface SessionView {
  slot: number;
  threadId: string;
  title: string;
  status: SessionStatus;
  selected: boolean;
}

export interface BridgeOptions {
  pollIntervalMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
  settingsUpdater?: ThreadSettingsUpdater;
  stateReader?: ThreadStateReader;
  loadModelCatalog?: () => Promise<ModelCatalog>;
}

interface RolloutCache {
  size: number;
  text: string;
  status: SessionStatus;
}

interface EffectiveThreadControls {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
}

type ActiveThreadLookup =
  | { kind: "active"; threadId: string }
  | { kind: "none" }
  | { kind: "unavailable" };

export class CodexBridge {
  private readonly listeners = new Set<(sessions: readonly SessionView[]) => void>();
  private readonly rolloutCache = new Map<string, RolloutCache>();
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;
  private readonly settingsUpdater: ThreadSettingsUpdater | undefined;
  private readonly stateReader: ThreadStateReader | undefined;
  private readonly readModelCatalog: () => Promise<ModelCatalog>;
  private readonly liveControls = new Map<string, EffectiveThreadControls>();
  private readonly liveRefreshStartedAt = new Map<string, number>();
  private readonly liveRefreshInFlight = new Map<string, Promise<void>>();
  private readonly controlsRevision = new Map<string, number>();
  private settings: BridgeSettings = {};
  private sessions: SessionView[] = [];
  private threadSummaries = new Map<string, CodexThreadSummary>();
  private timer: NodeJS.Timeout | undefined;
  private startPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private desktopQueue: Promise<void> = Promise.resolve();
  private navigationError: Error | undefined;
  private started = false;

  constructor(
    private readonly threads: RecentThreadSource,
    private readonly desktop: DesktopController,
    private readonly store: BridgeSettingsStore,
    options: BridgeOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.settingsUpdater = options.settingsUpdater;
    this.stateReader = options.stateReader;
    this.readModelCatalog = options.loadModelCatalog ?? (() => loadModelCatalog());
  }

  get currentSessions(): readonly SessionView[] {
    return this.sessions;
  }

  subscribe(listener: (sessions: readonly SessionView[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.sessions);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    const run = this.startInternal();
    this.startPromise = run;
    try {
      await run;
    } finally {
      if (this.startPromise === run) this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.threads.stop();
  }

  async wake(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.start();
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const run = this.refreshInternal();
    this.refreshPromise = run;
    try {
      await run;
    } finally {
      if (this.refreshPromise === run) this.refreshPromise = undefined;
    }
  }

  async selectSlot(slot: number): Promise<void> {
    const session = this.sessions[slot];
    if (!session) throw new Error(`Geen Codex-sessie in slot ${slot + 1}`);
    await this.enqueueDesktop(async () => {
      try {
        await this.desktop.openThread(session.threadId);
        this.navigationError = undefined;
      } catch (error) {
        this.navigationError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }

      const seenAt = { ...(this.settings.seenAt ?? {}), [session.threadId]: this.now() };
      this.settings = { ...this.settings, selectedThreadId: session.threadId, seenAt };
      await this.store.save(this.settings);
      this.sessions = this.sessions.map((item) => ({
        ...item,
        selected: item.threadId === session.threadId,
        status: item.threadId === session.threadId && item.status === "unread" ? "idle" : item.status
      }));
      this.emit();
      this.scheduleLiveControlsRefresh(session.threadId, true);
    });
  }

  async perform(command: CodexCommand): Promise<void> {
    await this.enqueueDesktop(async () => {
      if (this.navigationError) throw this.navigationError;
      if (isThreadSettingsCommand(command)) {
        const activeThread = await this.syncSelectedThreadFromApp();
        if (activeThread === "none") {
          // A blank composer has no thread id yet, so live thread settings
          // cannot target it. Its native command does work before first send.
          await this.desktop.invoke(command);
        } else {
          await this.performThreadSettingsCommand(command);
        }
      } else {
        await this.desktop.invoke(command);
      }
    });
  }

  startDictation(): Promise<void> {
    return this.desktop.startDictation();
  }

  stopDictation(): Promise<void> {
    return this.desktop.stopDictation();
  }

  private async startInternal(): Promise<void> {
    this.settings = await this.store.load();
    await this.threads.start();
    try {
      await this.refresh();
      this.started = true;
      this.timer = setInterval(() => void this.refresh().catch((error: unknown) => this.report(error)), this.pollIntervalMs);
      this.timer.unref();
    } catch (error) {
      this.started = false;
      await this.threads.stop().catch(() => undefined);
      throw error;
    }
  }

  private async refreshInternal(): Promise<void> {
    const threadList = await this.threads.listRecentThreads(5);
    this.threadSummaries = new Map(threadList.map((thread) => [thread.id, thread]));
    const now = this.now();
    const seenAt = { ...(this.settings.seenAt ?? {}) };
    let settingsChanged = false;

    for (const thread of threadList) {
      if (seenAt[thread.id] === undefined) {
        seenAt[thread.id] = now;
        settingsChanged = true;
      }
    }

    const availableIds = new Set(threadList.map((thread) => thread.id));
    const activeThread = await this.lookupActiveThread([...availableIds]);
    const activeThreadId = activeThread.kind === "active" ? activeThread.threadId : undefined;
    const selectedThreadId = activeThreadId ?? (
      this.settings.selectedThreadId && availableIds.has(this.settings.selectedThreadId)
        ? this.settings.selectedThreadId
        : threadList[0]?.id
    );
    if (activeThreadId !== undefined && activeThreadId !== this.settings.selectedThreadId) {
      seenAt[activeThreadId] = now;
    }
    if (selectedThreadId !== this.settings.selectedThreadId) settingsChanged = true;

    const views = await Promise.all(threadList.map(async (thread, slot): Promise<SessionView> => ({
      slot,
      threadId: thread.id,
      title: thread.name?.trim() || thread.preview.trim() || `Sessie ${slot + 1}`,
      status: await this.statusForThread(thread, seenAt[thread.id] ?? now, now),
      selected: thread.id === selectedThreadId
    })));

    const wasUninitialized = this.settings.initializedAt === undefined;
    const nextSettings: BridgeSettings = {
      ...this.settings,
      seenAt,
      initializedAt: this.settings.initializedAt ?? now
    };
    if (selectedThreadId === undefined) {
      delete nextSettings.selectedThreadId;
    } else {
      nextSettings.selectedThreadId = selectedThreadId;
    }
    this.settings = nextSettings;
    if (settingsChanged || wasUninitialized) await this.store.save(this.settings);
    this.sessions = views;
    this.emit();
    if (selectedThreadId) this.scheduleLiveControlsRefresh(selectedThreadId);
  }

  private async performThreadSettingsCommand(
    command: "effort-up" | "effort-down" | "fast-mode"
  ): Promise<void> {
    if (!this.settingsUpdater) {
      throw new Error("Live Codex-instellingen zijn niet beschikbaar");
    }
    const session = this.selectedSession();
    const thread = this.threadSummaries.get(session.threadId);
    if (!thread) throw new Error("De geselecteerde Codex-sessie is niet meer beschikbaar");

    const current = await this.effectiveControls(thread);
    const catalog = await this.readModelCatalog();
    const model = modelControlsFor(catalog, current.model ?? "");
    let update: CodexThreadSettingsUpdate;
    let next: EffectiveThreadControls;

    if (command === "fast-mode") {
      if (model.serviceTiers.length === 0) {
        throw new Error(`Fast wordt niet ondersteund door ${current.model ?? "het huidige model"}`);
      }
      const serviceTier = toggleFastServiceTier(current.serviceTier, model);
      update = { serviceTier };
      next = { ...current, serviceTier };
    } else {
      const reasoningEffort = nextReasoningEffort(
        current.reasoningEffort,
        command === "effort-up" ? "up" : "down",
        model
      );
      update = { effort: reasoningEffort };
      next = { ...current, reasoningEffort };
    }

    await this.updateLiveThread(session.threadId, update);
    await this.persistControls(session.threadId, next);
  }

  private selectedSession(): SessionView {
    const selected = this.sessions.find((session) => session.threadId === this.settings.selectedThreadId)
      ?? this.sessions[0];
    if (!selected) throw new Error("Geen recente Codex-sessie beschikbaar");
    return selected;
  }

  private async syncSelectedThreadFromApp(): Promise<"active" | "none" | "unavailable"> {
    const activeThread = await this.lookupActiveThread(
      this.sessions.map((session) => session.threadId),
    );
    if (activeThread.kind !== "active") return activeThread.kind;
    const activeThreadId = activeThread.threadId;
    if (activeThreadId === this.settings.selectedThreadId) return "active";

    const seenAt = { ...(this.settings.seenAt ?? {}), [activeThreadId]: this.now() };
    this.settings = { ...this.settings, selectedThreadId: activeThreadId, seenAt };
    await this.store.save(this.settings);
    this.sessions = this.sessions.map((session) => ({
      ...session,
      selected: session.threadId === activeThreadId,
      status: session.threadId === activeThreadId && session.status === "unread"
        ? "idle"
        : session.status
    }));
    this.emit();
    this.scheduleLiveControlsRefresh(activeThreadId, true);
    return "active";
  }

  private async lookupActiveThread(threadIds: readonly string[]): Promise<ActiveThreadLookup> {
    const readActiveThread = this.settingsUpdater?.readActiveThread;
    if (!readActiveThread) return { kind: "unavailable" };
    if (threadIds.length === 0) return { kind: "none" };
    try {
      const activeThreadId = await readActiveThread.call(this.settingsUpdater, threadIds);
      return activeThreadId !== null && threadIds.includes(activeThreadId)
        ? { kind: "active", threadId: activeThreadId }
        : { kind: "none" };
    } catch {
      // Mouse-selection sync is an enhancement; retain the last explicit
      // Stream Deck selection if the desktop IPC is temporarily unavailable.
      return { kind: "unavailable" };
    }
  }

  private async effectiveControls(thread: CodexThreadSummary): Promise<EffectiveThreadControls> {
    const rollout = thread.path ? this.rolloutCache.get(thread.path)?.text : undefined;
    const applied = rollout ? parseLatestThreadSettings(rollout) : null;
    const persisted = this.settings.threadControls?.[thread.id];
    const appliedAt = applied ? Date.parse(applied.timestamp) : Number.NaN;
    const persistedAt = persisted?.updatedAt;
    const usePersisted = persisted !== undefined && (
      !Number.isFinite(appliedAt) || (persistedAt ?? 0) >= appliedAt
    );

    let fallback: EffectiveThreadControls;
    if (usePersisted) {
      fallback = {
        ...(persisted.model === undefined ? {} : { model: persisted.model }),
        ...(persisted.reasoningEffort === undefined ? {} : { reasoningEffort: persisted.reasoningEffort }),
        ...(Object.hasOwn(persisted, "serviceTier") ? { serviceTier: persisted.serviceTier } : {})
      };
    } else if (applied) {
      fallback = {
        model: applied.model,
        reasoningEffort: applied.reasoningEffort,
        serviceTier: applied.serviceTier
      };
    } else {
      fallback = {};
    }

    let current = { ...fallback, ...(this.liveControls.get(thread.id) ?? {}) };
    if (!this.stateReader) return current;
    try {
      const stored = await this.stateReader.readThreadControls(thread.id);
      current = this.mergeStoredControls(current, persisted, stored);
    } catch {
      // The local database is only the fast path; persisted state remains usable.
    }
    return current;
  }

  private async updateLiveThread(threadId: string, update: CodexThreadSettingsUpdate): Promise<void> {
    try {
      await this.settingsUpdater!.updateThreadSettings(threadId, update);
    } catch (error) {
      if (!isRetryableLiveUpdateError(error)) throw error;
      await this.desktop.openThread(threadId);
      this.navigationError = undefined;
      await this.settingsUpdater!.updateThreadSettings(threadId, update);
    }
  }

  private async persistControls(threadId: string, controls: EffectiveThreadControls): Promise<void> {
    const persisted: PersistedThreadControls = { updatedAt: this.now() };
    if (controls.model !== undefined) persisted.model = controls.model;
    if (controls.reasoningEffort !== undefined) persisted.reasoningEffort = controls.reasoningEffort;
    if (controls.serviceTier !== undefined) persisted.serviceTier = controls.serviceTier;
    this.settings = {
      ...this.settings,
      threadControls: { ...(this.settings.threadControls ?? {}), [threadId]: persisted }
    };
    this.controlsRevision.set(threadId, (this.controlsRevision.get(threadId) ?? 0) + 1);
    this.liveControls.set(threadId, { ...(this.liveControls.get(threadId) ?? {}), ...controls });
    await this.store.save(this.settings);
  }

  private mergeStoredControls(
    current: EffectiveThreadControls,
    persisted: PersistedThreadControls | undefined,
    stored: StoredThreadControls
  ): EffectiveThreadControls {
    const persistedAt = persisted?.updatedAt ?? 0;
    const storedAt = stored.updatedAt ?? 0;
    if (persisted !== undefined && storedAt < persistedAt) return current;
    return {
      ...current,
      ...(stored.model === undefined ? {} : { model: stored.model }),
      ...(stored.reasoningEffort === undefined ? {} : { reasoningEffort: stored.reasoningEffort })
    };
  }

  private scheduleLiveControlsRefresh(threadId: string, force = false): void {
    const readLiveState = this.settingsUpdater?.readThreadState;
    if (!readLiveState || this.liveRefreshInFlight.has(threadId)) return;
    const now = this.now();
    const lastStartedAt = this.liveRefreshStartedAt.get(threadId) ?? Number.NEGATIVE_INFINITY;
    if (!force && now - lastStartedAt < LIVE_CONTROLS_REFRESH_INTERVAL_MS) return;

    this.liveRefreshStartedAt.set(threadId, now);
    const revision = this.controlsRevision.get(threadId) ?? 0;
    const refresh = Promise.resolve()
      .then(() => readLiveState.call(this.settingsUpdater, threadId))
      .then((state) => {
        if ((this.controlsRevision.get(threadId) ?? 0) !== revision) return;
        this.liveControls.set(threadId, {
          ...(this.liveControls.get(threadId) ?? {}),
          ...parseLiveThreadControls(state)
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.liveRefreshInFlight.get(threadId) === refresh) this.liveRefreshInFlight.delete(threadId);
      });
    this.liveRefreshInFlight.set(threadId, refresh);
  }

  private async statusForThread(thread: CodexThreadSummary, seenAt: number, now: number): Promise<SessionStatus> {
    if (thread.status.type === "systemError") return "error";
    if (thread.status.type === "active") {
      const flags = Array.isArray(thread.status.activeFlags) ? thread.status.activeFlags : [];
      if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) return "needs-input";
    }
    if (!thread.path) return thread.status.type === "active" ? "thinking" : "idle";

    let update: { text: string; appended: string; size: number } | undefined;
    try {
      update = await this.readRollout(thread.path);
    } catch (error) {
      this.report(error);
      return thread.status.type === "active" ? "thinking" : "idle";
    }
    if (!update) return thread.status.type === "active" ? "thinking" : "idle";
    const next = analyzeRollout(update.text, seenAt, now);
    const previous = this.rolloutCache.get(thread.path)?.status;
    let status = next;
    if (previous === "needs-input" && next !== "needs-input" && !hasResolutionOrTerminal(update.appended)) status = "needs-input";
    if (previous === "thinking" && (next === "idle" || next === "unread") && !hasTerminal(update.appended)) status = "thinking";
    this.rolloutCache.set(thread.path, { size: update.size, text: update.text, status });
    return status;
  }

  private async readRollout(path: string): Promise<{ text: string; appended: string; size: number } | undefined> {
    if (!isCodexSessionPath(path)) return undefined;
    await access(path, constants.R_OK);
    const file = await stat(path);
    const previous = this.rolloutCache.get(path);
    if (previous && previous.size === file.size) return { text: previous.text, appended: "", size: file.size };

    const handle = await open(path, "r");
    try {
      let start: number;
      let length: number;
      if (previous && file.size > previous.size && file.size - previous.size <= MAX_TAIL_BYTES) {
        start = previous.size;
        length = file.size - previous.size;
      } else {
        start = Math.max(0, file.size - MAX_TAIL_BYTES);
        length = file.size - start;
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let appended = buffer.toString("utf8");
      let text = previous && start === previous.size ? `${previous.text}${appended}` : appended;
      if (start > 0 && (!previous || start !== previous.size)) {
        const firstLine = text.indexOf("\n");
        if (firstLine >= 0) text = text.slice(firstLine + 1);
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TAIL_BYTES) {
        const keep = Buffer.from(text, "utf8").subarray(-MAX_TAIL_BYTES).toString("utf8");
        const firstLine = keep.indexOf("\n");
        text = firstLine >= 0 ? keep.slice(firstLine + 1) : keep;
      }
      return { text, appended, size: file.size };
    } finally {
      await handle.close();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.sessions);
  }

  private enqueueDesktop<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.desktopQueue.then(operation, operation);
    this.desktopQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private report(value: unknown): void {
    this.onError(value instanceof Error ? value : new Error(String(value)));
  }
}

type ThreadSettingsCommand = Extract<CodexCommand, "effort-up" | "effort-down" | "fast-mode">;

function isThreadSettingsCommand(command: CodexCommand): command is ThreadSettingsCommand {
  return command === "effort-up" || command === "effort-down" || command === "fast-mode";
}

function isRetryableLiveUpdateError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && new Set([
    "connect",
    "connect-timeout",
    "no-client-found",
    "socket",
    "socket-ended",
    "socket-closed",
    "timeout"
  ]).has(code);
}

function isCodexSessionPath(path: string): boolean {
  const codexHome = resolve(process.env.CODEX_HOME || `${homedir()}/.codex`);
  const sessionsRoot = `${resolve(codexHome, "sessions")}${sep}`;
  return resolve(path).startsWith(sessionsRoot);
}

function hasTerminal(text: string): boolean {
  return text.includes('"type":"task_complete"') || text.includes('"type":"turn_aborted"');
}

function hasResolutionOrTerminal(text: string): boolean {
  return hasTerminal(text) || text.includes('"type":"custom_tool_call_output"') || text.includes('"type":"function_call_output"');
}
