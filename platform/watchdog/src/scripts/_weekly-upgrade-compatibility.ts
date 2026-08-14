import { spawnSync } from "node:child_process";

export type CliUpgradeCheckResult = {
  name: string;
  status: "ok" | "info" | "warn" | "fail";
  message?: string;
  detail?: Record<string, unknown>;
};

export type CliUpgradeCompatibilityReport = {
  schemaVersion: 1;
  profile: "cli-upgrade";
  mode: "observe";
  ok: boolean;
  checks: CliUpgradeCheckResult[];
  error?: {
    code: "SELF_CHECK_FATAL";
    message: string;
  };
};

export type CliUpgradeCompatibilityAssessment = {
  status: "pass" | "adjustment-required" | "fail";
  requiresAdjustment: boolean;
  adjustmentReasons: string[];
  rollbackClis: Array<"codex" | "kimi-code" | "lark-cli">;
  error?: string;
};

const CODEX_ALIAS_DRIFT_REASON = "CODEX_ALIAS_CATALOG_DRIFT";
const CHECK_STATUSES = new Set(["ok", "info", "warn", "fail"]);
const NPM_BIN = "/usr/local/bin/npm";
const SUPERMATRIX_DIR = "/Users/LOCAL_USER/SuperMatrix";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type CliUpgradeCompatibilityCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CliUpgradeCompatibilityRun =
  | { kind: "ok"; report: CliUpgradeCompatibilityReport }
  | { kind: "fail"; error: string; report?: CliUpgradeCompatibilityReport };

function defaultCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
): ReturnType<CliUpgradeCompatibilityCommandRunner> {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * The SuperMatrix cli-upgrade profile is a machine-readable JSON contract.
 * Kimi ACP's bootstrap currently emits one util.inspect launch block to
 * stdout before that report. Accept only that exact-shaped preamble so the
 * weekly transaction remains fail-closed for every other unexpected output.
 */
function stripKnownKimiAcpLaunchPreamble(stdout: string): string {
  const reportStart = stdout.lastIndexOf('\n{"schemaVersion":');
  if (reportStart <= 0) return stdout;

  const preamble = stdout.slice(0, reportStart).trimEnd();
  const lines = preamble.split(/\r?\n/u);
  if (
    lines[0] !== "[kimi-acp launch] {"
    || lines.at(-1) !== "}"
    || !lines.slice(1, -1).some((line) => /^\s+command:/u.test(line))
    || !lines.slice(1, -1).some((line) => /^\s+args:/u.test(line))
    || !lines.slice(1, -1).some((line) => /^\s+pid:/u.test(line))
  ) {
    return stdout;
  }

  return stdout.slice(reportStart + 1);
}

export function runCliUpgradeCompatibilityCheck(
  runCommand: CliUpgradeCompatibilityCommandRunner = defaultCommandRunner,
): CliUpgradeCompatibilityRun {
  const result = runCommand(
    NPM_BIN,
    ["run", "--silent", "self-check", "--", "--profile", "cli-upgrade"],
    {
      cwd: SUPERMATRIX_DIR,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  let report: CliUpgradeCompatibilityReport | undefined;
  try {
    report = parseCliUpgradeCompatibilityReport(stripKnownKimiAcpLaunchPreamble(result.stdout));
  } catch (error) {
    return {
      kind: "fail",
      error: `cli-upgrade self-check returned invalid JSON: ${(error as Error).message}`.slice(0, 300),
    };
  }
  if (report.error) {
    return {
      kind: "fail",
      error: `cli-upgrade self-check fatal: ${report.error.message}`.slice(0, 300),
      report,
    };
  }
  const presentChecks = new Set(report.checks.map(({ name }) => name));
  for (const required of ["codex-default-model", "kimi-acp-health"]) {
    if (!presentChecks.has(required)) {
      return {
        kind: "fail",
        error: `cli-upgrade self-check is missing required check: ${required}`,
        report,
      };
    }
  }
  const hasFail = report.checks.some(({ status }) => status === "fail");
  if (report.ok === hasFail) {
    return {
      kind: "fail",
      error: "cli-upgrade self-check report ok/check status mismatch",
      report,
    };
  }
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    return {
      kind: "fail",
      error: `cli-upgrade self-check failed: ${detail}`.slice(0, 300),
      report,
    };
  }
  if (!report.ok) {
    return {
      kind: "fail",
      error: "cli-upgrade self-check reported ok=false with exit 0",
      report,
    };
  }
  return { kind: "ok", report };
}

export function runCliUpgradeCompatibilityPostCheck(
  runCheck: () => CliUpgradeCompatibilityRun = () => runCliUpgradeCompatibilityCheck(),
): {
  run: CliUpgradeCompatibilityRun;
  attempts: 1 | 2;
  firstFailure?: string;
} {
  const first = runCheck();
  if (first.kind !== "fail" || first.report) {
    return { run: first, attempts: 1 };
  }
  return {
    run: runCheck(),
    attempts: 2,
    firstFailure: first.error,
  };
}

export function parseCliUpgradeCompatibilityReport(
  raw: string,
): CliUpgradeCompatibilityReport {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cli-upgrade self-check returned a non-object report");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate["schemaVersion"] !== 1
    || candidate["profile"] !== "cli-upgrade"
    || candidate["mode"] !== "observe"
    || typeof candidate["ok"] !== "boolean"
    || !Array.isArray(candidate["checks"])
  ) {
    throw new Error("cli-upgrade self-check report has an unsupported schema");
  }
  const checks = candidate["checks"].map((value): CliUpgradeCheckResult => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("cli-upgrade self-check contains an invalid result");
    }
    const result = value as Record<string, unknown>;
    if (
      typeof result["name"] !== "string"
      || typeof result["status"] !== "string"
      || !CHECK_STATUSES.has(result["status"])
    ) {
      throw new Error("cli-upgrade self-check result is missing name/status");
    }
    const detail = result["detail"];
    return {
      name: result["name"],
      status: result["status"] as CliUpgradeCheckResult["status"],
      ...(typeof result["message"] === "string" ? { message: result["message"] } : {}),
      ...(detail && typeof detail === "object" && !Array.isArray(detail)
        ? { detail: detail as Record<string, unknown> }
        : {}),
    };
  });
  const rawError = candidate["error"];
  const error = rawError && typeof rawError === "object" && !Array.isArray(rawError)
    ? rawError as Record<string, unknown>
    : undefined;
  return {
    schemaVersion: 1,
    profile: "cli-upgrade",
    mode: "observe",
    ok: candidate["ok"],
    checks,
    ...(error?.["code"] === "SELF_CHECK_FATAL" && typeof error["message"] === "string"
      ? {
          error: {
            code: "SELF_CHECK_FATAL" as const,
            message: error["message"],
          },
        }
      : {}),
  };
}

