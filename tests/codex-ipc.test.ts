import { Duplex } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexIpcClient,
  DEFAULT_CODEX_IPC_SOCKET_PATH,
  type CodexThreadSettingsUpdate,
} from "../src/codex-ipc.js";

type JsonObject = Record<string, unknown>;

function encodeFrame(message: JsonObject): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class FakeIpcSocket extends Duplex {
  readonly received: JsonObject[] = [];
  private input = Buffer.alloc(0);

  constructor(
    private readonly handleMessage: (
      message: JsonObject,
      socket: FakeIpcSocket,
    ) => void,
  ) {
    super();
  }

  override _read(): void {
    // Test server pushes responses explicitly.
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.input = this.input.length === 0
      ? Buffer.from(bytes)
      : Buffer.concat([this.input, bytes]);

    while (this.input.length >= 4) {
      const length = this.input.readUInt32LE(0);
      if (this.input.length < length + 4) break;
      const message = JSON.parse(
        this.input.subarray(4, length + 4).toString("utf8"),
      ) as JsonObject;
      this.input = this.input.subarray(length + 4);
      this.received.push(message);
      this.handleMessage(message, this);
    }
    callback();
  }

  send(message: JsonObject, splitAt?: number): void {
    const frame = encodeFrame(message);
    if (splitAt === undefined) {
      this.push(frame);
      return;
    }
    this.push(frame.subarray(0, splitAt));
    this.push(frame.subarray(splitAt));
  }

  sendRaw(bytes: Buffer): void {
    this.push(bytes);
  }
}

function respondToInitialize(
  message: JsonObject,
  socket: FakeIpcSocket,
): boolean {
  if (message.method !== "initialize") return false;
  socket.send(
    {
      type: "client-discovery-request",
      requestId: "discovery-1",
      request: { method: "unrelated-method" },
    },
    3,
  );
  socket.send(
    {
      type: "response",
      requestId: message.requestId,
      resultType: "success",
      method: "initialize",
      handledByClientId: "router",
      result: { clientId: "streamdeck-client-17" },
    },
    9,
  );
  return true;
}

