// Verified against Kimi Code CLI 0.33.0 (2026-08-06) via `kimi provider list
// --json` plus a live `kimi -m <slug> -p` probe: the managed kimi-code
// provider serves exactly kimi-for-coding, -highspeed and k3.
// `session/set_config_option` with configId "thinking" is the per-session
// setting path. k3 advertises/accepts low, high, max and defaults to high.
// K2.7 (kimi-for-coding and -highspeed) advertises only "on": low/high/max
// return ACP -32602 and "off" reads back as "on".
// Per-session model selection still happens via `session/set_model`.
// kimi-code/k3-256k was listed here but is NOT configured on this login —
// selecting it made `session/set_model` fail with ACP -32603 and killed the
// run (2026-08-05, child_business-screen_1cee1b). Only re-add a model after a
// live probe confirms the managed provider serves it.
// This file is the single model-aware capability/mapping source: command
// admission (setEffort), the shared runtime-config policy, execution
// resolution (RunExecutionConfig) and the Kimi backend all read it.
import type { EffortLevel } from "../domain/session.ts";

export const KIMI_DEFAULT_MODEL = "kimi-code/kimi-for-coding";
export const KIMI_HIGHSPEED_MODEL = "kimi-code/kimi-for-coding-highspeed";
export const KIMI_K3_MODEL = "kimi-code/k3";

/** Native thinking levels a K3 model accepts via session/set_config_option. */
export type KimiThinkingLevel = "low" | "high" | "max";

export type KimiThinkingCapability =
  | { kind: "levels"; levels: readonly KimiThinkingLevel[]; defaultLevel: KimiThinkingLevel }
  | { kind: "fixed-on" };

type KimiModelEntry = {
  slug: string;
  thinking: KimiThinkingCapability;
};

const K3_THINKING: KimiThinkingCapability = {
  kind: "levels",
  levels: ["low", "high", "max"],
  defaultLevel: "high",
};
const FIXED_ON_THINKING: KimiThinkingCapability = { kind: "fixed-on" };

const KIMI_MODEL_CATALOG: readonly KimiModelEntry[] = [
  { slug: KIMI_DEFAULT_MODEL, thinking: FIXED_ON_THINKING },
  { slug: KIMI_HIGHSPEED_MODEL, thinking: FIXED_ON_THINKING },
  { slug: KIMI_K3_MODEL, thinking: K3_THINKING },
];

const KIMI_KNOWN_MODELS = new Set<string>(KIMI_MODEL_CATALOG.map((e) => e.slug));

export function isKnownKimiModel(model: string): boolean {
  return KIMI_KNOWN_MODELS.has(model.trim());
}

export function getKimiKnownModels(): string[] {
  return KIMI_MODEL_CATALOG.map((e) => e.slug);
}

export function formatAvailableKimiModels(): string {
  return getKimiKnownModels().join(" / ");
}

export function kimiModelUnknownMessage(model: string): string {
  return `未知 kimi 模型 "${model}"。SuperMatrix 当前已验证模型：${formatAvailableKimiModels()}；未验证模型不会被接受。`;
}

/** Thinking capability of a canonical kimi model, or null when unknown. */
export function getKimiThinkingCapability(model: string): KimiThinkingCapability | null {
  return KIMI_MODEL_CATALOG.find((e) => e.slug === model.trim())?.thinking ?? null;
}

/**
 * Official K3 compatibility mapping from a SuperMatrix effort request to the
 * K3-native thinking level: low→low, medium/high→high, xhigh/max/ultra→max.
 * ultracode is a Claude-only token and throws — admission rejects it earlier.
 */
export function mapKimiRequestedEffort(effort: EffortLevel): KimiThinkingLevel {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
    case "ultra":
      return "max";
    default:
      throw new Error(`kimi does not support effort "${effort}" (ultracode is Claude-only)`);
  }
}

/**
 * Resolve the thinking level to apply for a model, or null when the model has
 * no settable level (K2.7 fixed-on, or unknown model). On K3 models a null
 * request resolves to the K3-native default "high" — never skip the call, so
 * a reused ACP session cannot retain an earlier override.
 */
export function resolveKimiThinkingLevel(
  model: string,
  requested: EffortLevel | null,
): KimiThinkingLevel | null {
  const capability = getKimiThinkingCapability(model);
  if (!capability || capability.kind === "fixed-on") return null;
  if (requested === null) return capability.defaultLevel;
  return mapKimiRequestedEffort(requested);
}
