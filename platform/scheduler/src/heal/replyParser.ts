import type { HealAction } from "./types.js";

const VALID: HealAction[] = ["RETRY", "SKIP", "DISABLE", "ADJUST", "REJECT"];

export function parseHealReply(text: string): HealAction | null {
  const re = /action\s*:\s*([A-Za-z]+)/gi;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1].toUpperCase();
  return (VALID as string[]).includes(last) ? (last as HealAction) : null;
}
