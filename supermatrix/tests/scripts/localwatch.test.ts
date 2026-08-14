import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/localwatch.sh");

describe("localwatch scheduler management", () => {
  test("heartbeat uses a dedicated chat and leaves alerts on the root group", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const heartbeatFn = script.match(/check_lark_connectivity\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    const alertFn = script.match(/send_alert\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(script).toContain('LOCALWATCH_HEARTBEAT_GROUP="${LOCALWATCH_HEARTBEAT_GROUP:-}"');
    expect(heartbeatFn).toContain('--chat-id "$LOCALWATCH_HEARTBEAT_GROUP"');
    expect(heartbeatFn).not.toContain("$ROOT_GROUP");
    expect(alertFn).toContain('--chat-id "$ROOT_GROUP"');
  });

  test("checks for an already healthy scheduler port before starting a new process", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("SCHEDULER_PORT");
    expect(script).toContain("lsof -nP -iTCP:\"$SCHEDULER_PORT\" -sTCP:LISTEN -t");
    expect(script).toContain("http://localhost:$SCHEDULER_PORT/health");
    expect(script).toContain("adopting existing instance");
  });

  test("self-check spawn payload declares source and verification predicate", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--arg from \"$LOCALWATCH_SELFCHECK_FROM\"");
    expect(script).toContain("supermatrix_internal:{caller_invocation:\"async_kickoff\"}");
    expect(script).not.toContain("mode:\"async_kickoff\"");
    expect(script).toContain("verification_predicate");
    expect(script).toContain("session_name:$target");
    expect(script).toContain("contains_all:[\"localwatch self-check trigger\",$anchor]");
  });

  test("public script keeps local paths and self-check target configurable", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('ENV_FILE="${SM_ENV_FILE:-$PROJECT_ROOT/.env}"');
    expect(script).toContain('SCHEDULER_CWD="${SCHEDULER_CWD:-$PROJECT_ROOT/platform/scheduler}"');
    expect(script).toContain('BUSINESS_SCREEN_CWD="${BUSINESS_SCREEN_CWD:-}"');
    expect(script).toContain('LOCALWATCH_SELFCHECK_TARGET="${LOCALWATCH_SELFCHECK_TARGET:-supermatrix-root}"');
    expect(script).not.toContain("/Users/");
    expect(script).not.toContain(["zhi", "shan", "wang"].join(""));
  });
});
