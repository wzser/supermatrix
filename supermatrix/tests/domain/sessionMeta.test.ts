import { describe, expect, test } from "vitest";
import { UserError } from "../../src/domain/errors.ts";
import {
  isConformingAvatar,
  validateSessionAlias,
  validateSessionAvatar,
  validateSessionCategory,
} from "../../src/domain/sessionMeta.ts";

describe("validateSessionAvatar", () => {
  test("accepts empty string", () => {
    expect(() => validateSessionAvatar("")).not.toThrow();
  });
  test("accepts a 27-char base62 file_token", () => {
    expect(() => validateSessionAvatar("AbCdEfGhIjKlMnOpQrStUvWxYz0")).not.toThrow();
  });
  test("rejects https URL", () => {
    expect(() => validateSessionAvatar("https://i.pinimg.com/x.png")).toThrow(UserError);
  });
  test("rejects data URL", () => {
    expect(() => validateSessionAvatar("data:image/png;base64,AAAA")).toThrow(UserError);
  });
  test("rejects absolute filesystem path", () => {
    expect(() => validateSessionAvatar("/Users/x/avatars/y.png")).toThrow(UserError);
  });
  test("rejects 26-char alphanumeric (length boundary)", () => {
    expect(() => validateSessionAvatar("a".repeat(26))).toThrow(UserError);
  });
  test("rejects 28-char alphanumeric (length boundary)", () => {
    expect(() => validateSessionAvatar("a".repeat(28))).toThrow(UserError);
  });
  test("rejects 27 chars with underscore", () => {
    expect(() => validateSessionAvatar(`${"a".repeat(26)}_`)).toThrow(UserError);
  });
});

describe("isConformingAvatar", () => {
  test("true for empty and valid token", () => {
    expect(isConformingAvatar("")).toBe(true);
    expect(isConformingAvatar("a".repeat(27))).toBe(true);
  });
  test("false for URL / path / data URL / wrong length", () => {
    expect(isConformingAvatar("https://x")).toBe(false);
    expect(isConformingAvatar("/abs/path/x.png")).toBe(false);
    expect(isConformingAvatar("data:image/png;base64,AAAA")).toBe(false);
    expect(isConformingAvatar("a".repeat(26))).toBe(false);
  });
});

describe("validateSessionAlias", () => {
  test("accepts empty string", () => {
    expect(() => validateSessionAlias("")).not.toThrow();
  });
  test("accepts 8 CJK characters at the boundary", () => {
    expect(() => validateSessionAlias("一二三四五六七八")).not.toThrow();
  });
  test("rejects 9 CJK characters (length boundary)", () => {
    expect(() => validateSessionAlias("一二三四五六七八九")).toThrow(UserError);
  });
  test("rejects whitespace", () => {
    expect(() => validateSessionAlias("a b")).toThrow(UserError);
  });
  test("rejects forward slash", () => {
    expect(() => validateSessionAlias("a/b")).toThrow(UserError);
  });
  test("rejects backslash", () => {
    expect(() => validateSessionAlias("a\\b")).toThrow(UserError);
  });
  test("rejects pipe", () => {
    expect(() => validateSessionAlias("a|b")).toThrow(UserError);
  });
});

describe("validateSessionCategory", () => {
  test("accepts empty string", () => {
    expect(() => validateSessionCategory("")).not.toThrow();
  });
  test.each(["业务", "平台", "工具", "知识", "外部"])("accepts %s", (v) => {
    expect(() => validateSessionCategory(v)).not.toThrow();
  });
  test("rejects out-of-enum value (e.g. 框架)", () => {
    expect(() => validateSessionCategory("框架")).toThrow(UserError);
  });
  test("rejects English alias", () => {
    expect(() => validateSessionCategory("platform")).toThrow(UserError);
  });
});
