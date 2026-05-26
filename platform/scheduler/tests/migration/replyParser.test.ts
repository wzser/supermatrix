import { describe, it, expect } from "vitest";
import { parseMigrationReply } from "../../src/migration/replyParser.js";

describe("parseMigrationReply", () => {
  it("extracts CONFIRM with expectedDuration kv", () => {
    const r = parseMigrationReply("looks fine.\nACTION: CONFIRM expectedDuration=1800000");
    expect(r?.action).toBe("CONFIRM");
    expect(r?.kv.expectedDuration).toBe("1800000");
  });

  it("extracts MODIFY with class and expectedDuration", () => {
    const r = parseMigrationReply("ACTION: MODIFY class=publication expectedDuration=7200000");
    expect(r?.action).toBe("MODIFY");
    expect(r?.kv.class).toBe("publication");
    expect(r?.kv.expectedDuration).toBe("7200000");
  });

  it("extracts LATER without kv", () => {
    const r = parseMigrationReply("busy this week, ACTION: LATER");
    expect(r?.action).toBe("LATER");
    expect(r?.kv).toEqual({});
  });

  it("extracts DISABLE", () => {
    const r = parseMigrationReply("ACTION: DISABLE");
    expect(r?.action).toBe("DISABLE");
  });

  it("returns null on no ACTION", () => {
    expect(parseMigrationReply("nothing useful")).toBeNull();
  });

  it("returns null on unknown action", () => {
    expect(parseMigrationReply("ACTION: DESTROY")).toBeNull();
  });

  it("picks last ACTION when multiple", () => {
    const r = parseMigrationReply("ACTION: LATER\nactually\nACTION: CONFIRM expectedDuration=3000");
    expect(r?.action).toBe("CONFIRM");
    expect(r?.kv.expectedDuration).toBe("3000");
  });
});
