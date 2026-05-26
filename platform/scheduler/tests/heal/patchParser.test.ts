import { describe, it, expect } from "vitest";
import { parseHealPatch } from "../../src/heal/patchParser.js";

describe("parseHealPatch", () => {
  it("returns null when no PATCH marker", () => {
    expect(parseHealPatch("ACTION: ADJUST\nplease fix this for me")).toBeNull();
  });

  it("returns null when PATCH marker but no JSON object", () => {
    expect(parseHealPatch("ACTION: ADJUST\nPATCH:\njust talk")).toBeNull();
  });

  it("parses simple flat PATCH", () => {
    const r = parseHealPatch('PATCH: { "expectedDurationMs": 600000 }');
    expect(r).toEqual({ expectedDurationMs: 600000 });
  });

  it("parses nested overrides PATCH spread across lines", () => {
    const text = `ok understood.
ACTION: ADJUST
PATCH:
{
  "expectedDurationMs": 1800000,
  "overrides": {
    "receiptProof": {
      "kind": "external_evidence",
      "engine": "sqlite",
      "target": { "db": "/tmp/x.db", "sql": "SELECT 1" },
      "expectation": ">= 1"
    }
  }
}
all done.`;
    const r = parseHealPatch(text);
    expect(r?.expectedDurationMs).toBe(1800000);
    expect((r?.overrides as Record<string, unknown>).receiptProof).toMatchObject({
      kind: "external_evidence",
      engine: "sqlite",
    });
  });

  it("rejects PATCH with disallowed key (enabled)", () => {
    expect(parseHealPatch('PATCH: { "enabled": false }')).toBeNull();
  });

  it("rejects PATCH with disallowed key (class)", () => {
    expect(parseHealPatch('PATCH: { "class": "monitoring" }')).toBeNull();
  });

  it("rejects PATCH with disallowed key alongside allowed key", () => {
    expect(parseHealPatch('PATCH: { "expectedDurationMs": 1000, "config": {} }')).toBeNull();
  });

  it("rejects PATCH with non-positive expectedDurationMs", () => {
    expect(parseHealPatch('PATCH: { "expectedDurationMs": 0 }')).toBeNull();
    expect(parseHealPatch('PATCH: { "expectedDurationMs": -100 }')).toBeNull();
  });

  it("rejects PATCH with expectedDurationMs over 24h cap", () => {
    expect(parseHealPatch(`PATCH: { "expectedDurationMs": ${86400001} }`)).toBeNull();
  });

  it("accepts overrides=null (clear overrides back to class default)", () => {
    expect(parseHealPatch('PATCH: { "overrides": null }')).toEqual({ overrides: null });
  });

  it("rejects overrides as array", () => {
    expect(parseHealPatch('PATCH: { "overrides": [] }')).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseHealPatch("PATCH: { not json")).toBeNull();
  });

  it("ignores braces inside JSON string values when matching", () => {
    const r = parseHealPatch('PATCH: { "cron": "0 } */2 * *", "expectedDurationMs": 1000 }');
    expect(r).toEqual({ cron: "0 } */2 * *", expectedDurationMs: 1000 });
  });

  it("returns null when patch is empty {} (nothing to apply)", () => {
    expect(parseHealPatch("PATCH: {}")).toBeNull();
  });

  it("is case-insensitive on the PATCH marker", () => {
    expect(parseHealPatch('patch: { "expectedDurationMs": 1000 }')).toEqual({ expectedDurationMs: 1000 });
  });

  it("rejects empty cron string", () => {
    expect(parseHealPatch('PATCH: { "cron": "   " }')).toBeNull();
  });
});
