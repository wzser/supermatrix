import { describe, expect, it } from "vitest";
import {
  ROOT_SESSION,
  SOURCE_SESSION,
  buildRootReviewSpawnBody,
  formatSpawnAdmissionError,
} from "../../src/scripts/_weekly-upgrade-shared.js";

describe("weekly upgrade spawn contract", () => {
  it("builds root review spawns with caller identity and a verification predicate", () => {
    const body = buildRootReviewSpawnBody("review prompt");

    expect(body).toMatchObject({
      target: ROOT_SESSION,
      from: SOURCE_SESSION,
      prompt: "review prompt",
    });
    expect(body).not.toHaveProperty("mode");
    expect(body.verification_predicate).toEqual({
      type: "git-log",
      repo_path: process.env.SM_REPO_ROOT ?? process.cwd(),
      since: { kind: "spawn_created_at" },
      message_regex: "(?:update lark cli dependency|adapt to (?:claude-code|codex|lark-cli)@|weekly CLI upgrade)",
      min_count: 1,
      expected_window_sec: 28800,
    });
  });

  it("preserves machine-readable spawn admission errors", () => {
    const message = formatSpawnAdmissionError(400, {
      ok: false,
      code: "MISSING_VERIFICATION_PREDICATE",
      error: "missing verification_predicate",
      details: ["verification_predicate is required for /api/spawn"],
    });

    expect(message).toBe(
      "HTTP 400 MISSING_VERIFICATION_PREDICATE: missing verification_predicate - verification_predicate is required for /api/spawn",
    );
  });
});
