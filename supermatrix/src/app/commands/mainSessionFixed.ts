import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";
import { UserError } from "../../domain/errors.ts";

const RETIRED_FIXED_TOKENS = new Set([
  "fixed",
  "fix",
  "lock",
  "锁定",
  "unfixed",
  "unfix",
  "unlock",
  "解锁",
]);

export function rejectRetiredMainSessionFixed(token: string): void {
  if (!RETIRED_FIXED_TOKENS.has(canonicalizeToken(token))) return;
  throw new UserError(
    "主 session 的 Fixed/Unfixed 已退役；请在飞书多维表格编辑「主model默认值」或「主effort默认值」，每日任务会按表中默认值回落。",
  );
}
