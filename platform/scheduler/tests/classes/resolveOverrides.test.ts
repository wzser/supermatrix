import { describe, it, expect } from "vitest";
import { resolveOverrides } from "../../src/classes/resolveOverrides";

describe("resolveOverrides", () => {
  it("returns class defaults when no overrides", () => {
    const effective = resolveOverrides("monitoring", null);
    expect(effective.weight).toBe("light");
    expect(effective.receiptProof.kind).toBe("exit_zero");
  });

  it("sync_job with no override falls back to exit_zero (not sqlite footgun)", () => {
    const effective = resolveOverrides("sync_job", null);
    expect(effective.receiptProof).toEqual({ kind: "exit_zero" });
  });

  it("publication with no override falls back to exit_zero (not sqlite footgun)", () => {
    const effective = resolveOverrides("publication", null);
    expect(effective.receiptProof).toEqual({ kind: "exit_zero" });
  });

  it("sync_job with explicit sqlite override (with target) keeps sqlite", () => {
    const effective = resolveOverrides("sync_job", {
      receiptProof: {
        kind: "external_evidence",
        engine: "sqlite",
        target: { db: "/path/to.db", sql: "SELECT count(*) FROM runs WHERE ts > ?" },
        expectation: ">= 1",
      },
    });
    expect(effective.receiptProof.kind).toBe("external_evidence");
    if (effective.receiptProof.kind === "external_evidence") {
      expect(effective.receiptProof.engine).toBe("sqlite");
    }
  });

  it("overrides single leaf field (weight)", () => {
    const effective = resolveOverrides("sync_job", { weight: "light" });
    expect(effective.weight).toBe("light");
    expect(effective.kind).toBe("script");  // inherited
    expect(effective.idempotency).toBe("pure");  // inherited
  });

  it("deep merges notify rule for a single event", () => {
    const effective = resolveOverrides("sync_job", {
      notify: { receipt_missing: { channel: "customChat", target: "oc_xxx" } },
    });
    expect(effective.notify.receipt_missing.channel).toBe("customChat");
    expect(effective.notify.receipt_missing.target).toBe("oc_xxx");
    expect(effective.notify.trigger_failed.channel).toBe("ownerDM");  // inherited
    expect(effective.notify.succeeded.channel).toBe("none");  // inherited
  });

  it("replaces receiptProof entirely (discriminated union)", () => {
    const effective = resolveOverrides("sync_job", {
      receiptProof: { kind: "exit_zero" },
    });
    expect(effective.receiptProof).toEqual({ kind: "exit_zero" });
  });

  it("explicitly silencing an event with channel:'none' overrides the default", () => {
    const effective = resolveOverrides("sync_job", {
      notify: { trigger_failed: { channel: "none" } },
    });
    expect(effective.notify.trigger_failed.channel).toBe("none");
  });

  it("also handles undefined overrides same as null", () => {
    const effective = resolveOverrides("notification", undefined);
    expect(effective.weight).toBe("light");
    expect(effective.receiptProof.kind).toBe("session_reply_present");
  });

  it("returned result does not alias CLASS_DEFAULTS (mutation safety)", () => {
    const r1 = resolveOverrides("monitoring", null);
    // Deep mutation attempt
    (r1.notify.trigger_failed as { channel: string }).channel = "mutated";
    const r2 = resolveOverrides("monitoring", null);
    expect(r2.notify.trigger_failed.channel).toBe("ownerDM");  // unaffected
  });
});
