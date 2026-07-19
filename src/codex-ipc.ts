import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

type JsonObject = Record<string, unknown>;

export interface CodexThreadSettingsUpdate {
  effort?: string | null;
  serviceTier?: string | null;
}

export type ConnectCodexIpcSocket = (path: string) => Promise<Duplex>;

export interface CodexIpcClientOptions {
  /** Explicit override for non-default Codex homes and tests. */
  socketPath?: string;
  connectSocket?: ConnectCodexIpcSocket;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  createRequestId?: () => string;
}

interface PendingResponse {
  timer: NodeJS.Timeout;
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
}

interface PendingBroadcast {
  timer: NodeJS.Timeout;
  matches: (message: JsonObject) => boolean;
  resolve: (message: JsonObject) => void;
  reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const ACTIVE_THREAD_RESPONSE_TIMEOUT_MS = 350;
const ACTIVE_THREAD_SETTLE_MS = 25;

export const DEFAULT_CODEX_IPC_SOCKET_PATH = join(
  process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
  "ipc",
  "ipc.sock",
);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (isJsonObject(value) && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

function encodeFrame(message: JsonObject): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function defaultConnectSocket(path: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const handleInitialError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };

    socket.once("error", handleInitialError);
    socket.once("connect", () => {
      socket.off("error", handleInitialError);
      resolve(socket);
    });
  });
}

export class CodexIpcError extends Error {
  readonly code: string | number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: string | number, data?: unknown) {
    super(message);
    this.name = "CodexIpcError";
    this.code = code;
    this.data = data;
  }
}

class FramedIpcConnection {
  private buffer = Buffer.alloc(0);
  private terminalError: Error | undefined;
  private closing = false;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly broadcastWaiters = new Set<PendingBroadcast>();

  constructor(
    private readonly socket: Duplex,
    private readonly timeoutMs: number,
    private readonly maxFrameBytes: number,
  ) {
    socket.on("data", this.handleData);
    socket.once("error", this.handleError);
    socket.once("end", this.handleEnd);
    socket.once("close", this.handleClose);
  }

