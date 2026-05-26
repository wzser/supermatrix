export type HealPatch = {
  expectedDurationMs?: number;
  overrides?: Record<string, unknown> | null;
  cron?: string;
};

const ALLOWED_KEYS = new Set(["expectedDurationMs", "overrides", "cron"]);

export function parseHealPatch(text: string): HealPatch | null {
  const m = text.match(/patch\s*:/i);
  if (!m || m.index === undefined) return null;

  const after = text.slice(m.index + m[0].length);
  const braceStart = after.indexOf("{");
  if (braceStart < 0) return null;

  const slice = sliceJsonObject(after.slice(braceStart));
  if (!slice) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) return null;
  }

  const out: HealPatch = {};
  if ("expectedDurationMs" in obj) {
    const v = obj.expectedDurationMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 86400000) return null;
    out.expectedDurationMs = v;
  }
  if ("overrides" in obj) {
    const v = obj.overrides;
    if (v !== null && (typeof v !== "object" || Array.isArray(v))) return null;
    out.overrides = v as Record<string, unknown> | null;
  }
  if ("cron" in obj) {
    const v = obj.cron;
    if (typeof v !== "string" || v.trim().length === 0) return null;
    out.cron = v;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function sliceJsonObject(s: string): string | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}
