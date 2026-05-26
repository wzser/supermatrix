import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCodexReviewArgs,
  runCodexReviewer,
} from "../../src/scripts/daily-commit-reviewer.js";

describe("daily-commit Codex reviewer", () => {
  it("builds a non-interactive codex exec command for structured review prompts", () => {
    const args = buildCodexReviewArgs("review prompt", "/tmp/out.txt", "gpt-test");

    expect(args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-test",
      "--output-last-message",
      "/tmp/out.txt",
      "review prompt",
    ]);
  });

  it("runs codex in the target repo and returns the last message file", () => {
    const tmpRoot = join("/tmp", `watchdog-reviewer-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });

    const calls: Array<{ bin: string; args: string[]; options: { cwd?: string } }> = [];
    const result = runCodexReviewer("SAFETY prompt", "/repo/path", {
      codexBin: "/bin/codex",
      model: "gpt-test",
      makeTempDir: () => tmpRoot,
      readFile: (path) => readFileSync(path, "utf-8"),
      removeDir: () => {},
      execFile: (bin, args, options) => {
        calls.push({ bin, args, options });
        const outputIndex = args.indexOf("--output-last-message");
        writeFileSync(args[outputIndex + 1], "SAFETY: YES\nMESSAGE: docs: test\n");
        return "";
      },
    });

    expect(result).toBe("SAFETY: YES\nMESSAGE: docs: test");
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("/bin/codex");
    expect(calls[0].options.cwd).toBe("/repo/path");
    expect(calls[0].args).toContain("--model");
    expect(calls[0].args).toContain("SAFETY prompt");
  });

  it("daily-commit script no longer shells out to the Claude reviewer", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/scripts/daily-commit.ts"), "utf-8");

    expect(source).toContain("runCodexReviewer");
    expect(source).not.toContain('execFileSync("claude"');
    expect(source).not.toContain("--model\", \"haiku");
    expect(source).not.toContain("--model\", \"opus");
  });
});
