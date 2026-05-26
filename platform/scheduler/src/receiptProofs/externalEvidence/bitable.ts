import type { ProofResult } from "../types.js";

export async function evaluateBitable(): Promise<ProofResult> {
  return {
    passed: false,
    retriable: false,
    evidence: { note: "bitable engine deferred to Plan 3 (needs lark-cli + chat_id access)" },
  };
}
