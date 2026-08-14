import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupPendingForceReloadNudge,
  forceReloadNudgePath,
} from "../../src/app/forceReloadNudge.ts";

describe("forceReloadNudge legacy cleanup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fr-nudge-"));
    dbPath = path.join(dir, "sm.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file is a no-op", () => {
    expect(cleanupPendingForceReloadNudge(dbPath)).toEqual({ removed: false });
  });

  test("historical force reload nudge file is removed without sending messages", () => {
    writeFileSync(
      forceReloadNudgePath(dbPath),
      JSON.stringify({
        source: "watchdog",
        reason: "/reload --force",
        reloadedAt: 1,
        sessions: ["sess-a", "sess-b"],
      }),
      "utf-8",
    );
    const larkSendMessage = vi.fn();

    expect(cleanupPendingForceReloadNudge(dbPath)).toEqual({ removed: true });

    expect(existsSync(forceReloadNudgePath(dbPath))).toBe(false);
    expect(larkSendMessage).not.toHaveBeenCalled();
  });

  test("malformed historical file is also removed", () => {
    writeFileSync(forceReloadNudgePath(dbPath), "{not json", "utf-8");

    expect(cleanupPendingForceReloadNudge(dbPath)).toEqual({ removed: true });

    expect(existsSync(forceReloadNudgePath(dbPath))).toBe(false);
  });
});
