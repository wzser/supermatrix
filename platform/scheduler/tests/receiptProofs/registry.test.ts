import { describe, it, expect } from "vitest";
import { evaluateProof } from "../../src/receiptProofs/registry.js";

describe("evaluateProof (async)", () => {
  it("returns a Promise for exit_zero", async () => {
    const result = await evaluateProof(
      { kind: "exit_zero" },
      { exitCode: 0, taskId: "t", runId: "r", triggeredAt: 0 }
    );
    expect(result.passed).toBe(true);
  });

  it("returns a Promise for http_2xx", async () => {
    const result = await evaluateProof(
      { kind: "http_2xx" },
      { httpStatus: 200, taskId: "t", runId: "r", triggeredAt: 0 }
    );
    expect(result.passed).toBe(true);
  });

  it("keeps session_reply_present stub-safe when no deps provided", async () => {
    const result = await evaluateProof(
      { kind: "session_reply_present", timeoutMs: 300000 },
      { taskId: "t", runId: "r", triggeredAt: 0 }
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toHaveProperty("note");
  });
});
