import { describe, expect, test } from "vitest";
import { asSessionId, asLarkGroupId, asAbsolutePath, asTimestamp, asCardId, asMessageRunId } from "../../src/domain/ids.ts";

describe("branded id constructors", () => {
  test("asSessionId preserves value", () => {
    expect(asSessionId("sess_abc")).toBe("sess_abc");
  });
  test("asLarkGroupId preserves value", () => {
    expect(asLarkGroupId("oc_123")).toBe("oc_123");
  });
  test("asAbsolutePath rejects relative paths", () => {
    expect(() => asAbsolutePath("./foo")).toThrow();
    expect(asAbsolutePath("/abs/path")).toBe("/abs/path");
  });
  test("asTimestamp rejects NaN", () => {
    expect(() => asTimestamp(Number.NaN)).toThrow();
    expect(asTimestamp(1700000000000)).toBe(1700000000000);
  });
  test("asCardId preserves", () => {
    expect(asCardId("c1")).toBe("c1");
  });
  test("asMessageRunId preserves", () => {
    expect(asMessageRunId("mr1")).toBe("mr1");
  });
});
