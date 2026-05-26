import type { Logger } from "../../ports/Logger.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
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

export type BootCheckContext = {
  cfg: BootCheckConfig;
  logger: Logger;
  processLister: ProcessLister;
  store?: BindingStore;
  /** Returns the PID of the live shared kimi acp process, or null if kimi is not in use. */
  getKimiAcpPid?: () => number | null;
};

export type BootCheck = {
  name: string;
  phases: CheckPhase[];
  run(ctx: BootCheckContext, mode: CheckMode): Promise<CheckResult>;
};
