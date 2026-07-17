import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 1_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

export interface StoredThreadControls {
  model?: string;
  reasoningEffort?: string;
  updatedAt?: number;
}

export interface ThreadStateReader {
  readThreadControls(threadId: string): Promise<StoredThreadControls>;
}

type SqliteRunner = (executable: string, args: readonly string[]) => Promise<string>;

export interface CodexStateReaderOptions {
  databasePath?: string;
  sqliteExecutable?: string;
  runSqlite?: SqliteRunner;
}

export class CodexStateReader implements ThreadStateReader {
  private readonly databasePath: string;
  private readonly sqliteExecutable: string;
  private readonly runSqlite: SqliteRunner;

  constructor(options: CodexStateReaderOptions = {}) {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    this.databasePath = options.databasePath ?? join(codexHome, "state_5.sqlite");
    this.sqliteExecutable = options.sqliteExecutable ?? "/usr/bin/sqlite3";
    this.runSqlite = options.runSqlite ?? runSqlite;
  }

  async readThreadControls(threadId: string): Promise<StoredThreadControls> {
    if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Ongeldig Codex thread-id");
    const query = [
      "SELECT model, reasoning_effort, updated_at_ms",
      "FROM threads",
      `WHERE id = '${threadId}'`,
      "LIMIT 1;"
    ].join(" ");
    const output = await this.runSqlite(this.sqliteExecutable, [
      "-readonly",
      "-json",
      this.databasePath,
      query
    ]);
    const rows: unknown = JSON.parse(output.trim() || "[]");
    if (!Array.isArray(rows) || rows.length === 0) return {};
    const row = rows[0];
    if (typeof row !== "object" || row === null) return {};

    const model = "model" in row && typeof row.model === "string" ? row.model : undefined;
    const reasoningEffort = "reasoning_effort" in row && typeof row.reasoning_effort === "string"
      ? row.reasoning_effort
      : undefined;
    const updatedAt = "updated_at_ms" in row && typeof row.updated_at_ms === "number"
      ? row.updated_at_ms
      : undefined;
    return {
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(updatedAt === undefined ? {} : { updatedAt })
    };
  }
}

function runSqlite(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: READ_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim();
      reject(new Error(detail ? `Codex-status lezen faalde: ${detail}` : "Codex-status lezen faalde", { cause: error }));
    });
  });
}
