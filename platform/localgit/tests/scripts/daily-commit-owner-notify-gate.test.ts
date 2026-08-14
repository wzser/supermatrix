import { describe, expect, it } from "vitest";
import {
  buildDailyCommitDispatchId,
  shouldNotifyOwner,
  type OwnerNotificationHistory,
} from "../../src/scripts/daily-commit-owner-notify-gate.js";

const emptyHistory: OwnerNotificationHistory = {
  dispatches: [],
  decisions: [],
  ledger: [],
};

describe("daily-commit owner notification gate", () => {
  it("notifies when a dirty fingerprint has no prior history", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        skippedReason: "unsafe source change",
        currentRunId: "daily-current",
        history: emptyHistory,
      }),
    ).toEqual({
      kind: "notify",
      dispatchId: buildDailyCommitDispatchId({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        skippedReason: "unsafe source change",
      }),
    });
  });

  it("suppresses when an owner hint was already sent for the same fingerprint", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        currentRunId: "daily-current",
        history: {
          ...emptyHistory,
          dispatches: [
            {
              dispatch_id: "dc-prior",
              kind: "owner_hint",
              status: "sent",
              repo: "dali",
              dirty_fingerprint: "fp1",
            },
          ],
        },
      }),
    ).toEqual({
      kind: "suppress",
      reason: "owner hint already dispatched for the same dirty fingerprint",
      priorDispatchId: "dc-prior",
    });
  });

  it("suppresses when an unexpired owner decision covers the fingerprint", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        currentRunId: "daily-current",
        nowIso: "2026-06-05T00:00:00.000Z",
        history: {
          ...emptyHistory,
          decisions: [
            {
              decision_id: "dec-prior",
              repo: "dali",
              dirty_fingerprint: "fp1",
              decision: "quiet_until_changed",
            },
          ],
        },
      }),
    ).toEqual({
      kind: "suppress",
      reason: "owner decision already recorded: quiet_until_changed",
      decisionId: "dec-prior",
    });
  });

  it("notifies when the latest matching decision explicitly asks to notify again", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        currentRunId: "daily-current",
        history: {
          ...emptyHistory,
          decisions: [
            {
              decision_id: "dec-prior",
              repo: "dali",
              dirty_fingerprint: "fp1",
              decision: "notify_again",
            },
          ],
        },
      }).kind,
    ).toBe("notify");
  });

  it("suppresses when the same fingerprint was already skipped in an earlier run", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp1",
        currentRunId: "daily-current",
        history: {
          ...emptyHistory,
          ledger: [
            {
              run_id: "daily-prior",
              repo: "dali",
              operation: "skip",
              dirty_fingerprint: "fp1",
            },
            {
              run_id: "daily-current",
              repo: "dali",
              operation: "skip",
              dirty_fingerprint: "fp1",
            },
          ],
        },
      }),
    ).toEqual({
      kind: "suppress",
      reason: "same dirty fingerprint already recorded by an earlier daily-commit run",
      priorRunId: "daily-prior",
    });
  });

  it("does not suppress a changed fingerprint", () => {
    expect(
      shouldNotifyOwner({
        date: "2026-06-05",
        repo: "dali",
        dirtyFingerprint: "fp2",
        currentRunId: "daily-current",
        history: {
          ...emptyHistory,
          dispatches: [
            {
              dispatch_id: "dc-prior",
              kind: "owner_hint",
              status: "sent",
              repo: "dali",
              dirty_fingerprint: "fp1",
            },
          ],
          decisions: [
            {
              decision_id: "dec-prior",
              repo: "dali",
              dirty_fingerprint: "fp1",
              decision: "quiet_until_changed",
            },
          ],
          ledger: [
            {
              run_id: "daily-prior",
              repo: "dali",
              operation: "skip",
              dirty_fingerprint: "fp1",
            },
          ],
        },
      }).kind,
    ).toBe("notify");
  });
});
