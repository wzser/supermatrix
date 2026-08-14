import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { RestartProvenance } from "../app/bootSelfCheck/types.ts";

const DEFAULT_MAX_AGE_MS = 10 * 60_000;

export function restartProvenancePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), ".restart-provenance.json");
}

function legacyReloadSourcePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), ".reload-source");
}

export function writeRestartProvenance(
  dbPath: string,
  input: Omit<RestartProvenance, "version">,
): RestartProvenance {
  const record: RestartProvenance = { version: 1, ...input };
  const target = restartProvenancePath(dbPath);
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
    renameSync(temp, target);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  return record;
}

export function readFreshRestartProvenance(
  dbPath: string,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): RestartProvenance | null {
  try {
    const parsed = JSON.parse(readFileSync(restartProvenancePath(dbPath), "utf8")) as unknown;
    if (!isRestartProvenance(parsed)) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const ageMs = nowMs - parsed.requestedAtMs;
    if (ageMs < -60_000 || ageMs > maxAgeMs) return null;
    return parsed;
  } catch {
    // Fall through to the legacy one-field marker during rollout.
  }

  try {
    const legacyPath = legacyReloadSourcePath(dbPath);
    const source = readFileSync(legacyPath, "utf8").trim();
    if (!source) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const ageMs = nowMs - statSync(legacyPath).mtimeMs;
    if (ageMs < -60_000 || ageMs > maxAgeMs) return null;
    return {
      version: 1,
      restartId: `legacy-${nowMs}`,
      requestedAtMs: nowMs,
      source,
      reason: "legacy reload source marker",
      path: "command:/reload",
    };
  } catch {
    return null;
  }
}

export function consumeRestartProvenance(
  dbPath: string,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): RestartProvenance | null {
  const record = readFreshRestartProvenance(dbPath, opts);
  for (const marker of [restartProvenancePath(dbPath), legacyReloadSourcePath(dbPath)]) {
    try { unlinkSync(marker); } catch { /* missing marker is normal */ }
  }
  return record;
}

function isRestartProvenance(value: unknown): value is RestartProvenance {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["version"] === 1
    && typeof record["restartId"] === "string"
    && typeof record["requestedAtMs"] === "number"
    && Number.isFinite(record["requestedAtMs"])
    && typeof record["source"] === "string"
    && typeof record["reason"] === "string"
    && typeof record["path"] === "string"
    && (record["signal"] === undefined || typeof record["signal"] === "string")
    && (record["requesterPid"] === undefined || typeof record["requesterPid"] === "number")
    && (record["targetPid"] === undefined || typeof record["targetPid"] === "number");
}
