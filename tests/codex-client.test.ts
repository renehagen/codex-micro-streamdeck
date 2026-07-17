import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  CodexClient,
  type CodexProcess,
  findCodexExecutable,
} from "../src/codex-client.js";

type JsonObject = Record<string, unknown>;

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: JsonObject[] = [];
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  private inputBuffer = "";

  constructor(
    private readonly handleRequest: (
      message: JsonObject,
      process: FakeCodexProcess,
    ) => void,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.inputBuffer += chunk.toString("utf8");
      const lines = this.inputBuffer.split("\n");
      this.inputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        const message = JSON.parse(line) as JsonObject;
        this.received.push(message);
        this.handleRequest(message, this);
      }
    });
  }

  send(message: JsonObject): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function withInitialization(
  handler: (message: JsonObject, process: FakeCodexProcess) => void = () =>
    undefined,
): FakeCodexProcess {
  return new FakeCodexProcess((message, process) => {
    if (message.method === "initialize") {
      process.send({ id: message.id, result: { userAgent: "test" } });
      return;
    }
    handler(message, process);
  });
}

describe("findCodexExecutable", () => {
  it("prefers CODEX_PATH and then checks the known app and Homebrew paths", () => {
    const visited: string[] = [];
    const executable = findCodexExecutable({
      env: { CODEX_PATH: "/custom/codex" },
      isExecutable: (path) => {
        visited.push(path);
        return path === "/opt/homebrew/bin/codex";
      },
    });

    expect(executable).toBe("/opt/homebrew/bin/codex");
    expect(visited).toEqual([
      "/custom/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
    ]);
  });

  it("reports every attempted location when Codex is missing", () => {
    expect(() => findCodexExecutable({
      env: {},
      isExecutable: () => false,
    })).toThrow("/Applications/Codex.app/Contents/Resources/codex");
  });
});

describe("CodexClient", () => {
  it("spawns app-server, performs the experimental handshake and lists recent threads", async () => {
    const process = withInitialization((message, child) => {
      if (message.method !== "thread/list") return;
      child.send({
        id: message.id,
        result: {
          data: [
            {
              id: "019f6ee1-b6e0-7312-9547-230f6747d083",
              name: "Stream Deck bouwen",
              preview: "Prima, bouw dit",
              path: "/tmp/rollout.jsonl",
              updatedAt: 1_752_751_200,
              recencyAt: 1_752_751_250,
              status: { type: "active", activeFlags: ["waitingOnApproval"] },
            },
            {
              id: "019f6ee1-b6e0-7312-9547-230f6747d084",
              name: null,
              preview: "Tweede taak",
              path: null,
              updatedAt: 1_752_751_100,
              recencyAt: null,
              status: { type: "idle" },
            },
          ],
          nextCursor: null,
        },
      });
    });
    const spawnProcess = vi.fn(() => process);
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess,
    });

    const threads = await client.listRecentThreads(2);

    expect(spawnProcess).toHaveBeenCalledWith("/fake/codex", [
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(process.received[0]).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "codex_micro_streamdeck" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(process.received[1]).toEqual({
      method: "initialized",
      params: {},
    });
    expect(process.received[2]).toMatchObject({
      method: "thread/list",
      params: {
        limit: 2,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: true,
      },
    });
    expect(threads).toEqual([
      {
        id: "019f6ee1-b6e0-7312-9547-230f6747d083",
        name: "Stream Deck bouwen",
        preview: "Prima, bouw dit",
        path: "/tmp/rollout.jsonl",
        updatedAt: 1_752_751_200,
        recencyAt: 1_752_751_250,
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
      {
        id: "019f6ee1-b6e0-7312-9547-230f6747d084",
        name: null,
        preview: "Tweede taak",
        path: null,
        updatedAt: 1_752_751_100,
        recencyAt: null,
        status: { type: "idle" },
      },
    ]);

    await client.stop();
  });

  it("reassembles JSONL chunks and rejects JSON-RPC errors", async () => {
    const process = withInitialization((message, child) => {
      if (message.method !== "broken") return;
      const response = JSON.stringify({
        id: message.id,
        error: { code: 42, message: "kapot", data: { retry: false } },
      });
      child.stdout.write(response.slice(0, 12));
      child.stdout.write(`${response.slice(12)}\n`);
    });
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess: () => process,
    });

    await expect(client.request("broken", {})).rejects.toMatchObject({
      name: "CodexRpcError",
      code: 42,
      message: "kapot",
      data: { retry: false },
    });

    await client.stop();
  });

  it("answers unsupported server requests with JSON-RPC method-not-found", async () => {
    const process = withInitialization();
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess: () => process,
    });
    await client.start();

    process.send({
      id: "approval-17",
      method: "item/commandExecution/requestApproval",
      params: { command: "false" },
    });

    await vi.waitFor(() => {
      expect(process.received).toContainEqual({
        id: "approval-17",
        error: { code: -32601, message: "Method not found" },
      });
    });

    await client.stop();
  });

  it("forwards complete stderr lines and notifications without crashing on callback errors", async () => {
    const stderr = vi.fn();
    const notification = vi.fn(() => {
      throw new Error("consumer error");
    });
    const process = withInitialization();
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess: () => process,
      onStderr: stderr,
      onNotification: notification,
    });
    await client.start();

    process.stderr.write("eerste regel\ntweede");
    process.stderr.write(" regel\n");
    process.send({ method: "thread/status/changed", params: { threadId: "1" } });

    await vi.waitFor(() => {
      expect(stderr).toHaveBeenCalledWith("eerste regel");
      expect(stderr).toHaveBeenCalledWith("tweede regel");
      expect(stderr).toHaveBeenCalledWith(
        "[callback] Notification-handler faalde: consumer error",
      );
    });
    expect(notification).toHaveBeenCalledWith({
      method: "thread/status/changed",
      params: { threadId: "1" },
    });

    await client.stop();
  });

  it("times out unanswered requests and can restart after stop", async () => {
    const processes: FakeCodexProcess[] = [];
    const spawnProcess = vi.fn(() => {
      const process = withInitialization();
      processes.push(process);
      return process;
    });
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess,
      requestTimeoutMs: 20,
    });

    await expect(client.request("never/replies", {})).rejects.toThrow(
      "Timeout na 20 ms",
    );
    await client.stop();
    await client.start();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(processes[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(client.isRunning).toBe(true);

    await client.stop();
  });

  it("rejects pending work when the child exits and automatically starts a new child next time", async () => {
    const processes: FakeCodexProcess[] = [];
    const client = new CodexClient({
      executable: "/fake/codex",
      spawnProcess: () => {
        const process = withInitialization();
        processes.push(process);
        return process;
      },
      requestTimeoutMs: 1_000,
    });

    const pending = client.request("long/request", {});
    await vi.waitFor(() => {
      expect(processes[0]?.received).toContainEqual(expect.objectContaining({
        method: "long/request",
      }));
    });
    processes[0]?.emit("exit", 7, null);
    await expect(pending).rejects.toThrow("code 7");

    await client.start();
    expect(processes).toHaveLength(2);
    expect(client.isRunning).toBe(true);

    await client.stop();
  });
});
