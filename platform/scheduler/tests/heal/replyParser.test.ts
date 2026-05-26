import { describe, it, expect } from "vitest";
import { parseHealReply } from "../../src/heal/replyParser.js";

describe("parseHealReply", () => {
  it("extracts RETRY from clean ACTION line", () => {
    expect(parseHealReply("ACTION: RETRY")).toBe("RETRY");
  });

  it("extracts SKIP with surrounding prose", () => {
    expect(parseHealReply("looked at the logs, nothing to do.\nACTION: SKIP\nwill check next cron")).toBe("SKIP");
  });

  it("extracts DISABLE case-insensitive", () => {
    expect(parseHealReply("action: disable")).toBe("DISABLE");
  });

  it("extracts ADJUST", () => {
    expect(parseHealReply("ACTION: ADJUST expectedDuration=3600000")).toBe("ADJUST");
  });

  it("returns null when no ACTION line", () => {
    expect(parseHealReply("I don't know what to do")).toBeNull();
  });

  it("returns null for garbage action value", () => {
    expect(parseHealReply("ACTION: NUKE_EVERYTHING")).toBeNull();
  });

  it("picks the last ACTION line when multiple", () => {
    expect(parseHealReply("ACTION: SKIP\nwait actually\nACTION: RETRY")).toBe("RETRY");
  });

  it("treats REJECT as first-class action", () => {
    expect(parseHealReply("ACTION: REJECT this proposal")).toBe("REJECT");
  });
});
