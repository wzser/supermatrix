import type { ReceiptProof } from "../../classes/types.js";
import type { ProofContext, ProofResult } from "../types.js";
import { evaluateSqlite } from "./sqlite.js";
import { evaluateFile } from "./file.js";
import { evaluateHttpGet } from "./httpGet.js";
import { evaluateBitable } from "./bitable.js";

type Deps = {
  proof: ReceiptProof & { kind: "external_evidence" };
  ctx: ProofContext;
};

export async function evaluateExternalEvidence(deps: Deps): Promise<ProofResult> {
  const { proof, ctx } = deps;
  const common = {
    target: proof.target,
    expectation: proof.expectation,
    triggeredAt: ctx.triggeredAt,
  };
  switch (proof.engine) {
    case "sqlite": {
      const hasTarget = typeof proof.target?.db === "string" && typeof proof.target?.sql === "string";
      if (!hasTarget && ctx.exitCode === 0) {
        return { passed: true, retriable: false, evidence: { exitCode: 0, note: "sqlite target unconfigured; passed on exit_zero fallback" } };
      }
      return evaluateSqlite(common);
    }
    case "file":
      return evaluateFile(common);
    case "http_get":
      return evaluateHttpGet({ ...common, fetchImpl: ctx.fetchImpl });
    case "bitable":
      return evaluateBitable();
  }
}
