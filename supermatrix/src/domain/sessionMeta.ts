// Session-meta field validators per FP v1.0 contract:
// first-principle/rules/session-meta-fields.md (Rev v1.0, 2026-05-02).
// Format / writer / sync rules belong to the contract; this module only
// encodes the format checks. UPDATE-path restrictions (e.g. chat_name has
// no UPDATE writers) are structural and enforced by the absence of those
// methods on BindingStore, not by these validators.

import { UserError } from "./errors.ts";

const AVATAR_TOKEN_RE = /^[A-Za-z0-9]+$/u;
const AVATAR_TOKEN_LEN = 27;
const ALIAS_FORBIDDEN_RE = /[\s/\\|]/u;
const ALIAS_MAX_VISIBLE = 8;
const CATEGORY_VALUES = new Set(["", "业务", "平台", "工具", "知识", "外部"]);

export function isConformingAvatar(value: string): boolean {
  if (value === "") return true;
  return value.length === AVATAR_TOKEN_LEN && AVATAR_TOKEN_RE.test(value);
}

export function validateSessionAvatar(value: string): void {
  if (isConformingAvatar(value)) return;
  throw new UserError(
    `avatar 必须是 Bitable file_token (27 位 base62) 或空串；收到长度 ${value.length} 的非法值`,
  );
}

function visibleLength(s: string): number {
  return [...s].length;
}

export function validateSessionAlias(value: string): void {
  if (value === "") return;
  if (ALIAS_FORBIDDEN_RE.test(value)) {
    throw new UserError("alias 不能包含空白字符或 / \\ | 任一字符");
  }
  const len = visibleLength(value);
  if (len > ALIAS_MAX_VISIBLE) {
    throw new UserError(`alias 最多 ${ALIAS_MAX_VISIBLE} 个可见字符（当前 ${len}）`);
  }
}

export function validateSessionCategory(value: string): void {
  if (!CATEGORY_VALUES.has(value)) {
    throw new UserError(
      `category 必须 ∈ {'', '业务', '平台', '工具', '知识', '外部'}; 收到 ${JSON.stringify(value)}`,
    );
  }
}
