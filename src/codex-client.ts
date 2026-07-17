import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { accessSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

export interface CodexProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(
    event: string,
    listener: (...arguments_: unknown[]) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnCodexProcess = (
  executable: string,
  arguments_: readonly string[],
) => CodexProcess;

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexThreadStatus {
  type: string;
  [key: string]: unknown;
}

export interface CodexThreadSummary {
  id: string;
  name: string | null;
  preview: string;
  path: string | null;
  updatedAt: number;
  recencyAt: number | null;
  status: CodexThreadStatus;
}

export interface FindCodexExecutableOptions {
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
}

export interface CodexClientOptions extends FindCodexExecutableOptions {
  /** Explicit override, primarily useful for embedding and tests. */
  executable?: string;
  spawnProcess?: SpawnCodexProcess;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
  onNotification?: (notification: CodexNotification) => void;
}

interface PendingRequest {
  generation: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export const CODEX_EXECUTABLE_LOCATIONS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
] as const;

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds Codex without depending on the deliberately sparse Stream Deck PATH. */
export function findCodexExecutable(
  options: FindCodexExecutableOptions = {},
): string {
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const configured = env.CODEX_PATH?.trim();
  const candidates = configured === undefined || configured.length === 0
    ? [...CODEX_EXECUTABLE_LOCATIONS]
    : [configured, ...CODEX_EXECUTABLE_LOCATIONS];

  for (const candidate of new Set(candidates)) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Codex executable niet gevonden. Stel CODEX_PATH in of installeer Codex op een van deze locaties: ${candidates.join(", ")}`,
  );
}

function defaultSpawnProcess(
  executable: string,
  arguments_: readonly string[],
): CodexProcess {
  return spawn(executable, [...arguments_], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as CodexProcess;
}

export class CodexRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Small JSONL client for `codex app-server --listen stdio://`.
 *
 * One client owns one child process. A stopped or crashed client can safely be
 * started again; late output from an older child is ignored by generation.
 */
export class CodexClient {
  private readonly executable: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly isExecutable: ((path: string) => boolean) | undefined;
  private readonly spawnProcess: SpawnCodexProcess;
  private readonly requestTimeoutMs: number;
  private readonly onStderr: ((line: string) => void) | undefined;
  private readonly onNotification:
    | ((notification: CodexNotification) => void)
    | undefined;

  private process: CodexProcess | undefined;
  private generation = 0;
  private nextRequestId = 1;
  private startPromise: Promise<void> | undefined;
  private running = false;
  private readonly pending = new Map<RequestId, PendingRequest>();

  constructor(options: CodexClientOptions = {}) {
    this.executable = options.executable;
    this.env = options.env;
    this.isExecutable = options.isExecutable;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onStderr = options.onStderr;
    this.onNotification = options.onNotification;

    if (
      !Number.isFinite(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new RangeError("requestTimeoutMs moet groter dan nul zijn");
    }
  }

  get isRunning(): boolean {
    return this.running && this.process !== undefined;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    const generation = this.generation + 1;
    this.generation = generation;
    const startup = this.startGeneration(generation);
    this.startPromise = startup;

    try {
      await startup;
    } finally {
      if (this.startPromise === startup) {
        this.startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    const startup = this.startPromise;
    const child = this.process;
    const generation = this.generation;

    this.process = undefined;
    this.running = false;
    this.generation += 1;
    this.rejectPendingGeneration(
      generation,
      new Error("Codex app-server is gestopt"),
    );

    if (child !== undefined) {
      try {
        child.stdin.end();
      } catch {
        // The process may already have closed its stdin.
      }

      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
    }

    if (startup !== undefined) {
      await startup.catch(() => undefined);
    }
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (method.length === 0) {
      throw new TypeError("JSON-RPC method mag niet leeg zijn");
    }

    await this.start();
    const child = this.process;
    if (!this.running || child === undefined) {
      throw new Error("Codex app-server is niet actief");
    }

    return this.sendRequest<Result>(
      child,
      this.generation,
      method,
      params,
    );
  }

  async listRecentThreads(limit = 5): Promise<CodexThreadSummary[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("Threadlimiet moet een positief geheel getal zijn");
    }

    const response = await this.request<unknown>("thread/list", {
      limit,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    });
    const root = objectValue(response);
    if (root === undefined || !Array.isArray(root.data)) {
      throw new CodexRpcError("Ongeldig thread/list-antwoord van Codex");
    }

    return root.data.map((value, index) => parseThread(value, index));
  }

  private async startGeneration(generation: number): Promise<void> {
    const executable = this.executable ?? findCodexExecutable({
      ...(this.env === undefined ? {} : { env: this.env }),
      ...(this.isExecutable === undefined
        ? {}
        : { isExecutable: this.isExecutable }),
    });
    const child = this.spawnProcess(executable, [
      "app-server",
      "--listen",
      "stdio://",
    ]);

    if (
      child.stdin === undefined ||
      child.stdout === undefined ||
      child.stderr === undefined
    ) {
      throw new Error("Codex app-server heeft geen bruikbare stdio-streams");
    }

    this.process = child;
    this.attachProcess(child, generation);

    try {
      await this.sendRequest(child, generation, "initialize", {
        clientInfo: {
          name: "codex_micro_streamdeck",
          title: "Codex Micro Stream Deck",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });

      if (this.process !== child || this.generation !== generation) {
        throw new Error("Codex app-server werd tijdens initialisatie gestopt");
      }

      this.writeMessage(child, {
        method: "initialized",
        params: {},
      });
      this.running = true;
    } catch (error) {
      const reason = asError(error, "Codex app-server kon niet starten");
      if (this.process === child && this.generation === generation) {
        this.process = undefined;
        this.running = false;
        this.rejectPendingGeneration(generation, reason);
        try {
          child.kill("SIGTERM");
        } catch {
          // Best effort; the failure may already indicate process exit.
        }
      }
      throw reason;
    }
  }

  private attachProcess(child: CodexProcess, generation: number): void {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout.on("data", (chunk: unknown) => {
      if (!this.isCurrent(child, generation)) {
        return;
      }
      stdoutBuffer += decodeChunk(stdoutDecoder, chunk);
      const split = splitCompleteLines(stdoutBuffer);
      stdoutBuffer = split.remainder;
      for (const line of split.lines) {
        this.handleJsonLine(child, generation, line);
      }
    });

    child.stderr.on("data", (chunk: unknown) => {
      if (!this.isCurrent(child, generation)) {
        return;
      }
      stderrBuffer += decodeChunk(stderrDecoder, chunk);
      const split = splitCompleteLines(stderrBuffer);
      stderrBuffer = split.remainder;
      for (const line of split.lines) {
        this.reportStderr(line);
      }
    });

    child.stdout.on("end", () => {
      if (!this.isCurrent(child, generation)) {
        return;
      }
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer.trim().length > 0) {
        this.handleJsonLine(
          child,
          generation,
          stripTrailingCarriageReturn(stdoutBuffer),
        );
        stdoutBuffer = "";
      }
    });

    child.stderr.on("end", () => {
      if (!this.isCurrent(child, generation)) {
        return;
      }
      stderrBuffer += stderrDecoder.end();
      if (stderrBuffer.length > 0) {
        this.reportStderr(stripTrailingCarriageReturn(stderrBuffer));
        stderrBuffer = "";
      }
    });

    child.stdin.on("error", (error: unknown) => {
      this.handleProcessEnd(
        child,
        generation,
        asError(error, "Codex stdin is gesloten"),
      );
    });
    child.stdout.on("error", (error: unknown) => {
      this.handleProcessEnd(
        child,
        generation,
        asError(error, "Codex stdout is gesloten"),
      );
    });
    child.stderr.on("error", (error: unknown) => {
      this.handleProcessEnd(
        child,
        generation,
        asError(error, "Codex stderr is gesloten"),
      );
    });

    child.once("error", (error: unknown) => {
      this.handleProcessEnd(
        child,
        generation,
        asError(error, "Codex app-server kon niet worden gestart"),
      );
    });
    child.once("exit", (code: unknown, signal: unknown) => {
      const description = typeof code === "number"
        ? `code ${code}`
        : `signaal ${String(signal ?? "onbekend")}`;
      this.handleProcessEnd(
        child,
        generation,
        new Error(`Codex app-server stopte met ${description}`),
      );
    });
  }

  private handleJsonLine(
    child: CodexProcess,
    generation: number,
    line: string,
  ): void {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.reportStderr(`[protocol] Ongeldige JSON van Codex: ${line}`);
      return;
    }

    const message = objectValue(parsed);
    if (message === undefined) {
      this.reportStderr("[protocol] Niet-object JSON-bericht van Codex genegeerd");
      return;
    }

    const method = stringValue(message.method);
    const hasId = Object.hasOwn(message, "id");
    if (method !== undefined && hasId) {
      const id = requestIdValue(message.id);
      if (id !== undefined) {
        this.writeMessage(child, {
          id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        });
      }
      return;
    }

    if (hasId) {
      const id = requestIdValue(message.id);
      if (id === undefined) {
        return;
      }
      const pending = this.pending.get(id);
      if (pending === undefined || pending.generation !== generation) {
        return;
      }

      this.pending.delete(id);
      clearTimeout(pending.timer);
      const rpcError = objectValue(message.error);
      if (rpcError !== undefined) {
        pending.reject(new CodexRpcError(
          stringValue(rpcError.message) ?? "Codex JSON-RPC-fout",
          numberValue(rpcError.code),
          rpcError.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (method !== undefined) {
      try {
        this.onNotification?.({ method, params: message.params });
      } catch (error) {
        this.reportStderr(
          `[callback] Notification-handler faalde: ${asError(error, "onbekende fout").message}`,
        );
      }
    }
  }

  private sendRequest<Result>(
    child: CodexProcess,
    generation: number,
    method: string,
    params?: unknown,
  ): Promise<Result> {
    if (!this.isCurrent(child, generation)) {
      return Promise.reject(new Error("Codex app-server is niet actief"));
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined || pending.generation !== generation) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(
          `Timeout na ${this.requestTimeoutMs} ms voor Codex-methode ${method}`,
        ));
      }, this.requestTimeoutMs);
      timer.unref();

      this.pending.set(id, {
        generation,
        timer,
        resolve: (value) => resolve(value as Result),
        reject,
      });

      const message: JsonObject = { id, method };
      if (params !== undefined) {
        message.params = params;
      }

      try {
        this.writeMessage(child, message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error, `Codex-methode ${method} kon niet worden verstuurd`));
      }
    });
  }

  private writeMessage(child: CodexProcess, message: JsonObject): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleProcessEnd(
    child: CodexProcess,
    generation: number,
    reason: Error,
  ): void {
    if (!this.isCurrent(child, generation)) {
      return;
    }

    this.process = undefined;
    this.running = false;
    this.rejectPendingGeneration(generation, reason);
  }

  private rejectPendingGeneration(generation: number, reason: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
  }

  private isCurrent(child: CodexProcess, generation: number): boolean {
    return this.process === child && this.generation === generation;
  }

  private reportStderr(line: string): void {
    if (line.length === 0) {
      return;
    }
    try {
      this.onStderr?.(line);
    } catch {
      // Logging must never take down the transport.
    }
  }
}

function parseThread(value: unknown, index: number): CodexThreadSummary {
  const thread = objectValue(value);
  const label = `thread/list data[${index}]`;
  if (thread === undefined) {
    throw new CodexRpcError(`${label} is geen object`);
  }

  const status = objectValue(thread.status);
  if (status === undefined || stringValue(status.type) === undefined) {
    throw new CodexRpcError(`${label}.status is ongeldig`);
  }

  return {
    id: requiredString(thread.id, `${label}.id`),
    name: nullableString(thread.name, `${label}.name`),
    preview: requiredString(thread.preview, `${label}.preview`),
    path: nullableString(thread.path, `${label}.path`),
    updatedAt: requiredNumber(thread.updatedAt, `${label}.updatedAt`),
    recencyAt: nullableNumber(thread.recencyAt, `${label}.recencyAt`),
    status: status as CodexThreadStatus,
  };
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function requestIdValue(value: unknown): RequestId | undefined {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new CodexRpcError(`${name} ontbreekt of is ongeldig`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CodexRpcError(`${name} ontbreekt of is ongeldig`);
  }
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  const number = numberValue(value);
  if (number === undefined) {
    throw new CodexRpcError(`${name} ontbreekt of is ongeldig`);
  }
  return number;
}

function nullableNumber(value: unknown, name: string): number | null {
  if (value === null) {
    return null;
  }
  return requiredNumber(value, name);
}

function decodeChunk(decoder: StringDecoder, chunk: unknown): string {
  return typeof chunk === "string"
    ? chunk
    : decoder.write(Buffer.from(chunk as Uint8Array));
}

function splitCompleteLines(text: string): {
  lines: string[];
  remainder: string;
} {
  const pieces = text.split("\n");
  const remainder = pieces.pop() ?? "";
  return {
    lines: pieces.map(stripTrailingCarriageReturn),
    remainder,
  };
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export { CodexClient as CodexAppServerClient };
