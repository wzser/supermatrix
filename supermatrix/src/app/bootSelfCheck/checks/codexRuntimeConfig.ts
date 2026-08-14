import type { ReconcileSummary } from "../../reconcileCodexRuntimeConfigs.ts";
import type { BootCheck } from "../types.ts";

export function createCodexRuntimeConfigCheck(deps: {
  reconcile: () => Promise<ReconcileSummary>;
}): BootCheck {
  return {
    name: "codex-runtime-config",
    phases: ["post-wiring"],
    async run() {
      try {
        const summary = await deps.reconcile();
        const message = formatSummary(summary);
        // verifiedDefault===null means no bundled model was confirmed available
        // (transient evidence, all candidates confirmed unavailable, or the probe
        // skipped because an sm-switch route serves the runs): the service may not
        // be safely ready for a future model=null/new session, so warn even when
        // there are no default-dependent rows and every count is zero. A skip is
        // reported as a skip with its route reason — never as a clean run.
        const hasProblems = summary.clamped > 0 || summary.fallbackModel > 0
          || summary.conflict > 0 || summary.failed > 0 || summary.verifiedDefault === null;
        return hasProblems
          ? { name: "codex-runtime-config", status: "warn", message, detail: summary }
          : { name: "codex-runtime-config", status: "ok", detail: summary };
      } catch (error) {
        return {
          name: "codex-runtime-config",
          status: "warn",
          message: `Codex runtime config reconciliation exception: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function formatSummary(summary: ReconcileSummary): string {
  const parts = [
    `unchanged=${summary.unchanged}`,
    `clamped=${summary.clamped}`,
    `fallbackModel=${summary.fallbackModel}`,
    `conflict=${summary.conflict}`,
    `failed=${summary.failed}`,
  ];
  for (const kind of ["clamped", "fallbackModel", "conflict", "failed"] as const) {
    const names = summary.problems[kind];
    if (names && names.length > 0) parts.push(`${kind}: ${names.join(", ")}`);
  }
  if (summary.verifiedDefault === null) {
    parts.push(
      summary.defaultVerificationSkipped
        ? `verifiedDefault=skipped (${summary.defaultVerificationSkipped})`
        : "verifiedDefault=none",
    );
  }
  const counts = parts.splice(0, 5).join(" ");
  return [counts, ...parts].join("; ");
}