describe("CodexIpcClient", () => {
  it("uses the IPC socket inside the default .codex home", () => {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    expect(DEFAULT_CODEX_IPC_SOCKET_PATH).toBe(join(codexHome, "ipc", "ipc.sock"));
  });

  it("initializes, answers discovery and updates live thread settings", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (message.method === "thread-follower-update-thread-settings") {
        peer.send({ type: "broadcast", event: "ignored" });
        peer.send({
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: message.method,
          handledByClientId: "renderer-owner",
          result: { ok: true },
        });
      }
    });
    const connectSocket = vi.fn(async () => socket);
    const ids = ["initialize-17", "update-17"];
    const client = new CodexIpcClient({
      socketPath: "/tmp/codex-test.sock",
      connectSocket,
      createRequestId: () => ids.shift() ?? "unexpected-id",
    });

    await client.updateThreadSettings("thread-17", {
      effort: "high",
      serviceTier: "priority",
    });

    expect(connectSocket).toHaveBeenCalledWith("/tmp/codex-test.sock");
    expect(socket.received).toContainEqual({
      type: "request",
      requestId: "initialize-17",
      sourceClientId: "initializing-client",
      version: 0,
      method: "initialize",
      params: { clientType: "codex-streamdeck" },
    });
    expect(socket.received).toContainEqual({
      type: "client-discovery-response",
      requestId: "discovery-1",
      response: { canHandle: false },
    });
    expect(socket.received).toContainEqual({
      type: "request",
      requestId: "update-17",
      sourceClientId: "streamdeck-client-17",
      version: 1,
      method: "thread-follower-update-thread-settings",
      params: {
        conversationId: "thread-17",
        threadSettings: {
          effort: "high",
          serviceTier: "priority",
        },
      },
      timeoutMs: 5_000,
    });
    expect(socket.destroyed).toBe(true);
  });

  it("surfaces a renderer rejection and still closes the socket", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (message.method === "thread-follower-update-thread-settings") {
        peer.send({
          type: "response",
          requestId: message.requestId,
          resultType: "error",
          method: message.method,
          error: { code: "no-client-found", message: "Geen owner gevonden" },
        });
      }
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
    });

    await expect(
      client.updateThreadSettings("thread-17", { effort: "xhigh" }),
    ).rejects.toMatchObject({
      name: "CodexIpcError",
      code: "no-client-found",
      message: "Geen owner gevonden",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("follows a thread, returns its fragmented snapshot and unfollows", async () => {
    const conversationState = {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      serviceTier: "priority",
      nested: { preserved: true },
    };
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (
        message.method === "thread-stream-following-changed" &&
        (message.params as JsonObject).following === true
      ) {
        peer.send({
          type: "broadcast",
          method: "thread-stream-state-changed",
          params: {
            conversationId: "another-thread",
            change: { type: "snapshot", conversationState: { wrong: 1 } },
          },
        });
        peer.send({
          type: "broadcast",
          method: "another-broadcast",
          params: { conversationId: "thread-17" },
        });
        peer.send(
          {
            type: "broadcast",
            method: "thread-stream-state-changed",
            params: {
              conversationId: "thread-17",
              change: { type: "snapshot", conversationState },
            },
          },
          11,
        );
      }
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
      createRequestId: () => "initialize-read-17",
    });

    await expect(client.readThreadState("thread-17")).resolves.toEqual(
      conversationState,
    );
    expect(socket.received).toContainEqual({
      type: "broadcast",
      sourceClientId: "streamdeck-client-17",
      version: 1,
      method: "thread-stream-following-changed",
      params: {
        hostId: "local",
        conversationId: "thread-17",
        following: true,
      },
    });
    expect(socket.received).toContainEqual({
      type: "broadcast",
      sourceClientId: "streamdeck-client-17",
      version: 1,
      method: "thread-stream-following-changed",
      params: {
        hostId: "local",
        conversationId: "thread-17",
        following: false,
      },
    });
    expect(socket.destroyed).toBe(true);
  });

  it("reads the visible Codex thread from targeted following responses", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (
        message.method === "thread-stream-following-status-requested" &&
        (message.params as JsonObject).conversationId === "thread-2"
      ) {
        peer.send({
          type: "broadcast",
          method: "thread-stream-following-changed",
          sourceClientId: "renderer-owner",
          targetClientIds: ["streamdeck-client-17"],
          version: 1,
          params: {
            hostId: "local",
            conversationId: "thread-2",
            following: true,
          },
        });
      }
    });
    const client = new CodexIpcClient({ connectSocket: async () => socket });

    await expect(client.readActiveThread(["thread-1", "thread-2"]))
      .resolves.toBe("thread-2");
    expect(socket.received).toContainEqual({
      type: "broadcast",
      sourceClientId: "streamdeck-client-17",
      version: 1,
      method: "thread-stream-following-status-requested",
      params: { hostId: "local", conversationId: "thread-2" },
    });
    expect(socket.destroyed).toBe(true);
  });

  it("ignores untargeted following broadcasts when reading the visible thread", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (message.method === "thread-stream-following-status-requested") {
        peer.send({
          type: "broadcast",
          method: "thread-stream-following-changed",
          sourceClientId: "another-streamdeck-client",
          params: {
            hostId: "local",
            conversationId: "thread-1",
            following: true,
          },
        });
      }
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
      requestTimeoutMs: 20,
    });

    await expect(client.readActiveThread(["thread-1"])).resolves.toBeNull();
    expect(socket.destroyed).toBe(true);
  });

  it("refuses an ambiguous active-thread result", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (respondToInitialize(message, peer)) return;
      if (message.method !== "thread-stream-following-status-requested") return;
      const conversationId = (message.params as JsonObject).conversationId;
      peer.send({
        type: "broadcast",
        method: "thread-stream-following-changed",
        sourceClientId: `renderer-${conversationId}`,
        targetClientIds: ["streamdeck-client-17"],
        version: 1,
        params: {
          hostId: "local",
          conversationId,
          following: true,
        },
      });
    });
    const client = new CodexIpcClient({ connectSocket: async () => socket });

    await expect(client.readActiveThread(["thread-1", "thread-2"]))
      .resolves.toBeNull();
    expect(socket.destroyed).toBe(true);
  });

  it("times out waiting for a snapshot, then unfollows and closes", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      respondToInitialize(message, peer);
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
      requestTimeoutMs: 20,
    });

    await expect(client.readThreadState("thread-17")).rejects.toMatchObject({
      name: "CodexIpcError",
      code: "broadcast-timeout",
    });
    expect(socket.received).toContainEqual({
      type: "broadcast",
      sourceClientId: "streamdeck-client-17",
      version: 1,
      method: "thread-stream-following-changed",
      params: {
        hostId: "local",
        conversationId: "thread-17",
        following: false,
      },
    });
    expect(socket.destroyed).toBe(true);
  });

  it("times out an unanswered update and closes the socket", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      respondToInitialize(message, peer);
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
      requestTimeoutMs: 20,
    });

    await expect(
      client.updateThreadSettings("thread-17", { serviceTier: null }),
    ).rejects.toMatchObject({
      name: "CodexIpcError",
      code: "timeout",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("rejects oversized frames before buffering their payload", async () => {
    const socket = new FakeIpcSocket((message, peer) => {
      if (message.method !== "initialize") return;
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(129, 0);
      peer.sendRaw(prefix);
    });
    const client = new CodexIpcClient({
      connectSocket: async () => socket,
      maxFrameBytes: 128,
    });

    await expect(
      client.updateThreadSettings("thread-17", { effort: "medium" }),
    ).rejects.toMatchObject({
      name: "CodexIpcError",
      code: "frame-too-large",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("validates settings before opening a socket", async () => {
    const connectSocket = vi.fn(async () =>
      new FakeIpcSocket(() => undefined)
    );
    const client = new CodexIpcClient({ connectSocket });

    await expect(
      client.updateThreadSettings("thread-17", {} as CodexThreadSettingsUpdate),
    ).rejects.toThrow("minimaal effort of serviceTier");
    expect(connectSocket).not.toHaveBeenCalled();
  });
});
