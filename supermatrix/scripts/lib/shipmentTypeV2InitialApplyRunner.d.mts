export type InitialApplyRequest = {
  command_id: "shipment_type_v2.initial_apply.v1";
  idempotency_key: string;
  approved_report_ref: string;
};

export type NarrowCommandReceipt = {
  run_id: string | null;
  status: "succeeded" | "failed" | "running" | "rejected";
  report_path: string | null;
  report_hash: string | null;
  error_phase: "request_validation" | "secret_alias_unavailable" | "spawn" | "child_exit" | "receipt_persist" | null;
};

export type FixedChildSpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  stdio: ["ignore", "ignore", "ignore"];
};

export type FixedChild = {
  once(event: "error" | "close", listener: (...args: unknown[]) => void): FixedChild;
};

export type InitialApplyExecutionDeps = {
  ledgerPath: string;
  reportDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  spawnChild: (file: string, argv: string[], options: FixedChildSpawnOptions) => FixedChild;
  now?: () => number;
  createRunId?: () => string;
};

export const SHIPMENT_TYPE_V2_INITIAL_APPLY_MANIFEST: Readonly<{
  commandId: "shipment_type_v2.initial_apply.v1";
  ownerSession: "huojianwang2hao";
  secretAlias: "replenishment_execution";
  secretEnv: "SHIPMENT_JUDGE_BASE_TOKEN";
  argv: readonly ["node", "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/huojianwang2hao/rules/shipment-type-v2/runtime/shipment-judge.mjs", "--mode", "apply", "--all"];
}>;

export function parseShipmentTypeV2InitialApplyRequest(raw: unknown): InitialApplyRequest;
export function buildShipmentTypeV2InitialApplyEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> | null;
export function executeShipmentTypeV2InitialApply(
  request: InitialApplyRequest,
  deps: InitialApplyExecutionDeps,
): Promise<NarrowCommandReceipt>;
