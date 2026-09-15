import { describe, expect, test } from "vitest";
import { MAIN_BRANCH_NAME, validateBranchName } from "../../src/domain/sessionBranch.ts";

describe("session branch names", () => {
  test("main is the default branch name", () => {
    expect(MAIN_BRANCH_NAME).toBe("main");
    expect(validateBranchName("main")).toBe("main");
  });

  test("accepts lowercase names matching session naming rules", () => {
    expect(validateBranchName("plan-a")).toBe("plan-a");
    expect(validateBranchName("a_1")).toBe("a_1");
  });

  test("rejects uppercase, spaces, leading dash, empty, and long names", () => {
    for (const value of ["", "Plan", "plan a", "-a", "a".repeat(41)]) {
      expect(() => validateBranchName(value)).toThrow(/branch name/u);
    }
  });
});
