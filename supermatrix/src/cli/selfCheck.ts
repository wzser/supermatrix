import { validateEnv } from "./bootstrap.ts";
import { SqliteBindingStore } from "../adapters/store-sqlite/index.ts";
import { createPinoLogger } from "../adapters/logger-pino/index.ts";
import { createPsProcessLister } from "../adapters/process-lister-ps/index.ts";
import { runChecks, hasFail } from "../app/bootSelfCheck/index.ts";
import { localDepsCheck } from "../app/bootSelfCheck/checks/localDeps.ts";
import { supervisorPresenceCheck } from "../app/bootSelfCheck/checks/supervisorPresence.ts";
import { schedulerHealthCheck } from "../app/bootSelfCheck/checks/schedulerHealth.ts";
import { reconcileBackendProcessesCheck } from "../app/bootSelfCheck/checks/reconcileBackendProcesses.ts";
import { renderLarkSelfCheckMessage } from "../app/bootSelfCheck/formatReport.ts";

async function main() {
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
  process.exit(hasFail(all) ? 1 : 0);
}

main().catch((err) => {
  console.error("[self-check] fatal:", err);
  process.exit(2);
});
