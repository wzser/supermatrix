import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BranchInventory, PatrolEvidence } from "./branch-patrol-core.js";

export type RecordedPatrolEvidence = PatrolEvidence & { run_id: string; recorded_at?: string };
export type PatrolRunState = {
  runId: string;
  mode?: "report" | "apply";
  inventory: BranchInventory[];
  inventoryErrors?: string[];
};

export type PatrolVerifierDeps = {
  branchHead(path: string, branch: string): string | undefined;
  trunkHead(path: string, trunk: string): string | undefined;
};

export function verifyPatrolRun(
  input: PatrolRunState & { evidence: RecordedPatrolEvidence[] },
  deps: PatrolVerifierDeps,
): { ok: boolean; errors: string[]; verifiedBranches: number } {
  const errors: string[] = [...(input.inventoryErrors ?? [])];
  for (const item of input.inventory) {
    const rows = input.evidence.filter((row) => row.run_id === input.runId && row.repo === item.repo && row.branch === item.branch);
    if (rows.length !== 1) {
      errors.push(`${item.repo}:${item.branch}: expected one evidence row, found ${rows.length}`);
      continue;
    }
    const row = rows[0];
    if (input.mode === "apply" && ["C1", "C2"].includes(item.class) && !["deleted", "fast_forwarded_and_deleted"].includes(row.action)) {
      errors.push(`${item.repo}:${item.branch}: apply mode did not complete ${item.class}: ${row.action}`);
      continue;
    }
    if (row.action === "deleted") {
      if (deps.branchHead(item.repoPath, item.branch) !== undefined) {
        errors.push(`${item.repo}:${item.branch}: branch still exists after delete`);
      }
    } else if (row.action === "fast_forwarded_and_deleted") {
      if (!item.trunk || !row.shaAfter || deps.trunkHead(item.repoPath, item.trunk) !== row.shaAfter) {
        errors.push(`${item.repo}:${item.branch}: live trunk does not match sha_after`);
      }
      if (deps.branchHead(item.repoPath, item.branch) !== undefined) {
        errors.push(`${item.repo}:${item.branch}: branch still exists after fast-forward`);
      }
    }
  }
  return { ok: errors.length === 0, errors, verifiedBranches: input.inventory.length };
}

function gitRef(path: string, ref: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", `refs/heads/${ref}`], {
      cwd: path, encoding: "utf-8", timeout: 10000,
    }).trim();
  } catch {
    return undefined;
  }
}

function runCli(): void {
  const state = JSON.parse(readFileSync(join(process.cwd(), "data", "run-state", "latest-branch-patrol.json"), "utf-8")) as PatrolRunState;
  const evidence = readFileSync(join(process.cwd(), "data", "branch-patrol.jsonl"), "utf-8")
    .split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as RecordedPatrolEvidence]; } catch { return []; }
    });
  const result = verifyPatrolRun({ ...state, evidence }, {
    branchHead: gitRef,
    trunkHead: gitRef,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
