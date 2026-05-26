import { describe, it, expect } from "vitest";
import { checkHardConstraints } from "../../src/classes/hardConstraints";

describe("checkHardConstraints", () => {
  it("monitoring cannot override receipt_missing to ownerDM", () => {
    const result = checkHardConstraints("monitoring", {
      notify: { receipt_missing: { channel: "ownerDM" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("monitoring");
      expect(result.reason).toContain("receipt_missing");
    }
  });

  it("delegation requires session_reply_* receipt proof (reject exit_zero)", () => {
    const result = checkHardConstraints("delegation", {
      receiptProof: { kind: "exit_zero" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("delegation");
    }
  });

  it("delegation allows session_reply_present", () => {
    const result = checkHardConstraints("delegation", {
      receiptProof: { kind: "session_reply_present", timeoutMs: 60000 },
    });
    expect(result.ok).toBe(true);
  });

  it("delegation allows session_reply_content_check", () => {
    const result = checkHardConstraints("delegation", {
      receiptProof: { kind: "session_reply_content_check", pattern: "DONE", patternType: "contains", timeoutMs: 60000 },
    });
    expect(result.ok).toBe(true);
  });

  it("sync_job allows any overrides", () => {
    const result = checkHardConstraints("sync_job", {
      weight: "light",
      receiptProof: { kind: "exit_zero" },
      notify: { receipt_missing: { channel: "customChat", target: "oc_x" } },
    });
    expect(result.ok).toBe(true);
  });

  it("null overrides always pass", () => {
    expect(checkHardConstraints("monitoring", null).ok).toBe(true);
    expect(checkHardConstraints("delegation", null).ok).toBe(true);
  });

  it("undefined overrides always pass", () => {
    expect(checkHardConstraints("monitoring", undefined).ok).toBe(true);
  });

  it("monitoring can override receipt_missing to userDM or customChat (only ownerDM is forbidden)", () => {
    // The spec says receipt_missing cannot be ownerDM for monitoring (business alerts = script's job)
    // userDM and customChat ARE allowed (user/group escalation still valid via scheduler)
    expect(checkHardConstraints("monitoring", {
      notify: { receipt_missing: { channel: "userDM" } },
    }).ok).toBe(true);
    expect(checkHardConstraints("monitoring", {
      notify: { receipt_missing: { channel: "customChat", target: "oc_x" } },
    }).ok).toBe(true);
  });
});
