import { describe, expect, it, vi } from "vitest";

import {
  SAFE_MODEL_CATALOG,
  loadModelCatalog,
  modelControlsFor,
  nextReasoningEffort,
  parseLatestThreadSettings,
  parseLiveThreadControls,
  parseModelCatalog,
  resolveModelsCachePath,
  toggleFastServiceTier,
  type ModelControls,
} from "../src/thread-controls.js";

function settingsEvent(
  timestamp: string,
  settings: Record<string, unknown>,
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: settings },
  });
}

const TEST_MODEL: ModelControls = {
  slug: "test-model",
  defaultReasoningLevel: "medium",
  effortOrder: ["minimal", "medium", "ultra"],
  serviceTiers: ["priority", "flex"],
};

describe("parseLatestThreadSettings", () => {
  it("returns the last valid applied settings event in rollout order", () => {
    const rollout = [
      settingsEvent("2026-07-17T10:00:00Z", {
        model: "old-model",
        reasoning_effort: "low",
        service_tier: "default",
      }),
      "not json",
      JSON.stringify({
        timestamp: "2026-07-17T10:01:00Z",
        type: "event_msg",
        payload: { type: "task_started" },
      }),
      settingsEvent("2026-07-17T10:02:00Z", {
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra",
        service_tier: "priority",
      }),
    ].join("\n");

    expect(parseLatestThreadSettings(rollout)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: "priority",
      timestamp: "2026-07-17T10:02:00Z",
    });
  });

  it("maps a missing service tier to null and skips incomplete events", () => {
    const valid = settingsEvent("2026-07-17T10:00:00Z", {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    });
    const incomplete = settingsEvent("2026-07-17T10:01:00Z", {
      model: "gpt-5.6-sol",
      service_tier: "priority",
    });

    expect(parseLatestThreadSettings(`${valid}\n${incomplete}`)).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: null,
      timestamp: "2026-07-17T10:00:00Z",
    });
    expect(parseLatestThreadSettings("\ncorrupt\n{}")).toBeNull();
  });
});

describe("parseLiveThreadControls", () => {
  it("prefers live thread settings and normalizes Standard Fast", () => {
    expect(parseLiveThreadControls({
      latestModel: "old-model",
      latestReasoningEffort: "low",
      latestCollaborationMode: { settings: { model: "collab-model", reasoning_effort: "medium" } },
      latestThreadSettings: { model: "gpt-5.6-sol", effort: "ultra", serviceTier: "default" }
    })).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: null
    });
  });

  it("falls back to collaboration and latest values without inventing a Fast state", () => {
    expect(parseLiveThreadControls({
      latestModel: "gpt-5.6-sol",
      latestReasoningEffort: "high",
      latestCollaborationMode: { settings: { model: "gpt-5.6-terra", reasoning_effort: "xhigh" } }
    })).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh"
    });
  });

  it("preserves an explicitly active Fast tier", () => {
    expect(parseLiveThreadControls({
      latestThreadSettings: { model: "gpt-5.6-sol", effort: "high", serviceTier: "priority" }
    }).serviceTier).toBe("priority");
  });
});

describe("model catalog", () => {
  const cache = JSON.stringify({
    models: [
      {
        slug: "gpt-test",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "minimal" },
          { effort: "medium" },
          { effort: "max" },
          { effort: "ultra" },
        ],
        service_tiers: [{ id: "priority" }, { id: "flex" }],
      },
    ],
  });

  it("preserves visible widget order while omitting the backend-only max step", () => {
    expect(parseModelCatalog(cache)).toEqual([
      {
        slug: "gpt-test",
        defaultReasoningLevel: "medium",
        effortOrder: ["minimal", "medium", "ultra"],
        serviceTiers: ["priority", "flex"],
      },
    ]);
  });

  it("uses a safe fallback for malformed and unreadable caches", async () => {
    expect(parseModelCatalog("broken")).toBe(SAFE_MODEL_CATALOG);

    const readTextFile = vi.fn(async (_path: string) => {
      throw new Error("missing");
    });
    await expect(loadModelCatalog({
      codexHome: "/test/.codex",
      readTextFile,
    })).resolves.toBe(SAFE_MODEL_CATALOG);
    expect(readTextFile).toHaveBeenCalledWith(
      "/test/.codex/models_cache.json",
    );
  });

  it("supports injected file reads and CODEX_HOME path resolution", async () => {
    const readTextFile = vi.fn(async () => cache);
    const catalog = await loadModelCatalog({
      env: { CODEX_HOME: "/custom/codex" },
      readTextFile,
    });

    expect(resolveModelsCachePath({
      env: { CODEX_HOME: "/custom/codex" },
    })).toBe("/custom/codex/models_cache.json");
    expect(readTextFile).toHaveBeenCalledWith(
      "/custom/codex/models_cache.json",
    );
    expect(modelControlsFor(catalog, "gpt-test").slug).toBe("gpt-test");
    expect(modelControlsFor(catalog, "unknown").slug).toBe("*");
  });
});

describe("thread control calculations", () => {
  it("follows catalog effort order and clamps both endpoints", () => {
    expect(nextReasoningEffort("minimal", "down", TEST_MODEL)).toBe(
      "minimal",
    );
    expect(nextReasoningEffort("minimal", "up", TEST_MODEL)).toBe("medium");
    expect(nextReasoningEffort("medium", "up", TEST_MODEL)).toBe("ultra");
    expect(nextReasoningEffort("ultra", "up", TEST_MODEL)).toBe("ultra");
    expect(nextReasoningEffort("ultra", "down", TEST_MODEL)).toBe("medium");
  });

  it("uses the model default as the base for an unknown current effort", () => {
    expect(nextReasoningEffort("unknown", "up", TEST_MODEL)).toBe("ultra");
    expect(nextReasoningEffort(null, "down", TEST_MODEL)).toBe("minimal");
  });

  it("leaves a previously selected hidden max through the correct visible neighbor", () => {
    const widgetModel: ModelControls = {
      ...TEST_MODEL,
      effortOrder: ["low", "medium", "high", "xhigh", "ultra"],
    };
    expect(nextReasoningEffort("max", "up", widgetModel)).toBe("ultra");
    expect(nextReasoningEffort("max", "down", widgetModel)).toBe("xhigh");
  });

  it("toggles the first advertised Fast tier", () => {
    expect(toggleFastServiceTier(null, TEST_MODEL)).toBe("priority");
    expect(toggleFastServiceTier("default", TEST_MODEL)).toBe("priority");
    expect(toggleFastServiceTier("priority", TEST_MODEL)).toBeNull();
  });

  it("returns null when a model advertises no service tier", () => {
    expect(toggleFastServiceTier("priority", {
      ...TEST_MODEL,
      serviceTiers: [],
    })).toBeNull();
  });
});
