import { describe, expect, it } from "vitest";
import { shouldRunSelfCheck } from "../../src/cli/init/run.ts";

describe("init run helpers", () => {
  it("skips self-check when root group was not created yet", () => {
    expect(shouldRunSelfCheck(false, {
      SM_ROOT_USER_ID: "ou_owner",
    })).toBe(false);
  });

  it("skips self-check when owner user id is still missing", () => {
    expect(shouldRunSelfCheck(false, {
      SM_ROOT_GROUP_ID: "oc_console",
    })).toBe(false);
  });

  it("runs self-check when required root config exists and skip flag is false", () => {
    expect(shouldRunSelfCheck(false, {
      SM_ROOT_GROUP_ID: "oc_console",
      SM_ROOT_USER_ID: "ou_owner",
    })).toBe(true);
  });

  it("honors explicit skip flag", () => {
    expect(shouldRunSelfCheck(true, {
      SM_ROOT_GROUP_ID: "oc_console",
      SM_ROOT_USER_ID: "ou_owner",
    })).toBe(false);
  });
});
