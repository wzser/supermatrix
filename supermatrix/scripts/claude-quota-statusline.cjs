#!/usr/bin/env node

const { mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

function parseWindow(raw, key, label) {
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = Number(raw.used_percentage);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const resetsAt = Number(raw.resets_at);
  return {
    key,
    label,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetAtMs: resetsAt * 1000 } : {}),
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }

  const rateLimits = input && typeof input === "object" ? input.rate_limits : null;
  const limits = [
    parseWindow(rateLimits?.five_hour, "five-hour", "5h"),
    parseWindow(rateLimits?.seven_day, "seven-day", "7d"),
  ].filter(Boolean);
  if (limits.length === 0) return;

  const generatedAt = Date.now();
  const snapshot = {
    schemaVersion: 1,
    generatedAt,
    ...(typeof input.version === "string" ? { claudeCodeVersion: input.version } : {}),
    providers: [
      {
        id: "claude",
        label: "Claude",
        status: "ok",
        source: "Claude status-line rate_limits",
        sourceObservedAt: generatedAt,
        limits,
      },
    ],
  };
  const snapshotPath =
    process.env.CLAUDE_USAGE_SNAPSHOT_PATH || join(homedir(), ".claude", "usage-status.json");
  const snapshotDir = dirname(snapshotPath);
  const temporaryPath = `${snapshotPath}.tmp.${process.pid}`;
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, snapshotPath);
}

main();
