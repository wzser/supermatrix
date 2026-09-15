import type {
  BootCheck,
  BootCheckContext,
  CheckMode,
  CheckPhase,
  CheckResult,
} from "./types.ts";

export * from "./types.ts";

export async function runChecks(
  phase: CheckPhase,
  mode: CheckMode,
  ctx: BootCheckContext,
  checks: BootCheck[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (!check.phases.includes(phase)) continue;
    const res = await check.run(ctx, mode);
    results.push(res);
    if (res.status === "fail") break; // short-circuit
  }
  return results;
}

export function hasFail(results: CheckResult[]): boolean {
  return results.some((r) => r.status === "fail");
}

export function warnsOnly(results: CheckResult[]): Array<Extract<CheckResult, { status: "warn" }>> {
  return results.filter((r): r is Extract<CheckResult, { status: "warn" }> => r.status === "warn");
}
