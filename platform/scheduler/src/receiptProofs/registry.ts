import type { ReceiptProof } from "../classes/types.js";
import { evaluateExitZero } from "./exitZero.js";
import { evaluateHttp2xx } from "./http2xx.js";
import { evaluateSessionReplyPresent } from "./sessionReplyPresent.js";
import { evaluateSessionReplyContentCheck } from "./sessionReplyContentCheck.js";
import { evaluateExternalEvidence } from "./externalEvidence/index.js";
import type { ProofContext, ProofResult } from "./types.js";

export async function evaluateProof(
  proof: ReceiptProof,
  ctx: ProofContext
): Promise<ProofResult> {
  switch (proof.kind) {
    case "exit_zero":
      return evaluateExitZero({ exitCode: ctx.exitCode });
    case "http_2xx":
      return evaluateHttp2xx({ httpStatus: ctx.httpStatus });
    case "session_reply_present":
      return evaluateSessionReplyPresent({
        childSessionId: ctx.childSessionId,
        asyncRef: ctx.asyncRef,
        smBaseUrl: ctx.smBaseUrl,
        fetchImpl: ctx.fetchImpl,
        timeoutMs: proof.timeoutMs,
      });
    case "session_reply_content_check":
      return evaluateSessionReplyContentCheck({
        childSessionId: ctx.childSessionId,
        asyncRef: ctx.asyncRef,
        smBaseUrl: ctx.smBaseUrl,
        fetchImpl: ctx.fetchImpl,
        pattern: proof.pattern,
        patternType: proof.patternType,
        timeoutMs: proof.timeoutMs,
      });
    case "external_evidence":
      return evaluateExternalEvidence({ proof, ctx });
  }
}
