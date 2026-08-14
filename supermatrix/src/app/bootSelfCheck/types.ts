import type { Logger } from "../../ports/Logger.ts";
import type { BindingStore, BootOrphanedSpawnComm } from "../../ports/BindingStore.ts";
import type { ProcessLister } from "../../ports/processLister.ts";

export type CheckPhase = "pre-wiring" | "post-wiring" | "runtime";
export type CheckMode = "execute" | "observe";

export type CheckResult =
  | { name: string; status: "ok"; detail?: Record<string, unknown> }
  | { name: string; status: "info"; message: string; detail?: Record<string, unknown> }
  | { name: string; status: "warn"; message: string; detail?: Record<string, unknown> }
  | { name: string; status: "fail"; message: string; detail?: Record<string, unknown> };

// Narrower than cli/bootstrap.ts AppConfig so that the app layer stays
// independent of cli. bootstrap.ts passes its AppConfig here; structural
// typing accepts it because AppConfig has all of these fields as string.
// localDeps check may mutate larkCliPath in place for PATH fallback repair.
export type BootCheckConfig = {
  larkCliPath: string;
  dbPath: string;
  workspaceRoot: string;
};

export type RestartProvenance = {
  version: 1;
  restartId: string;
  requestedAtMs: number;
  source: string;
  reason: string;
  path: string;
  signal?: string;
  requesterPid?: number;
  targetPid?: number;
};

export type BootCheckContext = {
  cfg: BootCheckConfig;
  logger: Logger;
  processLister: ProcessLister;
  store?: BindingStore;
  /** Returns the PID of the live shared kimi acp process, or null if kimi is not in use. */
  getKimiAcpPid?: () => number | null;
  /** Collects caller notices after an orphaned child spawn is terminalized at boot. */
  onBootOrphanedSpawnComm?: (comm: BootOrphanedSpawnComm) => void;
  /** One-shot provenance recorded by the process or supervisor before this boot. */
  restartProvenance?: RestartProvenance;
};

export type BootCheck = {
  name: string;
  phases: CheckPhase[];
  run(ctx: BootCheckContext, mode: CheckMode): Promise<CheckResult>;
};
