import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const execFile = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout: "", stderr: "" }),
  ),
);

vi.mock("node:child_process", () => ({ execFile }));

import { syncSessionTableToLark } from "../../src/app/sessionLifecycle.ts";

describe("session table sync runner", () => {
  const originalWorkspaceRoot = process.env.SM_WORKSPACE_ROOT;

  beforeEach(() => {
    execFile.mockClear();
    process.env.SM_WORKSPACE_ROOT = "/runtime/workspaces";
  });

  afterEach(() => {
    if (originalWorkspaceRoot === undefined) {
      delete process.env.SM_WORKSPACE_ROOT;
    } else {
      process.env.SM_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
  });

  test("runs scoped push-current with normalized session names and exact argv", async () => {
    await syncSessionTableToLark(
      "scoped-push-current",
      12_345,
      [" zeta ", "alpha", "zeta"],
    );

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      "bash",
      [
        "/runtime/workspaces/first-principle/scripts/sync-session-table.sh",
        "--sessions",
        "alpha,zeta",
        "--push-current",
      ],
      { timeout: 12_345 },
      expect.any(Function),
    );
  });

  test.each([
    ["full", []],
    ["runtime-settings-pull", ["--runtime-settings", "pull"]],
    ["runtime-settings-push-current", ["--runtime-settings", "push-current"]],
    ["runtime-settings-normalize-main-defaults", ["--runtime-settings", "normalize-main-defaults"]],
  ] as const)("preserves %s argv", async (mode, modeArgs) => {
    await syncSessionTableToLark(mode, 12_345);

    expect(execFile).toHaveBeenCalledWith(
      "bash",
      [
        "/runtime/workspaces/first-principle/scripts/sync-session-table.sh",
        ...modeArgs,
      ],
      { timeout: 12_345 },
      expect.any(Function),
    );
  });
});
