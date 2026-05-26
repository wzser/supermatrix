import type { ProofResult } from "./types.js";

export function evaluateExitZero(ctx: { exitCode: number | null | undefined }): ProofResult {
  if (ctx.exitCode === null || ctx.exitCode === undefined) {
    return {
      passed: false,
      retriable: true,
      evidence: { exitCode: null, note: "process still running" },
    };
  }
  if (ctx.exitCode === 0) {
    return { passed: true, retriable: false, evidence: { exitCode: 0 } };
  }
  return { passed: false, retriable: false, evidence: { exitCode: ctx.exitCode } };
}
