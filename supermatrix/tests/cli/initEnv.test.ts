import { describe, expect, it } from "vitest";
import {
  buildEnvUpdates,
  mergeEnvText,
  parseAuthStatusOpenId,
} from "../../src/cli/init/envFile.ts";

describe("init env helpers", () => {
  it("maps QR PersonalAgent registration into safe local .env updates", () => {
    const updates = buildEnvUpdates({
      appId: "cli_test_app",
      appSecret: "test-secret",
      tenant: "feishu",
      operatorOpenId: "ou_operator",
      rootGroupId: "oc_console",
      repoRoot: "/repo",
    });

    expect(updates).toMatchObject({
      LARK_APP_ID: "cli_test_app",
      LARK_APP_SECRET: "test-secret",
      LARK_TENANT: "feishu",
      SM_ROOT_USER_ID: "ou_operator",
      SM_ROOT_GROUP_ID: "oc_console",
      SM_WORKSPACE_ROOT: "$HOME/SuperMatrixWorkspaces",
      SM_DB_PATH: "$HOME/SuperMatrixRuntime/data/supermatrix.db",
      SM_RUNTIME_ROOT: "$HOME/SuperMatrixRuntime",
      SM_BACKEND: "claude",
      SM_LARK_CLI_PATH: "/repo/supermatrix/node_modules/.bin/lark-cli",
      SM_REPO_ROOT: "/repo/supermatrix",
    });
  });

  it("updates existing keys and appends missing keys without dropping comments", () => {
    const input = [
      "# local config",
      "SM_BACKEND=codex",
      "SM_ROOT_GROUP_ID=old",
      "",
    ].join("\n");

    const output = mergeEnvText(input, {
      SM_BACKEND: "claude",
      SM_ROOT_GROUP_ID: "oc_new",
      LARK_APP_ID: "cli_new",
      LARK_APP_SECRET: "secret with space",
    });

    expect(output).toContain("# local config\n");
    expect(output).toContain("SM_BACKEND=claude\n");
    expect(output).toContain("SM_ROOT_GROUP_ID=oc_new\n");
    expect(output).toContain("\n# Added by Super Matrix init\n");
    expect(output).toContain("LARK_APP_ID=cli_new\n");
    expect(output).toContain('LARK_APP_SECRET="secret with space"\n');
    expect(output.match(/^SM_BACKEND=/gm)).toHaveLength(1);
  });

  it("extracts owner open_id from lark-cli auth status JSON shapes", () => {
    expect(parseAuthStatusOpenId(JSON.stringify({ userOpenId: "ou_a" }))).toBe("ou_a");
    expect(parseAuthStatusOpenId(JSON.stringify({ data: { user_open_id: "ou_b" } }))).toBe("ou_b");
    expect(parseAuthStatusOpenId("not json")).toBeUndefined();
  });
});
