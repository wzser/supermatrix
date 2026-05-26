import type { ProofResult } from "./types.js";

export function evaluateHttp2xx(ctx: { httpStatus: number | undefined }): ProofResult {
  if (ctx.httpStatus === undefined) {
    return {
      passed: false,
      retriable: true,
      evidence: { httpStatus: null, note: "no response yet" },
    };
  }
  const ok = ctx.httpStatus >= 200 && ctx.httpStatus < 300;
  return { passed: ok, retriable: false, evidence: { httpStatus: ctx.httpStatus } };
}
