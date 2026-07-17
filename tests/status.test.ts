import { describe, expect, it } from "vitest";

import { analyzeRollout } from "../src/status.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function event(timestamp: string, type: string): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type } });
}

function item(timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type: "response_item", payload });
}

describe("analyzeRollout", () => {
  it("ignores blank and corrupt JSONL lines", () => {
    expect(analyzeRollout("\nnot json\n[]\n{}", 0, NOW)).toBe("idle");
  });

  it("reports unresolved user input before every other status", () => {
    const rollout = [
      item("2026-07-17T11:59:00Z", {
        type: "function_call",
        name: "request_user_input",
        call_id: "question-1",
      }),
      event("2026-07-17T11:59:20Z", "task_started"),
      event("2026-07-17T11:59:40Z", "turn_aborted"),
      event("2026-07-17T11:59:50Z", "agent_message"),
    ].join("\n");

    expect(analyzeRollout(rollout, 0, NOW)).toBe("needs-input");
  });

  it("matches request and escalation outputs by call_id", () => {
    const calls = [
      item("2026-07-17T11:55:00Z", {
        type: "function_call",
        name: "request_user_input",
        call_id: "question-1",
      }),
      item("2026-07-17T11:55:01Z", {
        type: "function_call_output",
        call_id: "question-1",
        output: "answered",
      }),
      item("2026-07-17T11:56:00Z", {
        type: "custom_tool_call",
        name: "exec_command",
        call_id: "approval-1",
        input: JSON.stringify({ sandbox_permissions: "require_escalated" }),
      }),
      item("2026-07-17T11:56:01Z", {
        type: "custom_tool_call_output",
        call_id: "someone-else",
        output: "approved",
      }),
    ];

    expect(analyzeRollout(calls.join("\n"), NOW, NOW)).toBe(
      "needs-input",
    );

    calls.push(
      item("2026-07-17T11:56:02Z", {
        type: "custom_tool_call_output",
        call_id: "approval-1",
        output: "approved",
      }),
    );
    expect(analyzeRollout(calls.join("\n"), NOW, NOW)).toBe("idle");
  });

  it("reports thinking when task_started is newer than terminal events", () => {
    const rollout = [
      event("2026-07-17T11:50:00Z", "turn_aborted"),
      event("2026-07-17T11:55:00Z", "task_complete"),
      event("2026-07-17T11:59:00Z", "agent_message"),
      event("2026-07-17T11:59:01Z", "task_started"),
    ].join("\n");

    expect(analyzeRollout(rollout, 0, NOW)).toBe("thinking");
  });

  it("reports a recent abort as error, but expires it after five minutes", () => {
    const rollout = [
      event("2026-07-17T11:50:00Z", "task_complete"),
      event("2026-07-17T11:56:00Z", "turn_aborted"),
    ].join("\n");

    expect(analyzeRollout(rollout, NOW, NOW)).toBe("error");
    expect(analyzeRollout(rollout, NOW, NOW + 61_000)).toBe("idle");
  });

  it("uses agent_message timestamps for unread state", () => {
    const rollout = event("2026-07-17T11:59:00Z", "agent_message");

    expect(analyzeRollout(rollout, NOW - 120_000, NOW)).toBe("unread");
    expect(analyzeRollout(rollout, NOW, NOW)).toBe("idle");
  });
});
