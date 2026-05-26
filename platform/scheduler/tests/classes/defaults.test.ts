import { describe, it, expect } from "vitest";
import { CLASS_DEFAULTS } from "../../src/classes/defaults.js";

describe("CLASS_DEFAULTS", () => {
  it("defines all 5 classes", () => {
    expect(Object.keys(CLASS_DEFAULTS)).toEqual([
      "sync_job", "publication", "monitoring", "delegation", "notification"
    ]);
  });

  it("sync_job defaults: script + heavy + pure + external_evidence", () => {
    const d = CLASS_DEFAULTS.sync_job;
    expect(d.kind).toBe("script");
    expect(d.weight).toBe("heavy");
    expect(d.idempotency).toBe("pure");
    expect(d.receiptProof.kind).toBe("external_evidence");
    expect(d.notify.trigger_failed.channel).toBe("ownerDM");
    expect(d.notify.receipt_missing.channel).toBe("ownerDM");
    expect(d.notify.succeeded.channel).toBe("none");
  });

  it("monitoring disallows ownerDM on receipt_missing", () => {
    const d = CLASS_DEFAULTS.monitoring;
    expect(d.notify.receipt_missing.channel).toBe("none");
    expect(d.weight).toBe("light");
    expect(d.receiptProof.kind).toBe("exit_zero");
  });

  it("delegation defaults: session + session_reply_content_check", () => {
    const d = CLASS_DEFAULTS.delegation;
    expect(d.kind).toBe("session");
    expect(d.receiptProof.kind).toBe("session_reply_content_check");
  });

  it("notification: session + light + reply_present", () => {
    const d = CLASS_DEFAULTS.notification;
    expect(d.kind).toBe("session");
    expect(d.weight).toBe("light");
    expect(d.receiptProof.kind).toBe("session_reply_present");
  });
});
