import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCodexReviewArgs,
  runCodexReviewer,
} from "../../src/scripts/daily-commit-reviewer.js";

describe("daily-commit Codex reviewer", () => {
  it("builds a non-interactive codex exec command that reads the prompt from stdin (not argv)", () => {
    const args = buildCodexReviewArgs("/tmp/out.txt", "gpt-test");

    expect(args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-test",
      "--output-last-message",
      "/tmp/out.txt",
      "-",
    ]);
  });

  it("delivers the review prompt over stdin so a large payload never overflows ARG_MAX (E2BIG)", () => {
    const tmpRoot = join("/tmp", `localgit-reviewer-test-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });

    const calls: Array<{ bin: string; args: string[]; options: { cwd?: string; input?: string } }> = [];
    // A payload far larger than ARG_MAX — the previous argv transport threw E2BIG here
    // (skill-master 1619-file dirty set, 2026-07-13).
    const hugePrompt = "SAFETY prompt " + "x".repeat(2 * 1024 * 1024);
    const result = runCodexReviewer(hugePrompt, "/repo/path", {
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
    // The prompt is piped via stdin, never placed on argv (that is what caused E2BIG).
    expect(calls[0].options.input).toBe(hugePrompt);
    expect(calls[0].args).not.toContain(hugePrompt);
    expect(calls[0].args[calls[0].args.length - 1]).toBe("-");
  });

  it("daily-commit pipeline no longer shells out to the Claude reviewer", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/scripts/daily-commit-pipeline.ts"), "utf-8");

    expect(source).toContain("runCodexReviewer");
    expect(source).not.toContain('execFileSync("claude"');
    expect(source).not.toContain("--model\", \"haiku");
    expect(source).not.toContain("--model\", \"opus");
  });
});
