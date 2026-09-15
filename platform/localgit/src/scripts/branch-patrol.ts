import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyPatrolAction,
  inventoryRepo,
  type BranchInventory,
  type PatrolHistoryRow,
} from "./branch-patrol-core.js";
import {
  dispatchPatrolOwnerHint,
  loadPatrolOwnerNotificationHistory,
  patrolOwnerHintCandidate,
} from "./branch-patrol-owner-hint.js";
import { businessDate, loadDailyCommitGovernedRepos } from "./localgit-context.js";
import { loadRepoPolicy, REPO_POLICIES_DIR, type RepoPolicy } from "./daily-commit-judgment-matrix.js";

const EVIDENCE_FILE = join(process.cwd(), "data", "branch-patrol.jsonl");
const STATE_FILE = join(process.cwd(), "data", "run-state", "latest-branch-patrol.json");

// Per-repo branch policy cache (registry/repo-policies/<repo>.json); missing or
// malformed manifests behave as "no branch policy" — patrol never fails on them.
const branchPolicyCache = new Map<string, RepoPolicy | null>();
function loadBranchPolicy(repo: string): RepoPolicy | null {
  if (!branchPolicyCache.has(repo)) {
    const { policy } = loadRepoPolicy(REPO_POLICIES_DIR, repo);
    branchPolicyCache.set(repo, policy);
  }
  return branchPolicyCache.get(repo) ?? null;
}

function readPatrolHistoryRows(): PatrolHistoryRow[] {
  if (!existsSync(EVIDENCE_FILE)) return [];
  return readFileSync(EVIDENCE_FILE, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as PatrolHistoryRow];
    } catch {
      return [];
    }
  });
}

function writeState(state: { runId: string; mode: "report" | "apply"; inventory: BranchInventory[]; inventoryErrors: string[] }): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, STATE_FILE);
}

const rawMode = process.env.LOCALGIT_BRANCH_PATROL_MODE ?? "report";
if (rawMode !== "report" && rawMode !== "apply") throw new Error(`invalid LOCALGIT_BRANCH_PATROL_MODE=${rawMode}`);
const mode = rawMode;
const autoDocsMerge = process.env.LOCALGIT_BRANCH_PATROL_AUTO_DOCS_MERGE !== "false";
const runId = `branch-patrol-${new Date().toISOString()}`;
const date = businessDate();
const selected = loadDailyCommitGovernedRepos();
if (selected.repos.length === 0) {
  writeState({ runId, mode, inventory: [], inventoryErrors: ["no eligible repositories; verify managed role affiliation and Git workdir configuration"] });
  console.error("[branch-patrol] no eligible repositories; verify managed role affiliation and Git workdir configuration");
  process.exit(2);
}
const historyRows = readPatrolHistoryRows();
const inventory: BranchInventory[] = [];
const inventoryErrors: string[] = [];
const ownerHints = { sent: 0, suppressed: 0, failed: 0 };
let ownerHistory: ReturnType<typeof loadPatrolOwnerNotificationHistory> | undefined;
mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
appendFileSync(EVIDENCE_FILE, "");

for (const repo of selected.repos) {
  let items: BranchInventory[];
  try {
    items = inventoryRepo(repo, { history: historyRows });
  } catch (error) {
    const message = `${repo.name}: ${(error as Error).message}`;
    inventoryErrors.push(message);
    console.error(`[branch-patrol] ${message}`);
    continue;
  }
  inventory.push(...items);
  const trunkAdvanceOwnerOnly = loadBranchPolicy(repo.name)?.branch_policy?.trunk_advance === "owner_only";
  for (const item of items) {
    const evidence = applyPatrolAction(item, mode, { autoDocsMerge, trunkAdvanceOwnerOnly });
    appendFileSync(EVIDENCE_FILE, JSON.stringify({
      run_id: runId,
      recorded_at: new Date().toISOString(),
      ...evidence,
    }) + "\n");
    if (mode !== "apply") continue;
    const candidate = patrolOwnerHintCandidate(item, evidence);
    if (!candidate) continue;
    try {
      ownerHistory ??= loadPatrolOwnerNotificationHistory();
      ownerHints[dispatchPatrolOwnerHint({ date, runId, item, candidate, history: ownerHistory })] += 1;
    } catch (error) {
      ownerHints.failed += 1;
      console.error(`[branch-patrol] owner hint failed for ${repo.name}:${item.branch}: ${(error as Error).message}`);
    }
  }
}

writeState({ runId, mode, inventory, inventoryErrors });
console.log(JSON.stringify({
  run_id: runId,
  mode,
  auto_docs_merge: autoDocsMerge,
  governed_sessions: selected.governedSessionCount,
  eligible_repos: selected.repos.length,
  branches: inventory.length,
  inventory_errors: inventoryErrors,
  owner_hints: ownerHints,
  warning: inventory.length === 0 ? "no non-trunk branches enumerated" : undefined,
}, null, 2));
