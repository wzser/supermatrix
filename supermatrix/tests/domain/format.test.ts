import { describe, expect, test } from "vitest";
import { formatIso, formatRelativeChinese } from "../../src/domain/format.ts";
import { asTimestamp } from "../../src/domain/ids.ts";

describe("formatIso", () => {
  test("returns ISO 8601", () => {
    const ts = asTimestamp(Date.UTC(2026, 3, 11, 10, 30, 0));
    expect(formatIso(ts)).toBe("2026-04-11T10:30:00.000Z");
  });
});

describe("formatRelativeChinese", () => {
  const now = asTimestamp(Date.UTC(2026, 3, 11, 12, 0, 0));
  test("< 60s shows 刚刚", () => {
    expect(formatRelativeChinese(asTimestamp(now - 5_000), now)).toBe("刚刚");
  });
  test("minutes", () => {
    expect(formatRelativeChinese(asTimestamp(now - 5 * 60_000), now)).toBe("5 分钟前");
  });
  test("hours", () => {
    expect(formatRelativeChinese(asTimestamp(now - 3 * 3600_000), now)).toBe("3 小时前");
  });
  test("days", () => {
    expect(formatRelativeChinese(asTimestamp(now - 2 * 86400_000), now)).toBe("2 天前");
  });
});