  request(message: JsonObject): Promise<JsonObject> {
    const requestId = message.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return Promise.reject(new TypeError("IPC requestId mag niet leeg zijn"));
    }
    if (this.terminalError !== undefined) {
      return Promise.reject(this.terminalError);
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(
        new Error(`IPC requestId is al in gebruik: ${requestId}`),
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new CodexIpcError(
            `ChatGPT IPC-request verliep na ${this.timeoutMs} ms`,
            "timeout",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { timer, resolve, reject });

      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  broadcast(message: JsonObject): void {
    this.write(message);
  }

  broadcastAndWait(
    message: JsonObject,
    matches: (message: JsonObject) => boolean,
  ): Promise<JsonObject> {
    const waiting = this.waitForBroadcast(matches);
    try {
      this.write(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return waiting;
  }

  waitForBroadcast(
    matches: (message: JsonObject) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<JsonObject> {
    if (this.terminalError !== undefined) {
      return Promise.reject(this.terminalError);
    }

    return new Promise((resolve, reject) => {
      const waiter: PendingBroadcast = {
        timer: setTimeout(() => {
          this.broadcastWaiters.delete(waiter);
          reject(
            new CodexIpcError(
              `ChatGPT IPC-broadcast verliep na ${timeoutMs} ms`,
              "broadcast-timeout",
            ),
          );
        }, timeoutMs),
        matches,
        resolve,
        reject,
      };
      this.broadcastWaiters.add(waiter);
    });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.fail(new CodexIpcError("ChatGPT IPC-verbinding is gesloten"));
    try {
      this.socket.end();
    } finally {
      this.socket.destroy();
    }
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.terminalError !== undefined) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buffer = this.buffer.length === 0
      ? Buffer.from(bytes)
      : Buffer.concat([this.buffer, bytes]);

    try {
      while (this.buffer.length >= 4) {
        const payloadLength = this.buffer.readUInt32LE(0);
        if (payloadLength > this.maxFrameBytes) {
          throw new CodexIpcError(
            `ChatGPT IPC-frame is te groot (${payloadLength} bytes)`,
            "frame-too-large",
          );
        }
        if (this.buffer.length < payloadLength + 4) return;

        const payload = this.buffer.subarray(4, payloadLength + 4);
        this.buffer = this.buffer.subarray(payloadLength + 4);
        const parsed: unknown = JSON.parse(payload.toString("utf8"));
        if (!isJsonObject(parsed)) {
          throw new CodexIpcError(
            "ChatGPT IPC-frame bevat geen JSON-object",
            "invalid-frame",
          );
        }
        this.handleMessage(parsed);
      }
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new CodexIpcError(String(error), "invalid-frame"),
      );
      this.socket.destroy();
    }
  };

  private readonly handleError = (error: Error): void => {
    this.fail(new CodexIpcError(`ChatGPT IPC-fout: ${error.message}`, "socket"));
  };

  private readonly handleEnd = (): void => {
    if (!this.closing) {
      this.fail(
        new CodexIpcError(
          "ChatGPT IPC-verbinding werd onverwacht beëindigd",
          "socket-ended",
        ),
      );
    }
  };

  private readonly handleClose = (): void => {
    if (!this.closing) {
      this.fail(
        new CodexIpcError(
          "ChatGPT IPC-verbinding werd onverwacht gesloten",
          "socket-closed",
        ),
      );
    }
  };

  private handleMessage(message: JsonObject): void {
    if (message.type === "client-discovery-request") {
      const requestId = message.requestId;
      if (typeof requestId === "string" && requestId.length > 0) {
        this.write({
          type: "client-discovery-response",
          requestId,
          response: { canHandle: false },
        });
      }
      return;
    }

    if (message.type === "broadcast") {
      for (const waiter of [...this.broadcastWaiters]) {
        let matched = false;
        try {
          matched = waiter.matches(message);
        } catch (error) {
          clearTimeout(waiter.timer);
          this.broadcastWaiters.delete(waiter);
          waiter.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          continue;
        }
        if (!matched) continue;

        clearTimeout(waiter.timer);
        this.broadcastWaiters.delete(waiter);
        waiter.resolve(message);
      }
      return;
    }

    // Requests that are not addressed to this passive client are ignored.
    if (message.type !== "response") return;
    const requestId = message.requestId;
    if (typeof requestId !== "string") return;
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  private write(message: JsonObject): void {
    if (this.terminalError !== undefined) throw this.terminalError;
    this.socket.write(encodeFrame(message));
  }

  private fail(error: Error): void {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.broadcastWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.broadcastWaiters.clear();
  }
}

/**
 * Talks to the live ChatGPT renderer through its local Codex IPC router.
 *
 * A fresh, short-lived connection is used for every update. That keeps a
 * Stream Deck plugin restart independent from the ChatGPT app lifecycle.
 */
export class CodexIpcClient {
  private readonly socketPath: string;
  private readonly connectSocket: ConnectCodexIpcSocket;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly createRequestId: () => string;

  constructor(options: CodexIpcClientOptions = {}) {
    this.socketPath = options.socketPath ?? DEFAULT_CODEX_IPC_SOCKET_PATH;
    this.connectSocket = options.connectSocket ?? defaultConnectSocket;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.createRequestId = options.createRequestId ?? randomUUID;

    if (this.socketPath.length === 0) {
      throw new TypeError("socketPath mag niet leeg zijn");
    }
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs moet groter dan nul zijn");
    }
    if (
      !Number.isSafeInteger(this.maxFrameBytes) ||
      this.maxFrameBytes <= 0 ||
      this.maxFrameBytes > 0xffff_ffff
    ) {
      throw new RangeError(
        "maxFrameBytes moet een positief 32-bits geheel getal zijn",
      );
    }
  }

  async updateThreadSettings(
    threadId: string,
    settings: CodexThreadSettingsUpdate,
  ): Promise<void> {
    if (threadId.trim().length === 0) {
      throw new TypeError("threadId mag niet leeg zijn");
    }
    if (
      settings.effort === undefined &&
      settings.serviceTier === undefined
    ) {
      throw new TypeError(
        "Geef minimaal effort of serviceTier op voor de thread-update",
      );
    }
    if (
      settings.effort !== undefined &&
      settings.effort !== null &&
      settings.effort.trim().length === 0
    ) {
      throw new TypeError("effort mag niet leeg zijn");
    }
    if (
      settings.serviceTier !== undefined &&
      settings.serviceTier !== null &&
      settings.serviceTier.trim().length === 0
    ) {
      throw new TypeError("serviceTier mag niet leeg zijn");
    }

    const socket = await this.connectWithTimeout();
    const connection = new FramedIpcConnection(
      socket,
      this.requestTimeoutMs,
      this.maxFrameBytes,
    );

    try {
      const clientId = await this.initialize(connection);

      const updateRequestId = this.createRequestId();
      const updateResponse = await connection.request({
        type: "request",
        requestId: updateRequestId,
        sourceClientId: clientId,
        version: 1,
        method: "thread-follower-update-thread-settings",
        params: {
          conversationId: threadId,
          threadSettings: settings,
        },
        timeoutMs: this.requestTimeoutMs,
      });
      const updateResult = this.unwrapSuccess(
        updateResponse,
        "thread-follower-update-thread-settings",
      );
      if (updateResult.ok !== true) {
        throw new CodexIpcError(
          "ChatGPT heeft de threadinstellingen niet bevestigd",
          "invalid-response",
          updateResponse,
        );
      }
    } finally {
      connection.close();
    }
  }

  /**
   * Returns the single visible Codex thread among the supplied candidates.
   *
   * Codex renderers publish a targeted `following=true` response only for
   * conversations currently mounted in their UI. Requiring the response to
   * target this exact IPC client prevents background broadcasts and our own
   * snapshot readers from being mistaken for a mouse-driven selection.
   */
  async readActiveThread(threadIds: readonly string[]): Promise<string | null> {
    const candidates = [...new Set(threadIds.map((id) => id.trim()).filter(Boolean))];
    if (candidates.length === 0) return null;

    const socket = await this.connectWithTimeout();
    const connection = new FramedIpcConnection(
      socket,
      this.requestTimeoutMs,
      this.maxFrameBytes,
    );

    try {
      const clientId = await this.initialize(connection);
      const responses = new Set<string>();
      const timeoutMs = Math.min(
        this.requestTimeoutMs,
        ACTIVE_THREAD_RESPONSE_TIMEOUT_MS,
      );
      const waiters = candidates.map((conversationId) =>
        connection.waitForBroadcast(
          (message) => isActiveThreadResponse(message, clientId, conversationId),
          timeoutMs,
        ).then(() => {
          responses.add(conversationId);
        }),
      );

      for (const conversationId of candidates) {
        connection.broadcast({
          type: "broadcast",
          sourceClientId: clientId,
          version: 1,
          method: "thread-stream-following-status-requested",
          params: { hostId: "local", conversationId },
        });
      }

      try {
        await Promise.any(waiters);
      } catch {
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ACTIVE_THREAD_SETTLE_MS));
      return responses.size === 1 ? [...responses][0]! : null;
    } finally {
      connection.close();
    }
  }

  async readThreadState(threadId: string): Promise<Record<string, unknown>> {
    if (threadId.trim().length === 0) {
      throw new TypeError("threadId mag niet leeg zijn");
    }

    const socket = await this.connectWithTimeout();
    const connection = new FramedIpcConnection(
      socket,
      this.requestTimeoutMs,
      this.maxFrameBytes,
    );
    let clientId: string | undefined;

    try {
      clientId = await this.initialize(connection);
      const snapshot = await connection.broadcastAndWait(
        {
          type: "broadcast",
          sourceClientId: clientId,
          version: 1,
          method: "thread-stream-following-changed",
          params: {
            hostId: "local",
            conversationId: threadId,
            following: true,
          },
        },
        (message) => {
          if (message.method !== "thread-stream-state-changed") return false;
          const params = message.params;
          if (!isJsonObject(params) || params.conversationId !== threadId) {
            return false;
          }
          const change = params.change;
          return isJsonObject(change) && change.type === "snapshot";
        },
      );

      const params = snapshot.params;
      const change = isJsonObject(params) ? params.change : undefined;
      const conversationState = isJsonObject(change)
        ? change.conversationState
        : undefined;
      if (!isJsonObject(conversationState)) {
        throw new CodexIpcError(
          "ChatGPT IPC-snapshot bevat geen conversationState",
          "invalid-response",
          snapshot,
        );
      }
      return conversationState;
    } finally {
      if (clientId !== undefined) {
        try {
          connection.broadcast({
            type: "broadcast",
            sourceClientId: clientId,
            version: 1,
            method: "thread-stream-following-changed",
            params: {
              hostId: "local",
              conversationId: threadId,
              following: false,
            },
          });
        } catch {
          // Following=false is cleanup only; preserve the primary result/error.
        }
      }
      connection.close();
    }
  }

  private async initialize(connection: FramedIpcConnection): Promise<string> {
    const initializeRequestId = this.createRequestId();
    const initializeResponse = await connection.request({
      type: "request",
      requestId: initializeRequestId,
      sourceClientId: "initializing-client",
      version: 0,
      method: "initialize",
      params: { clientType: "codex-streamdeck" },
    });
    const initializeResult = this.unwrapSuccess(
      initializeResponse,
      "initialize",
    );
    const clientId = initializeResult.clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new CodexIpcError(
        "ChatGPT IPC-initialize gaf geen clientId terug",
        "invalid-response",
        initializeResponse,
      );
    }
    return clientId;
  }

  private async connectWithTimeout(): Promise<Duplex> {
    let expired = false;
    const pendingConnection = Promise.resolve().then(() =>
      this.connectSocket(this.socketPath)
    );
    let timer: NodeJS.Timeout | undefined;
    const timerPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(
          new CodexIpcError(
            `ChatGPT IPC-verbinding verliep na ${this.requestTimeoutMs} ms`,
            "connect-timeout",
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref();
    });

    pendingConnection.then(
      (socket) => {
        if (expired) socket.destroy();
      },
      () => undefined,
    );

    try {
      return await Promise.race([pendingConnection, timerPromise]);
    } catch (error) {
      if (error instanceof CodexIpcError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CodexIpcError(
        `Kan niet verbinden met ChatGPT IPC: ${message}`,
        "connect",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private unwrapSuccess(response: JsonObject, method: string): JsonObject {
    if (response.resultType !== "success") {
      const error = response.error;
      const code = isJsonObject(error) &&
          (typeof error.code === "string" || typeof error.code === "number")
        ? error.code
        : typeof response.code === "string" || typeof response.code === "number"
          ? response.code
          : undefined;
      throw new CodexIpcError(
        errorMessage(error) ??
          errorMessage(response.message) ??
          `ChatGPT IPC-methode ${method} is mislukt`,
        code,
        error ?? response,
      );
    }

    const result = response.result;
    if (!isJsonObject(result)) {
      throw new CodexIpcError(
        `ChatGPT IPC-methode ${method} gaf een ongeldig resultaat`,
        "invalid-response",
        response,
      );
    }
    return result;
  }
}

function isActiveThreadResponse(
  message: JsonObject,
  clientId: string,
  conversationId: string,
): boolean {
  if (message.type !== "broadcast" || message.method !== "thread-stream-following-changed") {
    return false;
  }
  const targets = message.targetClientIds;
  if (!Array.isArray(targets) || !targets.includes(clientId)) return false;
  const params = message.params;
  return isJsonObject(params) &&
    params.hostId === "local" &&
    params.conversationId === conversationId &&
    params.following === true;
}
