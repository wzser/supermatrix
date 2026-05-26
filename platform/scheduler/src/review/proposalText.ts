import type { CreationReview } from "./creationReviewStore.js";

export type BuildProposalTextOpts = {
  reviews: CreationReview[];
  schedulerBaseUrl?: string; // default "http://localhost:3500" — used in instructions
};

export function buildProposalText(opts: BuildProposalTextOpts): string {
  const reviews = opts.reviews;
  const baseUrl = opts.schedulerBaseUrl ?? "http://localhost:3500";
  const lines: string[] = [];
  lines.push(
    `[batch creation review — 你（scheduler session）请按 sop/creation-review-decisions.md 审下面 ${reviews.length} 条 task creation。每条独立判 approve / patch / reject / escalate。回复格式见 SOP §reply-format。`,
  );
  lines.push("");
  lines.push("决议落地方式：审完后调以下接口 (一条决议一个 POST，base = " + baseUrl + ")：");
  lines.push("  POST /proposals/creation/:review_id/approve   body: { reason }");
  lines.push("  POST /proposals/creation/:review_id/patch     body: { reason, patch }");
  lines.push("  POST /proposals/creation/:review_id/reject    body: { reason, disable?:true }");
  lines.push("  POST /proposals/creation/:review_id/escalate  body: { reason }");
  lines.push("");
  lines.push("---");
  lines.push("");

  reviews.forEach((r, idx) => {
    lines.push(`REVIEW #${idx + 1} of ${reviews.length}`);
    lines.push(`review_id: ${r.id}`);
    lines.push(`task_id: ${r.taskId}`);
    lines.push(`trigger: ${r.trigger}`);
    lines.push("");
    lines.push("TASK SNAPSHOT (JSON):");
    lines.push("```json");
    lines.push(JSON.stringify(r.taskSnapshot, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("L1 LINT 已通过 — 这条 task 通过了 14 条机械检查 (sop/creation-lint-errors.md)。");
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  lines.push("SOP: sop/creation-review-decisions.md — 8 个语义检查 + 决议规则 + reply-format。");
  return lines.join("\n");
}
