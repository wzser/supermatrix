import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyPatrolAction, inventoryRepo, type BranchInventory } from "./branch-patrol-core.js";
import { loadDailyCommitGovernedRepos } from "./localgit-context.js";

const EVIDENCE_FILE = join(process.cwd(), "data", "branch-patrol.jsonl");
const STATE_FILE = join(process.cwd(), "data", "run-state", "latest-branch-patrol.json");

function writeState(state: { runId: string; mode: "report" | "apply"; inventory: BranchInventory[]; inventoryErrors: string[] }): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, STATE_FILE);
}

const rawMode = process.env.LOCALGIT_BRANCH_PATROL_MODE ?? "report";
if (rawMode !== "report" && rawMode !== "apply") throw new Error(`invalid LOCALGIT_BRANCH_PATROL_MODE=${rawMode}`);
const mode = rawMode;
const runId = `branch-patrol-${new Date().toISOString()}`;
const selected = loadDailyCommitGovernedRepos();
const inventory: BranchInventory[] = [];
const inventoryErrors: string[] = [];
mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
appendFileSync(EVIDENCE_FILE, "");

for (const repo of selected.repos) {
  let items: BranchInventory[];
  try {
    items = inventoryRepo(repo);
  } catch (error) {
    const message = `${repo.name}: ${(error as Error).message}`;
    inventoryErrors.push(message);
    console.error(`[branch-patrol] ${message}`);
    continue;
  }
  inventory.push(...items);
  for (const item of items) {
    const evidence = applyPatrolAction(item, mode);
    appendFileSync(EVIDENCE_FILE, JSON.stringify({
      run_id: runId,
      recorded_at: new Date().toISOString(),
      ...evidence,
    }) + "\n");
  }
}

writeState({ runId, mode, inventory, inventoryErrors });
console.log(JSON.stringify({
  run_id: runId,
  mode,
  governed_sessions: selected.governedSessionCount,
  eligible_repos: selected.repos.length,
  branches: inventory.length,
  inventory_errors: inventoryErrors,
  warning: inventory.length === 0 ? "no non-trunk branches enumerated" : undefined,
}, null, 2));