export function assessCliUpgradeCompatibility(
  before: CliUpgradeCompatibilityReport,
  after: CliUpgradeCompatibilityReport,
): CliUpgradeCompatibilityAssessment {
  const beforeByName = new Map(before.checks.map((result) => [result.name, result]));
  const adjustmentReasons = after.checks.flatMap((result) =>
    result.name === "codex-default-model"
      && result.status === "warn"
      && result.detail?.["reasonCode"] === CODEX_ALIAS_DRIFT_REASON
      ? [CODEX_ALIAS_DRIFT_REASON]
      : []
  );
  const newFailures = after.checks.filter((result) => {
    const beforeStatus = beforeByName.get(result.name)?.status;
    if (result.status === "fail" && beforeStatus !== "fail") return true;
    if (
      result.status !== "warn"
      || beforeStatus === "warn"
      || beforeStatus === "fail"
    ) {
      return false;
    }
    if (result.name === "kimi-acp-health") return true;
    return result.name === "codex-default-model"
      && !(
        isNonEmptyString(result.detail?.["fallbackSlug"])
        || (
          result.detail?.["reasonCode"] === CODEX_ALIAS_DRIFT_REASON
          && isNonEmptyString(result.detail["slug"])
        )
      );
  });
  const rollbackClis = newFailures.flatMap(
    (result): Array<"codex" | "kimi-code"> =>
      result.name === "codex-default-model"
        ? ["codex"]
        : result.name === "kimi-acp-health"
          ? ["kimi-code"]
          : [],
  );

  if (newFailures.length > 0) {
    return {
      status: "fail",
      requiresAdjustment: adjustmentReasons.length > 0,
      adjustmentReasons,
      rollbackClis,
      error: newFailures
        .map((result) => `${result.name}: ${result.message ?? "failed"}`)
        .join("; "),
    };
  }

  return {
    status: adjustmentReasons.length > 0 ? "adjustment-required" : "pass",
    requiresAdjustment: adjustmentReasons.length > 0,
    adjustmentReasons,
    rollbackClis: [],
  };
}

function failedCompatibilityAssessment(
  error: string,
): CliUpgradeCompatibilityAssessment {
  return {
    status: "fail",
    requiresAdjustment: false,
    adjustmentReasons: [],
    rollbackClis: [],
    error: error.slice(0, 300),
  };
}

export function assessCliUpgradeCompatibilityRuns(
  before: CliUpgradeCompatibilityRun,
  after: CliUpgradeCompatibilityRun,
): CliUpgradeCompatibilityAssessment {
  if (before.kind !== "ok") {
    return failedCompatibilityAssessment(
      `pre-upgrade compatibility check failed: ${before.error}`,
    );
  }
  if (after.kind === "fail") {
    if (!after.report || after.report.ok || after.report.error) {
      return failedCompatibilityAssessment(
        `post-upgrade compatibility check failed: ${after.error}`,
      );
    }
    const assessment = assessCliUpgradeCompatibility(before.report, after.report);
    return assessment.status === "fail"
      ? assessment
      : failedCompatibilityAssessment(
          `post-upgrade compatibility check failed: ${after.error}`,
        );
  }
  return assessCliUpgradeCompatibility(before.report, after.report);
}

export function formatCliUpgradeCompatibilityAssessment(
  assessment: CliUpgradeCompatibilityAssessment,
  recovery?: CliUpgradeCompatibilityRun,
): string[] {
  return [
    `status: ${assessment.status}`,
    `source adjustment: ${assessment.adjustmentReasons.length > 0 ? assessment.adjustmentReasons.join(", ") : "none"}`,
    `rollback: ${assessment.rollbackClis.length > 0 ? assessment.rollbackClis.join(", ") : "none"}`,
    ...(assessment.error ? [`error: ${assessment.error}`] : []),
    ...(recovery
      ? [`recovery check: ${recovery.kind === "ok" ? "pass" : `fail (${recovery.error})`}`]
      : []),
  ];
}

export function extractCodexReferencedModels(
  report: CliUpgradeCompatibilityReport,
): string[] {
  const detail = report.checks.find(({ name }) => name === "codex-default-model")?.detail;
  const effectiveDefault = typeof detail?.["slug"] === "string" && detail["slug"].length > 0
    ? [detail["slug"]]
    : [];
  const referencedModels = Array.isArray(detail?.["referencedModels"])
    ? detail["referencedModels"].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const aliasTargets = Array.isArray(detail?.["aliases"])
    ? detail["aliases"].flatMap((value): string[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const target = (value as Record<string, unknown>)["target"];
        return typeof target === "string" && target.length > 0 ? [target] : [];
      })
    : [];
  return [...new Set([
    ...effectiveDefault,
    ...referencedModels,
    ...aliasTargets,
  ])].sort();
}
