import { FAST_PATH_REASON, type FileDisposition } from "./daily-commit-judgment-matrix.js";

// Mechanism health for the daily notification card. The per-repo lines say what
// happened to each repo; this says whether the *mechanism* is working — how much
// the reviewer-free fast path carried, how much the reviewer is failing, and how
// much bulk artifact is parked awaiting an owner rule. Without it a run where the
// fast path judged 54 files and the reviewer then died reads identically to a run
// where nothing worked at all (2026-08-05 skill-master/wendangwang case).

export type RunHealthResultLike = {
  committed: boolean;
  reviewerFailure?: string;
  dispositions?: FileDisposition[];
};

export type RunHealth = {
  fastPathCommitted: number;
  reviewerFailures: number;
  partialAfterReviewerFailure: number;
  pendingOwner: number;
  unreviewed: number;
};

export function summarizeRunHealth(results: RunHealthResultLike[]): RunHealth {
  const health: RunHealth = {
    fastPathCommitted: 0,
    reviewerFailures: 0,
    partialAfterReviewerFailure: 0,
    pendingOwner: 0,
    unreviewed: 0,
  };

  for (const r of results) {
    if (r.reviewerFailure) {
      health.reviewerFailures++;
      if (r.committed) health.partialAfterReviewerFailure++;
    }
    for (const d of r.dispositions ?? []) {
      if (d.verdict === "SAFE" && d.reason === FAST_PATH_REASON && r.committed) health.fastPathCommitted++;
      if (d.verdict === "PENDING_OWNER") health.pendingOwner++;
      if (d.verdict === "UNREVIEWED") health.unreviewed++;
    }
  }
  return health;
}

export function formatRunHealthLine(health: RunHealth): string {
  const parts = [
    `fast-path 提交 ${health.fastPathCommitted} 文件`,
    `reviewer 失败 ${health.reviewerFailures} 仓`,
  ];
  if (health.partialAfterReviewerFailure > 0) {
    parts.push(`其中 ${health.partialAfterReviewerFailure} 仓仍落库安全子集`);
  }
  if (health.unreviewed > 0) parts.push(`待复审 ${health.unreviewed} 文件`);
  parts.push(`待 owner 裁决 ${health.pendingOwner} 文件`);
  return `- 🩺 机制健康：${parts.join("；")}`;
}
