import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const shimPath = path.join(repoRoot, "scripts/shims/lark-cli");

describe("lark-cli delta shim", () => {
  let tempDir: string;
  let realCliPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "sm-lark-cli-shim-"));
    realCliPath = path.join(tempDir, "real-lark-cli");
    await writeFile(
      realCliPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
process.exit(Number(process.env.FAKE_EXIT_CODE ?? "0"));
`,
      "utf8",
    );
    await chmod(realCliPath, 0o755);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "prefixes as-user text",
      argv: ["im", "+messages-send", "--as", "user", "--text", "hi"],
      expected: ["im", "+messages-send", "--as", "user", "--text", "Δhi"],
    },
    {
      name: "prefixes as-user markdown regardless of flag order",
      argv: ["im", "+messages-send", "--markdown", "# hi", "--as", "user"],
      expected: ["im", "+messages-send", "--markdown", "Δ# hi", "--as", "user"],
    },
    {
      name: "does not duplicate the marker",
      argv: ["im", "+messages-send", "--as", "user", "--text", "Δhi"],
      expected: ["im", "+messages-send", "--as", "user", "--text", "Δhi"],
    },
    {
      name: "does not change bot sends",
      argv: ["im", "+messages-send", "--as", "bot", "--text", "hi"],
      expected: ["im", "+messages-send", "--as", "bot", "--text", "hi"],
    },
    {
      name: "does not change sends with omitted identity",
      argv: ["im", "+messages-send", "--text", "hi"],
      expected: ["im", "+messages-send", "--text", "hi"],
    },
    {
      name: "does not change structured content",
      argv: ["im", "+messages-send", "--as", "user", "--content", "{\"text\":\"hi\"}"],
      expected: ["im", "+messages-send", "--as", "user", "--content", "{\"text\":\"hi\"}"],
    },
    {
      name: "does not change media sends",
      argv: ["im", "+messages-send", "--as", "user", "--file", "report.txt"],
      expected: ["im", "+messages-send", "--as", "user", "--file", "report.txt"],
    },
    {
      name: "does not change non-IM commands",
      argv: ["base", "+record-create", "--text", "hi", "--as", "user"],
      expected: ["base", "+record-create", "--text", "hi", "--as", "user"],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = runShim(testCase.argv, realCliPath);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(testCase.expected);
    });
  }

  it("preserves real CLI stderr and exit status", () => {
    const result = runShim(["--version"], realCliPath, {
      FAKE_STDERR: "real failure",
      FAKE_EXIT_CODE: "23",
    });

    expect(result.status).toBe(23);
    expect(result.stderr).toBe("real failure");
  });

  it("fails explicitly when the real CLI is missing", () => {
    const result = runShim(["--version"], path.join(tempDir, "missing"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("real lark-cli is not executable");
  });

  it("fails explicitly when the real CLI resolves to the shim", () => {
    const result = runShim(["--version"], shimPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("real lark-cli resolves to the shim");
  });
});

function runShim(
  argv: string[],
  realCliPath: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(shimPath, argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      SM_REAL_LARK_CLI_PATH: realCliPath,
    },
  });
}
