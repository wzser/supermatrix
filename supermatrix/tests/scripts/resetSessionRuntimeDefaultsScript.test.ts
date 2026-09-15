import { describe, expect, test } from "vitest";
import {
  classifyRuntimeDefaultsResetReceipt,
  parseRuntimeDefaultsResetArgs,
  runtimeDefaultsResetExitCode,
} from "../../scripts/reset-session-runtime-defaults.ts";

describe("reset-session-runtime-defaults CLI", () => {
  test("parses the autobitable changed-only invocation", () => {
    expect(parseRuntimeDefaultsResetArgs([
      "--apply",
      "--changed-only",
      "--retry-busy",
      "--run-id",
      "wr_session_settings_1",
    ], {})).toMatchObject({
      apply: true,
      changedOnly: true,
      retryBusy: true,
      runId: "wr_session_settings_1",
    });
  });

  test("rejects changed-only mode without applying the Bitable pull", () => {
    expect(() => parseRuntimeDefaultsResetArgs(["--changed-only"], {})).toThrow(
      /--changed-only requires --apply/u,
    );
  });

  test("marks busy changed sessions retryable for the autobitable ledger", () => {
    expect(classifyRuntimeDefaultsResetReceipt({ busySkipped: ["codexroot"] }, true)).toEqual({
      ok: false,
      retryable: true,
      reason: "readiness_targets_not_ready",
    });
    expect(classifyRuntimeDefaultsResetReceipt({ busySkipped: [] }, true)).toEqual({ ok: true });
  });

  test("marks invalid defaults as a non-retryable failed receipt", () => {
    expect(classifyRuntimeDefaultsResetReceipt({
      busySkipped: [],
      invalidDefaults: [{ sessionName: "kimi", error: "codex model on kimi" }],
    }, false)).toEqual({
      ok: false,
      retryable: false,
      reason: "invalid_runtime_defaults",
    });
  });

  test("uses the scheduler-provided run id when no explicit run id is passed", () => {
    expect(parseRuntimeDefaultsResetArgs([], {
      SM_SCHEDULER_RUN_ID: "scheduler_run_1",
      SCHEDULER_RUN_ID: "legacy_run_1",
    }).runId).toBe("scheduler_run_1");
    expect(parseRuntimeDefaultsResetArgs([], {
      SCHEDULER_RUN_ID: "legacy_run_1",
    }).runId).toBe("legacy_run_1");
  });

  test("uses exit 75 only for retryable busy receipts", () => {
    expect(runtimeDefaultsResetExitCode({ ok: true })).toBe(0);
    expect(runtimeDefaultsResetExitCode({
      ok: false,
      retryable: true,
      reason: "readiness_targets_not_ready",
    })).toBe(75);
    expect(runtimeDefaultsResetExitCode({
      ok: false,
      retryable: false,
      reason: "invalid_runtime_defaults",
    })).toBe(1);
  });
});
