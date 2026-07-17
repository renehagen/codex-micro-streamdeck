import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface ThreadControlState {
  model: string;
  reasoningEffort: string;
  serviceTier: string | null;
  timestamp: string;
}

export interface LiveThreadControlState {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string | null;
}

export interface ModelControls {
  slug: string;
  defaultReasoningLevel: string;
  /** Ordered exactly as advertised by the model catalog. */
  effortOrder: readonly string[];
  /** Ordered exactly as advertised by the model catalog. */
  serviceTiers: readonly string[];
}

export type ModelCatalog = readonly ModelControls[];
export type EffortDirection = "up" | "down";
export type ReadTextFile = (path: string) => Promise<string>;

export interface LoadModelCatalogOptions {
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  readTextFile?: ReadTextFile;
  fallback?: ModelCatalog;
}

const FALLBACK_EFFORT_ORDER = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const;

// The backend advertises `max`, but the current ChatGPT composer deliberately
// omits it from its effort picker. Stream Deck mirrors the visible widget.
const WIDGET_HIDDEN_EFFORTS = new Set(["max"]);

/**
 * Conservative metadata used when the on-disk cache is absent or malformed.
 * The wildcard slug is only a marker; `modelControlsFor` still returns it for
 * any unknown model.
 */
export const SAFE_MODEL_CONTROLS: ModelControls = Object.freeze({
  slug: "*",
  defaultReasoningLevel: "medium",
  effortOrder: Object.freeze([...FALLBACK_EFFORT_ORDER]),
  serviceTiers: Object.freeze(["priority"]),
});

