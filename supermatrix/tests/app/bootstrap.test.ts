import { describe, expect, it } from "vitest";
import { validateEnv } from "../../src/cli/bootstrap.ts";

describe("validateEnv", () => {
  it("returns parsed config on valid env", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g_root",
      SM_ROOT_USER_ID: "u_owner",
      SM_WORKSPACE_ROOT: "/tmp/sm-work",
      SM_DB_PATH: "/tmp/sm.db",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
    });
    expect(cfg.backend).toBe("claude");
    expect(cfg.rootGroupId).toBe("g_root");
    expect(cfg.larkAppId).toBe("cli_test");
    expect(cfg.larkCliPath).toMatch(/lark-cli$/);
    expect(cfg.spawnOrphanThresholdSec).toBe(60);
  });

  it("throws when required env is missing", () => {
    expect(() => validateEnv({ SM_ROOT_USER_ID: "u" })).toThrow();
  });

  it("rejects unsupported backend", () => {
    expect(() =>
      validateEnv({
        SM_ROOT_GROUP_ID: "g",
        SM_ROOT_USER_ID: "u",
        SM_WORKSPACE_ROOT: "/w",
        SM_DB_PATH: "/d",
        SM_BACKEND: "gpt4",
        SM_LOG_LEVEL: "info",
        LARK_APP_ID: "cli_test",
      })
    ).toThrow();
  });

  it("honors explicit SM_LARK_CLI_PATH override", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      SM_LARK_CLI_PATH: "/custom/path/lark-cli",
    });
    expect(cfg.larkCliPath).toBe("/custom/path/lark-cli");
  });

  it("honors explicit spawn orphan threshold override", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      SM_SPAWN_ORPHAN_THRESHOLD_SEC: "120",
    });
    expect(cfg.spawnOrphanThresholdSec).toBe(120);
  });
});
