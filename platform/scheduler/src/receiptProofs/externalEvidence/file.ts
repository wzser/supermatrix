import { statSync } from "node:fs";
import type { ProofResult } from "../types.js";
import { parseExpectation, evaluateNumeric, evaluateMtimeVsTrigger } from "./expectation.js";

type Deps = {
  target: Record<string, unknown>;
  expectation: string;
  triggeredAt: number;
};

export async function evaluateFile(deps: Deps): Promise<ProofResult> {
  const path = typeof deps.target.path === "string" ? deps.target.path : undefined;
  if (!path) {
    return { passed: false, retriable: false, evidence: { note: "file engine requires target.path" } };
  }

  let exp;
  try {
    exp = parseExpectation(deps.expectation);
  } catch (err) {
    return { passed: false, retriable: false, evidence: { note: "invalid expectation", error: String(err) } };
  }

  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return { passed: false, retriable: false, evidence: { note: "file not found", path, error: String(err) } };
  }

  if (exp.kind === "mtime_gt_trigger") {
    const mtimeMs = Math.floor(stat.mtimeMs);
    const ok = evaluateMtimeVsTrigger(mtimeMs, deps.triggeredAt);
    return { passed: ok, retriable: false, evidence: { mtimeMs, triggeredAt: deps.triggeredAt } };
  }
  if (exp.kind === "numeric") {
    const size = stat.size;
    const ok = evaluateNumeric(size, exp);
    return { passed: ok, retriable: false, evidence: { sizeBytes: size, expectation: deps.expectation } };
  }
  return { passed: false, retriable: false, evidence: { note: "unsupported expectation for file engine" } };
}
