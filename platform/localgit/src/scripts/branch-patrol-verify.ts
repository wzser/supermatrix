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
  commitParents(path: string, sha: string): string[] | undefined;
  isAncestor(path: string, older: string, newer: string): boolean;
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
    if (input.mode === "apply" && ["C1", "C2"].includes(item.class) && !["deleted", "fast_forwarded", "fast_forwarded_and_deleted"].includes(row.action)) {
      errors.push(`${item.repo}:${item.branch}: apply mode did not complete ${item.class}: ${row.action}`);
      continue;
    }
    if (input.mode === "apply" && row.action === "failed") {
      errors.push(`${item.repo}:${item.branch}: apply mode action failed: ${row.error ?? "unknown error"}`);
      continue;
    }
    if (row.action === "deleted") {
      if (deps.branchHead(item.repoPath, item.branch) !== undefined) {
        errors.push(`${item.repo}:${item.branch}: branch still exists after delete`);
      }
    } else if (row.action === "fast_forwarded") {
      if (!item.trunk || !row.shaAfter || deps.trunkHead(item.repoPath, item.trunk) !== row.shaAfter) {
        errors.push(`${item.repo}:${item.branch}: live trunk does not match sha_after`);
      }
      if (row.branchRetained !== true) {
        errors.push(`${item.repo}:${item.branch}: fast_forwarded row lacks branchRetained`);
      }
      if (!row.shaBefore || !row.shaAfter || row.shaAfter !== row.branchHead || !deps.isAncestor(item.repoPath, row.shaBefore, row.shaAfter)) {
        errors.push(`${item.repo}:${item.branch}: not a verifiable fast-forward to the evidence branch head`);
      }
      if (deps.branchHead(item.repoPath, item.branch) !== row.branchHead) {
        errors.push(`${item.repo}:${item.branch}: retained branch head does not match evidence branchHead`);
      }
    } else if (row.action === "fast_forwarded_and_deleted") {
      if (!item.trunk || !row.shaAfter || deps.trunkHead(item.repoPath, item.trunk) !== row.shaAfter) {
        errors.push(`${item.repo}:${item.branch}: live trunk does not match sha_after`);
      }
      if (!row.shaBefore || !row.shaAfter || row.shaAfter !== row.branchHead || !deps.isAncestor(item.repoPath, row.shaBefore, row.shaAfter)) {
        errors.push(`${item.repo}:${item.branch}: not a verifiable fast-forward to the evidence branch head`);
      }
      if (deps.branchHead(item.repoPath, item.branch) !== undefined) {
        errors.push(`${item.repo}:${item.branch}: branch still exists after fast-forward`);
      }
    } else if (row.action === "auto_merged_docs") {
      if (!item.trunk || !row.shaAfter || deps.trunkHead(item.repoPath, item.trunk) !== row.shaAfter) {
        errors.push(`${item.repo}:${item.branch}: live trunk does not match sha_after`);
      }
      if (row.mergeSha !== row.shaAfter) {
        errors.push(`${item.repo}:${item.branch}: mergeSha does not match sha_after`);
      }
      if (!row.mergeSha || !row.parents || row.parents.length !== 2) {
        errors.push(`${item.repo}:${item.branch}: auto_merged_docs row lacks mergeSha or two parents`);
      } else {
        const liveParents = deps.commitParents(item.repoPath, row.mergeSha);
        if (!liveParents || liveParents.length !== 2) {
          errors.push(`${item.repo}:${item.branch}: mergeSha is not a two-parent commit`);
        } else if (liveParents[0] !== row.parents[0] || liveParents[1] !== row.parents[1]) {
          errors.push(`${item.repo}:${item.branch}: recorded merge parents do not match Git`);
        } else if (row.shaBefore && liveParents[0] !== row.shaBefore) {
          errors.push(`${item.repo}:${item.branch}: merge first parent does not match sha_before`);
        } else if (liveParents[1] !== item.branchHead) {
          errors.push(`${item.repo}:${item.branch}: merge second parent does not match branch head`);
        }
      }
      if (!row.branchRetained && deps.branchHead(item.repoPath, item.branch) !== undefined) {
        errors.push(`${item.repo}:${item.branch}: branch still exists after docs auto-merge`);
      }
      if (row.branchRetained && deps.branchHead(item.repoPath, item.branch) !== row.branchHead) {
        errors.push(`${item.repo}:${item.branch}: retained branch head does not match evidence branchHead`);
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

function gitCommitParents(path: string, sha: string): string[] | undefined {
  try {
    // Existence first: rev-list alone would also fail on a non-commit, but an
    // explicit check keeps a forged mergeSha ("not-a-commit") unambiguous.
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: path, encoding: "utf-8", timeout: 10000,
    });
    const line = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha], {
      cwd: path, encoding: "utf-8", timeout: 10000,
    }).trim();
    if (!line) return undefined;
    return line.split(/\s+/).slice(1);
  } catch {
    return undefined;
  }
}

function gitIsAncestor(path: string, older: string, newer: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], {
      cwd: path, encoding: "utf-8", timeout: 10000,
    });
    return true;
  } catch {
    return false;
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
    commitParents: gitCommitParents,
    isAncestor: gitIsAncestor,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
