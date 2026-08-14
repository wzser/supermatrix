import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/weekly-review-watchdog.sh");

function runZsh(script: string): string {
  return execFileSync("zsh", ["-c", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("weekly-review-watchdog", () => {
  test("build_payload requests spawn2.0 todo-pool closure without public mode", () => {
    const output = runZsh(`
source ${JSON.stringify(SCRIPT_PATH)}
build_payload codexroot "write the review"
`);
    const payload = JSON.parse(output) as {
      target: string;
      from?: string;
      prompt: string;
      client_request_id?: string;
      mode?: string;
      supermatrix_internal?: { caller_invocation?: string };
      closure?: { kind?: string; target?: { type?: string } };
      verification_predicate?: { contains_all?: string[] };
    };

    expect(payload).toMatchObject({
      target: "codexroot",
      from: "supermatrix-root",
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: "codexroot",
        field: "prompt",
        expected_window_sec: 3600,
      },
    });
    expect(payload.client_request_id).toMatch(/^20\d\d-\d\d-\d\d:weekly-review:codexroot:/u);
    expect(payload.supermatrix_internal).toBeUndefined();
    expect(payload.mode).toBeUndefined();
    expect(payload.prompt).toContain("write the review");
    expect(payload.prompt).toContain("[spawn_predicate_anchor] weekly_review_");
    const anchor = payload.verification_predicate?.contains_all?.find((token) => token.startsWith("weekly_review_"));
    expect(anchor).toBeTruthy();
    expect(payload.prompt).toContain(anchor);
  });

  test("parse_result_response_file extracts completed child result metadata", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "weekly-review-watchdog-test-"));
    const resultFile = join(tempDir, "result.json");
    writeFileSync(
      resultFile,
      JSON.stringify({
        ok: true,
        status: "completed",
        childSessionName: "child_codexroot_123456",
        childSessionId: "sess_child_123456",
        backendSessionId: "backend-1",
        finalMessage: "R1_DONE /tmp/review.md",
      }),
      "utf8",
    );

    try {
      const output = runZsh(`
source ${JSON.stringify(SCRIPT_PATH)}
parse_result_response_file ${JSON.stringify(resultFile)}
`);

      expect(output).toBe("completed\tchild_codexroot_123456\tsess_child_123456\tbackend-1\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("build_reviewer_prompt can be sourced and emits the placeholder skeleton instructions", () => {
    const output = runZsh(`
source ${JSON.stringify(SCRIPT_PATH)}
REVIEW_DATE=2026-04-21
build_reviewer_prompt R2 /tmp/workspaces /tmp/2026-04-21-weekly-review.md
`);

    expect(output).toContain("/tmp/2026-04-21-weekly-review.md");
    expect(output).toContain("# 2026-04-21 Weekly Review");
    expect(output).toContain("TEMP_PLACEHOLDER");
    expect(output).not.toContain("`");
  });

  test("review_doc_is_complete rejects placeholder docs and accepts completed docs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "weekly-review-watchdog-test-"));
    const placeholderDoc = join(tempDir, "placeholder.md");
    const completedDoc = join(tempDir, "completed.md");

    writeFileSync(
      placeholderDoc,
      `# 2026-04-21 Weekly Review

## 1) 是否达到变更目的
TEMP_PLACEHOLDER

## 2) 功能是否正常、是否有缺陷
TEMP_PLACEHOLDER

## 3) 是否存在安全隐患
TEMP_PLACEHOLDER
`,
      "utf8",
    );

    writeFileSync(
      completedDoc,
      `# 2026-04-21 Weekly Review

## 1) 是否达到变更目的
本周框架改造目标已经落到可运行路径上。

## 2) 功能是否正常、是否有缺陷
主路径可运行，但调度器脚本仍需继续观察。

## 3) 是否存在安全隐患
本次变更未看到新的高风险安全暴露面。
`,
      "utf8",
    );

    try {
      const placeholderOutput = runZsh(`
source ${JSON.stringify(SCRIPT_PATH)}
set +e
review_doc_is_complete ${JSON.stringify(placeholderDoc)}
rc=$?
printf "__STATUS__:%s\\n" "$rc"
`);
      expect(placeholderOutput).toContain("__STATUS__:1");

      const completedOutput = runZsh(`
source ${JSON.stringify(SCRIPT_PATH)}
set +e
review_doc_is_complete ${JSON.stringify(completedDoc)}
rc=$?
printf "__STATUS__:%s\\n" "$rc"
`);
      expect(completedOutput).toContain("__STATUS__:0");
      expect(completedOutput).toContain("validated review doc:");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
