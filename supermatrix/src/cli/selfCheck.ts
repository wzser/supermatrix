import { pathToFileURL } from "node:url";
import { validateEnv } from "./bootstrap.ts";
import { SqliteBindingStore } from "../adapters/store-sqlite/index.ts";
import { createPinoLogger } from "../adapters/logger-pino/index.ts";
import { createPsProcessLister } from "../adapters/process-lister-ps/index.ts";
import { runChecks, hasFail } from "../app/bootSelfCheck/index.ts";
import type {
  BootCheck,
  BootCheckContext,
  CheckResult,
} from "../app/bootSelfCheck/types.ts";
import { localDepsCheck } from "../app/bootSelfCheck/checks/localDeps.ts";
import { supervisorPresenceCheck } from "../app/bootSelfCheck/checks/supervisorPresence.ts";
import { schedulerHealthCheck } from "../app/bootSelfCheck/checks/schedulerHealth.ts";
import { reconcileBackendProcessesCheck } from "../app/bootSelfCheck/checks/reconcileBackendProcesses.ts";
import { renderLarkSelfCheckMessage } from "../app/bootSelfCheck/formatReport.ts";
import { errorMessage } from "../app/errorMessage.ts";
import { CODEX_MODEL_ALIASES } from "../app/commands/setModel.ts";
import { SAFE_CODEX_MODEL_FALLBACKS } from "../ports/CodexModelCatalog.ts";
import type { Logger } from "../ports/Logger.ts";
import { createCliCompatibilityChecks } from "./cliCompatibilityChecks.ts";

const CLI_UPGRADE_SCHEMA_VERSION = 1;

export type CliUpgradeProfileReport = {
  schemaVersion: 1;
  profile: "cli-upgrade";
  mode: "observe";
  ok: boolean;
  checks: CheckResult[];
  error?: {
    code: "SELF_CHECK_FATAL";
    message: string;
  };
};

export async function runCliUpgradeProfile(
  input: {
    checks?: BootCheck[];
    ctx?: BootCheckContext;
  } = {},
): Promise<{ report: CliUpgradeProfileReport; exitCode: 0 | 1 }> {
  const results = decorateCliUpgradeResults(
    await runChecks(
      "pre-wiring",
      "observe",
      input.ctx ?? createCliUpgradeContext(),
      input.checks ?? createCliCompatibilityChecks(),
    ),
  );
  const failed = hasFail(results);
  return {
    report: {
      schemaVersion: CLI_UPGRADE_SCHEMA_VERSION,
      profile: "cli-upgrade",
      mode: "observe",
      ok: !failed,
      checks: results,
    },
    exitCode: failed ? 1 : 0,
  };
}

function decorateCliUpgradeResults(results: CheckResult[]): CheckResult[] {
  return results.map((result) => {
    if (result.name !== "codex-default-model" || !result.detail) return result;
    const resolvedDefaultSlug =
      typeof result.detail["slug"] === "string"
        ? result.detail["slug"].trim()
        : typeof result.detail["fallbackSlug"] === "string"
          ? result.detail["fallbackSlug"].trim()
          : "";
    const referencedModels = [
      ...new Set([
        ...Object.values(CODEX_MODEL_ALIASES),
        ...SAFE_CODEX_MODEL_FALLBACKS,
        ...(resolvedDefaultSlug ? [resolvedDefaultSlug] : []),
      ]),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return {
      ...result,
      detail: {
        ...result.detail,
        referencedModels,
      },
    };
  });
}

async function runFullSelfCheck(): Promise<number> {
  const cfg = validateEnv(process.env);
  const logger = createPinoLogger("info");
  const processLister = createPsProcessLister();

  // Note: this standalone CLI uses observe mode for the reconciler so
  // running it while bootstrap is alive does not kill its children.
  const preChecks = [
    localDepsCheck,
    // dual-instance is skipped here — it would always fail if bootstrap
    // is live, and pass but dangerously in subtle ways if it's not.
    supervisorPresenceCheck,
    schedulerHealthCheck,
  ];
  const preResults = await runChecks(
    "pre-wiring",
    "observe",
    { cfg, logger, processLister },
    preChecks,
  );

  const store = new SqliteBindingStore(cfg.dbPath);
  await store.init();
  const postResults = await runChecks(
    "post-wiring",
    "observe",
    { cfg, logger, processLister, store },
    [reconcileBackendProcessesCheck],
  );
  await store.close();

  const all = [...preResults, ...postResults];
  process.stdout.write(renderLarkSelfCheckMessage(all) + "\n");
  return hasFail(all) ? 1 : 0;
}

async function main(args: string[]): Promise<number> {
  if (isCliUpgradeProfile(args)) {
    const { report, exitCode } = await runCliUpgradeProfile();
    process.stdout.write(JSON.stringify(report) + "\n");
    return exitCode;
  }
  if (args.length > 0) {
    throw new Error(`unknown self-check arguments: ${args.join(" ")}`);
  }
  return runFullSelfCheck();
}

function createCliUpgradeContext(): BootCheckContext {
  return {
    cfg: {
      larkCliPath: process.env["SM_LARK_CLI_PATH"] ?? "",
      dbPath: process.env["SM_DB_PATH"] ?? "",
      workspaceRoot: process.env["SM_WORKSPACE_ROOT"] ?? process.cwd(),
    },
    logger: silentLogger,
    processLister: createPsProcessLister(),
  };
}

function isCliUpgradeProfile(args: string[]): boolean {
  return args.length === 2 && args[0] === "--profile" && args[1] === "cli-upgrade";
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function fatalCliUpgradeReport(err: unknown): CliUpgradeProfileReport {
  return {
    schemaVersion: CLI_UPGRADE_SCHEMA_VERSION,
    profile: "cli-upgrade",
    mode: "observe",
    ok: false,
    checks: [],
    error: {
      code: "SELF_CHECK_FATAL",
      message: errorMessage(err),
    },
  };
}

const directEntry = process.argv[1];
if (directEntry && import.meta.url === pathToFileURL(directEntry).href) {
  const args = process.argv.slice(2);
  main(args)
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      if (isCliUpgradeProfile(args)) {
        process.stdout.write(JSON.stringify(fatalCliUpgradeReport(err)) + "\n");
      } else {
        console.error("[self-check] fatal:", err);
      }
      process.exit(2);
    });
}
