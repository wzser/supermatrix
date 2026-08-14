import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeRestartProvenance,
  readFreshRestartProvenance,
  restartProvenancePath,
  writeRestartProvenance,
} from "../../src/cli/restartProvenance.ts";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sm-restart-provenance-"));
  tempDirs.push(dir);
  return path.join(dir, "supermatrix.db");
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("restart provenance file", () => {
  it("round-trips a structured restart source and consumes it once", () => {
    const dbPath = tempDbPath();
    const written = writeRestartProvenance(dbPath, {
      restartId: "smr_test_1",
      requestedAtMs: 1_000,
      source: "localwatch-health",
      reason: "three consecutive /api/health failures",
      path: "scripts/localwatch.sh:check_sm_health",
      signal: "SIGTERM",
      requesterPid: 22,
      targetPid: 33,
    });

    expect(JSON.parse(readFileSync(restartProvenancePath(dbPath), "utf8"))).toEqual(written);
    expect(readFreshRestartProvenance(dbPath, { nowMs: 1_500 })).toEqual(written);
    expect(consumeRestartProvenance(dbPath, { nowMs: 1_500 })).toEqual(written);
    expect(readFreshRestartProvenance(dbPath, { nowMs: 1_500 })).toBeNull();
  });

  it("does not attribute a new boot to a stale marker", () => {
    const dbPath = tempDbPath();
    writeRestartProvenance(dbPath, {
      restartId: "smr_stale",
      requestedAtMs: 1_000,
      source: "localwatch-health",
      reason: "old failure",
      path: "scripts/localwatch.sh:check_sm_health",
    });

    expect(readFreshRestartProvenance(dbPath, { nowMs: 602_001, maxAgeMs: 600_000 })).toBeNull();
  });

  it("reads the legacy plain-text reload source during rollout", () => {
    const dbPath = tempDbPath();
    writeFileSync(path.join(path.dirname(dbPath), ".reload-source"), "scheduler", "utf8");

    expect(consumeRestartProvenance(dbPath)).toMatchObject({
      source: "scheduler",
      reason: "legacy reload source marker",
      path: "command:/reload",
    });
  });
});
