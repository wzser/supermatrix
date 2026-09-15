import { describe, expect, test } from "vitest";
import { errorMessage } from "../../src/app/errorMessage.ts";

describe("errorMessage", () => {
  test("extracts top-level structured error fields", () => {
    expect(errorMessage({ error: "ACP prompt failed", code: "kimi_acp_error" })).toBe("ACP prompt failed");
    expect(errorMessage({ reason: "backend launch failed" })).toBe("backend launch failed");
  });

  test("extracts nested structured error messages", () => {
    expect(errorMessage({ error: { message: "spawn codex ENOENT" } })).toBe("spawn codex ENOENT");
  });

  test("does not render circular objects as [object Object]", () => {
    const err: Record<string, unknown> = {};
    err["self"] = err;

    expect(errorMessage(err)).toBe("unserializable object error");
  });
});
