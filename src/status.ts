export type SessionStatus =
  | "idle"
  | "unread"
  | "thinking"
  | "needs-input"
  | "error";

type JsonObject = Record<string, unknown>;

const ERROR_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Derives the key state for one Codex session from its rollout JSONL.
 *
 * Rollouts are append-only, so ordering is intentionally based on line order.
 * Timestamps are only needed for the time-bounded error and unread states.
 */
export function analyzeRollout(
  text: string,
  seenAtMs: number,
  nowMs: number = Date.now(),
): SessionStatus {
  const callsNeedingInput = new Set<string>();
  const completedCallIds = new Set<string>();

  let eventIndex = 0;
  let lastTaskStarted = -1;
  let lastTaskComplete = -1;
  let lastTurnAborted = -1;
  let lastTurnAbortedAtMs: number | undefined;
  let lastAgentMessageAtMs: number | undefined;

  for (const line of text.split(/\r?\n/u)) {
    const root = parseObject(line);
    if (root === undefined) {
      continue;
    }

    const item = responseItem(root);
    const itemType = stringValue(item?.type);
    const callId = stringValue(item?.call_id);

    if (
      item !== undefined &&
      callId !== undefined &&
      (itemType === "function_call" || itemType === "custom_tool_call") &&
      isInputRequest(item)
    ) {
      callsNeedingInput.add(callId);
    }

    if (
      callId !== undefined &&
      (itemType === "function_call_output" ||
        itemType === "custom_tool_call_output")
    ) {
      completedCallIds.add(callId);
    }

    const event = eventMessage(root);
    if (event === undefined) {
      continue;
    }

    const timestampMs = eventTimestampMs(root, event);
    switch (stringValue(event.type)) {
      case "task_started":
        lastTaskStarted = eventIndex;
        break;
      case "task_complete":
        lastTaskComplete = eventIndex;
        break;
      case "turn_aborted":
        lastTurnAborted = eventIndex;
        lastTurnAbortedAtMs = timestampMs;
        break;
      case "agent_message":
        lastAgentMessageAtMs = timestampMs;
        break;
    }

    eventIndex += 1;
  }

  for (const callId of callsNeedingInput) {
    if (!completedCallIds.has(callId)) {
      return "needs-input";
    }
  }

  if (lastTaskStarted > Math.max(lastTaskComplete, lastTurnAborted)) {
    return "thinking";
  }

  if (
    lastTurnAborted > lastTaskComplete &&
    lastTurnAbortedAtMs !== undefined &&
    nowMs >= lastTurnAbortedAtMs &&
    nowMs - lastTurnAbortedAtMs <= ERROR_WINDOW_MS
  ) {
    return "error";
  }

  if (
    lastAgentMessageAtMs !== undefined &&
    lastAgentMessageAtMs > seenAtMs
  ) {
    return "unread";
  }

  return "idle";
}

function parseObject(line: string): JsonObject | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(line);
    return objectValue(value);
  } catch {
    return undefined;
  }
}

function responseItem(root: JsonObject): JsonObject | undefined {
  if (root.type === "response_item") {
    return objectValue(root.payload);
  }

  const rootType = stringValue(root.type);
  return rootType === "function_call" ||
    rootType === "custom_tool_call" ||
    rootType === "function_call_output" ||
    rootType === "custom_tool_call_output"
    ? root
    : undefined;
}

function eventMessage(root: JsonObject): JsonObject | undefined {
  if (root.type === "event_msg") {
    return objectValue(root.payload);
  }

  const rootType = stringValue(root.type);
  return rootType === "task_started" ||
    rootType === "task_complete" ||
    rootType === "turn_aborted" ||
    rootType === "agent_message"
    ? root
    : undefined;
}

function eventTimestampMs(
  root: JsonObject,
  event: JsonObject,
): number | undefined {
  return parseTimestamp(root.timestamp) ?? parseTimestamp(event.timestamp);
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const timestampMs = Date.parse(value);
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function isInputRequest(item: JsonObject): boolean {
  const name = stringValue(item.name);
  if (name !== undefined && isRequestUserInputName(name)) {
    return true;
  }

  return (
    item.type === "custom_tool_call" &&
    (name === "require_escalated" ||
      hasEscalatedPermission(item.input ?? item.arguments))
  );
}

function isRequestUserInputName(name: string): boolean {
  return (
    name === "request_user_input" ||
    name.endsWith(".request_user_input") ||
    name.endsWith("__request_user_input")
  );
}

function hasEscalatedPermission(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      return hasEscalatedPermission(JSON.parse(value) as unknown);
    } catch {
      return false;
    }
  }

  const object = objectValue(value);
  if (object === undefined) {
    return false;
  }

  return (
    object.sandbox_permissions === "require_escalated" ||
    object.sandboxPermissions === "require_escalated"
  );
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