export const SAFE_MODEL_CATALOG: ModelCatalog = Object.freeze([
  SAFE_MODEL_CONTROLS,
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function orderedUniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

/** Returns the last valid `thread_settings_applied` event in rollout order. */
export function parseLatestThreadSettings(
  rolloutJsonl: string,
): ThreadControlState | null {
  let end = rolloutJsonl.length;
  while (end > 0) {
    if (rolloutJsonl.charCodeAt(end - 1) === 10) end -= 1;
    if (end <= 0) break;
    const separator = rolloutJsonl.lastIndexOf("\n", end - 1);
    const line = rolloutJsonl.slice(separator + 1, end);
    end = separator;
    if (line.trim().length === 0) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (!isObject(entry) || entry.type !== "event_msg") continue;
    const payload = entry.payload;
    if (
      !isObject(payload) ||
      payload.type !== "thread_settings_applied" ||
      !isObject(payload.thread_settings)
    ) {
      continue;
    }

    const timestamp = nonEmptyString(entry.timestamp);
    const model = nonEmptyString(payload.thread_settings.model);
    const reasoningEffort = nonEmptyString(
      payload.thread_settings.reasoning_effort,
    );
    if (timestamp === null || model === null || reasoningEffort === null) {
      continue;
    }

    return {
      model,
      reasoningEffort,
      serviceTier: nonEmptyString(payload.thread_settings.service_tier),
      timestamp,
    };
  }

  return null;
}

/** Extracts the current model, effort and Fast tier from a live IPC snapshot. */
export function parseLiveThreadControls(
  conversationState: Record<string, unknown>,
): LiveThreadControlState {
  const threadSettings = isObject(conversationState.latestThreadSettings)
    ? conversationState.latestThreadSettings
    : null;
  const collaboration = isObject(conversationState.latestCollaborationMode)
    ? conversationState.latestCollaborationMode
    : null;
  const collaborationSettings = collaboration && isObject(collaboration.settings)
    ? collaboration.settings
    : null;

  const model = nonEmptyString(threadSettings?.model)
    ?? nonEmptyString(collaborationSettings?.model)
    ?? nonEmptyString(conversationState.latestModel);
  const reasoningEffort = nonEmptyString(threadSettings?.effort)
    ?? nonEmptyString(collaborationSettings?.reasoning_effort)
    ?? nonEmptyString(conversationState.latestReasoningEffort);

  let serviceTier: string | null | undefined;
  if (threadSettings && Object.hasOwn(threadSettings, "serviceTier")) {
    const advertised = nonEmptyString(threadSettings.serviceTier);
    serviceTier = advertised === "default" ? null : advertised;
  }

  return {
    ...(model === null ? {} : { model }),
    ...(reasoningEffort === null ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function parseModel(value: unknown): ModelControls | null {
  if (!isObject(value)) return null;
  const slug = nonEmptyString(value.slug);
  if (slug === null) return null;

  const rawEfforts = Array.isArray(value.supported_reasoning_levels)
    ? value.supported_reasoning_levels.map((level) =>
      isObject(level) ? level.effort : null
    )
    : [];
  const effortOrder = orderedUniqueStrings(rawEfforts)
    .filter((effort) => !WIDGET_HIDDEN_EFFORTS.has(effort));
  const advertisedDefault = nonEmptyString(value.default_reasoning_level);

  if (effortOrder.length === 0 && advertisedDefault !== null) {
    effortOrder.push(advertisedDefault);
  }
  if (effortOrder.length === 0) return null;

  const defaultReasoningLevel =
    advertisedDefault !== null && effortOrder.includes(advertisedDefault)
      ? advertisedDefault
      : effortOrder[0]!;

  const rawServiceTiers = Array.isArray(value.service_tiers)
    ? value.service_tiers.map((tier) => isObject(tier) ? tier.id : null)
    : [];

  return {
    slug,
    defaultReasoningLevel,
    effortOrder,
    serviceTiers: orderedUniqueStrings(rawServiceTiers),
  };
}

/**
 * Parses the snake_case Codex model cache. Malformed or empty input resolves
 * to the supplied fallback so callers never need to trust cache contents.
 */
export function parseModelCatalog(
  modelsCacheJson: string,
  fallback: ModelCatalog = SAFE_MODEL_CATALOG,
): ModelCatalog {
  let root: unknown;
  try {
    root = JSON.parse(modelsCacheJson) as unknown;
  } catch {
    return fallback;
  }

  if (!isObject(root) || !Array.isArray(root.models)) return fallback;

  const models = root.models
    .map(parseModel)
    .filter((model): model is ModelControls => model !== null);
  return models.length === 0 ? fallback : models;
}

export function resolveModelsCachePath(
  options: Pick<LoadModelCatalogOptions, "codexHome" | "env"> = {},
): string {
  const env = options.env ?? process.env;
  const configuredHome = options.codexHome ?? env.CODEX_HOME?.trim();
  const codexHome = configuredHome === undefined || configuredHome.length === 0
    ? join(env.HOME?.trim() || homedir(), ".codex")
    : configuredHome;
  return join(codexHome, "models_cache.json");
}

/** Reads `~/.codex/models_cache.json`; I/O and parsing failures are harmless. */
export async function loadModelCatalog(
  options: LoadModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const fallback = options.fallback ?? SAFE_MODEL_CATALOG;
  const readTextFile = options.readTextFile ?? ((path: string) =>
    readFile(path, "utf8"));

  try {
    const json = await readTextFile(resolveModelsCachePath(options));
    return parseModelCatalog(json, fallback);
  } catch {
    return fallback;
  }
}

export function modelControlsFor(
  catalog: ModelCatalog,
  slug: string,
  fallback: ModelControls = SAFE_MODEL_CONTROLS,
): ModelControls {
  return catalog.find((model) => model.slug === slug) ?? fallback;
}

/** Computes one catalog-ordered effort step and clamps at both endpoints. */
export function nextReasoningEffort(
  currentEffort: string | null | undefined,
  direction: EffortDirection,
  model: ModelControls,
): string {
  const effortOrder = orderedUniqueStrings(model.effortOrder);
  if (effortOrder.length === 0) {
    return nonEmptyString(currentEffort) ??
      nonEmptyString(model.defaultReasoningLevel) ??
      SAFE_MODEL_CONTROLS.defaultReasoningLevel;
  }

  const currentIndex = currentEffort === null || currentEffort === undefined
    ? -1
    : effortOrder.indexOf(currentEffort);
  if (currentIndex < 0 && currentEffort === "max") {
    const neighbor = direction === "up" ? "ultra" : "xhigh";
    if (effortOrder.includes(neighbor)) return neighbor;
  }
  const defaultIndex = effortOrder.indexOf(model.defaultReasoningLevel);
  const baseIndex = currentIndex >= 0
    ? currentIndex
    : Math.max(0, defaultIndex);
  const delta = direction === "up" ? 1 : -1;
  const nextIndex = Math.max(
    0,
    Math.min(effortOrder.length - 1, baseIndex + delta),
  );
  return effortOrder[nextIndex]!;
}

/** Selects the catalog's first Fast tier, or clears it when already active. */
export function toggleFastServiceTier(
  currentServiceTier: string | null | undefined,
  model: ModelControls,
): string | null {
  const fastTier = orderedUniqueStrings(model.serviceTiers)[0];
  if (fastTier === undefined) return null;
  return currentServiceTier === fastTier ? null : fastTier;
}
