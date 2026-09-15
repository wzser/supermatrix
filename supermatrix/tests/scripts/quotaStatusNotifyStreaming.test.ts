import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
vi.doMock("node:fs", () => ({
  ...actualFs,
  readFileSync: ((path: Parameters<typeof actualFs.readFileSync>[0], ...args: any[]) => {
    if (String(path).endsWith(".jsonl")) {
      throw new Error("Codex JSONL must not be read as one string");
    }
    return actualFs.readFileSync(path, ...args);
  }) as typeof actualFs.readFileSync,
}));

const { findLatestCodexRateLimits } = await import("../../scripts/quota-status-notify.ts");

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("quota-status-notify Codex file collector", () => {
  test("finds the newest rate_limits event without reading a JSONL file into one string", async () => {
    const root = mkdtempSync(join(tmpdir(), "supermatrix-codex-quota-streaming-"));
    tempDirs.push(root);
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir);
    const file = join(sessionsDir, "latest.jsonl");
    writeFileSync(file, [
      JSON.stringify({
        timestamp: "2026-08-29T01:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 20, window_minutes: 300, resets_at: 1787965200 },
            secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1788566400 },
            plan_type: "pro",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-29T01:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1787967000 },
            secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1788568200 },
            plan_type: "pro",
          },
        },
      }),
    ].join("\n") + "\n");

    await expect(findLatestCodexRateLimits(sessionsDir, 1)).resolves.toMatchObject({
      ok: true,
      observedAtMs: Date.parse("2026-08-29T01:30:00.000Z"),
      sourcePath: file,
      primary: { usedPercent: 12, remainingPercent: 88, windowMinutes: 300 },
      secondary: { usedPercent: 18, remainingPercent: 82, windowMinutes: 10080 },
    });
  });
});
