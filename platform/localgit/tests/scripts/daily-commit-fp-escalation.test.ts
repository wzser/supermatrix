import { describe, expect, it } from "vitest";
import {
  buildFpIdentityDocEscalation,
  spawnFpIdentityDocEscalation,
} from "../../src/scripts/daily-commit-fp-escalation.js";

describe("daily-commit FP identity-doc escalation", () => {
  it("builds the active SOP R2 spawn2.0 delegation payload", () => {
    const escalation = buildFpIdentityDocEscalation({
      date: "2026-07-13",
      repo: "tag-manager",
      skippedReason: "identity_doc_major_change without FP-orchestrated commit prefix",
      dirtyFingerprint: "fp-123",
      dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
    });

    expect(escalation.clientRequestId).toBe(
      "2026-07-13:localgit:first-principle:identity-doc-major-tag-manager",
    );
    expect(escalation.payload).toMatchObject({
      target: "first-principle",
      from: "localgit",
      client_request_id: escalation.clientRequestId,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: "first-principle",
        field: "prompt",
        contains_all: [escalation.verificationToken],
        expected_window_sec: 600,
      },
    });
    expect(escalation.payload.prompt).toContain("[verification: comm_identity_doc_major_");
    expect(escalation.payload.prompt).toContain("Daily-commit found identity_doc_major_change in tag-manager.");
    expect(escalation.payload.prompt).toContain("关联ID：dc-2026-07-13-tag-manager-abcdef123456");
    expect(escalation.payload.prompt).toContain("Localgit must not auto-commit this dirty set without your decision.");
  });

  it("posts to spawn2.0 and treats accepted receipt as delegation receipt, not review completion", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const receipt = spawnFpIdentityDocEscalation(
      buildFpIdentityDocEscalation({
        date: "2026-07-13",
        repo: "tag-manager",
        skippedReason: "identity_doc_major_change",
        dirtyFingerprint: "fp-123",
        dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
      }),
      {
        runCommand(command, args) {
          calls.push({ command, args });
          return JSON.stringify({
            ok: true,
            mode: "async_kickoff",
            closure: "todo_pool",
            ref: "spawn2.0:comm_abc",
            childSessionId: "child_123",
            spawnCommId: "comm_abc",
          }) + "\n202";
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("curl");
    expect(calls[0].args).toContain("http://localhost:3501/api/spawn2.0");
    expect(calls[0].args).not.toContain("lark-cli");
    expect(calls[0].args).not.toContain("--as");

    const payloadArgIndex = calls[0].args.indexOf("-d") + 1;
    const payload = JSON.parse(calls[0].args[payloadArgIndex] ?? "{}");
    expect(payload.from).toBe("localgit");
    expect(payload.target).toBe("first-principle");
    expect(payload.client_request_id).toBe(
      "2026-07-13:localgit:first-principle:identity-doc-major-tag-manager",
    );
    expect(payload.closure).toEqual({ kind: "message", target: { type: "todo_pool" } });

    expect(receipt).toEqual({
      accepted: true,
      statusCode: 202,
      body: {
        ok: true,
        mode: "async_kickoff",
        closure: "todo_pool",
        ref: "spawn2.0:comm_abc",
        childSessionId: "child_123",
        spawnCommId: "comm_abc",
      },
      receiptSummary: "spawn2.0 todo_pool accepted ref=spawn2.0:comm_abc spawnCommId=comm_abc",
    });
  });

  it("accepts duplicate only when existing comm id and status are auditable", () => {
    const receipt = spawnFpIdentityDocEscalation(
      buildFpIdentityDocEscalation({
        date: "2026-07-13",
        repo: "tag-manager",
        skippedReason: "identity_doc_major_change",
        dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
      }),
      {
        runCommand() {
          return JSON.stringify({
            duplicate: true,
            existing: { commId: "comm_existing", status: "waiting_child" },
          }) + "\n409";
        },
      },
    );

    expect(receipt).toEqual({
      accepted: true,
      statusCode: 409,
      body: {
        duplicate: true,
        existing: { commId: "comm_existing", status: "waiting_child" },
      },
      receiptSummary: "spawn2.0 duplicate accepted existingCommId=comm_existing existingStatus=waiting_child",
    });
  });

  it("fails closed when spawn2.0 does not return an accepted receipt", () => {
    expect(() =>
      spawnFpIdentityDocEscalation(
        buildFpIdentityDocEscalation({
          date: "2026-07-13",
          repo: "tag-manager",
          skippedReason: "identity_doc_major_change",
          dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
        }),
        {
          runCommand() {
            return JSON.stringify({ error: "target not found" }) + "\n404";
          },
        },
      ),
    ).toThrow("spawn2.0 FP escalation failed with HTTP 404");

    expect(() =>
      spawnFpIdentityDocEscalation(
        buildFpIdentityDocEscalation({
          date: "2026-07-13",
          repo: "tag-manager",
          skippedReason: "identity_doc_major_change",
          dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
        }),
        {
          runCommand() {
            return JSON.stringify({ ok: false, mode: "switched_async", commId: "comm_bad" }) + "\n202";
          },
        },
      ),
    ).toThrow("spawn2.0 FP escalation failed with HTTP 202");

    expect(() =>
      spawnFpIdentityDocEscalation(
        buildFpIdentityDocEscalation({
          date: "2026-07-13",
          repo: "tag-manager",
          skippedReason: "identity_doc_major_change",
          dispatchId: "dc-2026-07-13-tag-manager-abcdef123456",
        }),
        {
          runCommand() {
            return JSON.stringify({ duplicate: true, existing: { commId: "comm_missing_status" } }) + "\n409";
          },
        },
      ),
    ).toThrow("spawn2.0 FP escalation failed with HTTP 409");
  });
});
