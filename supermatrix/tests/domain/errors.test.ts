import { describe, expect, test } from "vitest";
import { DomainError, SystemError, UserError } from "../../src/domain/errors.ts";

describe("domain error taxonomy", () => {
  test("UserError is a DomainError", () => {
    const err = new UserError("名称已存在");
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe("名称已存在");
  });

  test("SystemError carries cause", () => {
    const cause = new Error("sqlite disk full");
    const err = new SystemError("persistence failed", cause);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("persistence failed");
  });

  test("SystemError cause is optional", () => {
    const err = new SystemError("unexpected");
    expect(err.cause).toBeUndefined();
  });
});
