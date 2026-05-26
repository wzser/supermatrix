import type { TaskClass, DimensionValues } from "./types.js";
import { CLASS_DEFAULTS } from "./defaults.js";
import { KNOWN_SESSIONS_PSEUDO_ONLY_THRESHOLD } from "./knownSessions.js";

export type LintErrorCode =
  | "sqlite_target_incomplete"
  | "file_target_incomplete"
  | "http_get_target_incomplete"
  | "expectation_invalid_for_engine"
  | "engine_deferred"
  | "engine_unknown"
  | "receipt_kind_unknown"
  | "kind_executor_mismatch"
  | "session_reply_json_path_unsupported"
  | "owner_unknown"
  | "description_empty"
  | "description_placeholder"
  | "description_no_chinese"
  | "hard_constraint_violation"
  | "classed_task_missing_expected_duration"
  | "classed_receipt_must_be_explicit";

export type LintError = {
  code: LintErrorCode;
  field: string;
  message: string;
  hint: string;
};

export type LintResult = { ok: true } | { ok: false; errors: LintError[] };

const NUMERIC_EXPECTATION_RE = /^(>=|<=|==|>|<)\s*-?\d+(\.\d+)?$/;

const CJK_RE = /[一-鿿]/;

const EXECUTOR_KIND: Record<"shell" | "http", "script" | "session"> = {
  shell: "script",
  http: "session",
};

const ENGINE_EXPECTATION_REQUIREMENT: Record<string, "numeric" | "numeric_or_mtime" | "deferred"> = {
  sqlite: "numeric",
  http_get: "numeric",
  file: "numeric_or_mtime",
  bitable: "deferred",
};

export type LintInput = {
  name: string;
  description: string | undefined;
  cron: string;
  executor: "shell" | "http";
  config: Record<string, unknown>;
  class: TaskClass;
  category: string;
  expectedDurationMs: number;
  ownerSession: string;
  overrides?: Partial<DimensionValues> | null;
};

// Defensive accessor: overrides has only `z.record(string, unknown)` zod, so callers may pass
// anything. We treat fields as untrusted and check types before using.
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function lintTaskInput(
  input: LintInput,
  knownSessions: Set<string>,
): LintResult {
  const errors: LintError[] = [];
  const overrides = asRecord(input.overrides);
  const receipt = asRecord(overrides?.receiptProof);

  // Rule 1: external_evidence sqlite must have target.db AND target.sql.
  // Policy: tighter than runtime (runtime has exit_code==0 fallback) — see memory: sync_job_default_footgun.
  if (receipt && receipt.kind === "external_evidence" && receipt.engine === "sqlite") {
    const t = asRecord(receipt.target) ?? {};
    if (typeof t.db !== "string" || !t.db || typeof t.sql !== "string" || !t.sql) {
      errors.push({
        code: "sqlite_target_incomplete",
        field: "overrides.receiptProof.target",
        message:
          "external_evidence + sqlite 必须同时给 target.db 和 target.sql。" +
          "（runtime 在 target 不完整时会退化到 exit_code==0 兜底——这是 documented footgun，本 lint 主动收紧。）",
        hint: "示例: { db: '/abs/path/to.db', sql: 'SELECT COUNT(*) FROM table WHERE ...' }",
      });
    }
  }

  // Rule 2: external_evidence file must have target.path.
  if (receipt && receipt.kind === "external_evidence" && receipt.engine === "file") {
    const t = asRecord(receipt.target) ?? {};
    if (typeof t.path !== "string" || !t.path) {
      errors.push({
        code: "file_target_incomplete",
        field: "overrides.receiptProof.target",
        message: "external_evidence + file 必须给 target.path (string)",
        hint: "示例: { path: '/abs/path/to/output.json' }",
      });
    }
  }

  // Rule 2b: external_evidence http_get must have target.url (runtime requires it; httpGet.ts:12).
  if (receipt && receipt.kind === "external_evidence" && receipt.engine === "http_get") {
    const t = asRecord(receipt.target) ?? {};
    if (typeof t.url !== "string" || !t.url) {
      errors.push({
        code: "http_get_target_incomplete",
        field: "overrides.receiptProof.target",
        message: "external_evidence + http_get 必须给 target.url (string)",
        hint: "示例: { url: 'http://localhost:8080/healthz' }",
      });
    }
  }

  // Rule 2c: receipt.kind / engine must be known to runtime registry.
  // overrides is `z.record(string, unknown)` so user could send anything.
  // Unknown kind/engine bypass all per-kind rules but crash at registry lookup.
  const VALID_RECEIPT_KINDS = new Set([
    "exit_zero",
    "http_2xx",
    "session_reply_present",
    "session_reply_content_check",
    "external_evidence",
  ]);
  const VALID_ENGINES = new Set(["sqlite", "http_get", "file", "bitable"]);

  if (receipt && typeof receipt.kind === "string" && !VALID_RECEIPT_KINDS.has(receipt.kind)) {
    errors.push({
      code: "receipt_kind_unknown",
      field: "overrides.receiptProof.kind",
      message: `receiptProof.kind=${JSON.stringify(receipt.kind)} 不在 runtime 已知集合里。verify 时 registry lookup 会返回 undefined 并在后续 grace handling 崩溃。`,
      hint: `合法 kind: ${[...VALID_RECEIPT_KINDS].join(", ")}`,
    });
  }
  if (receipt && receipt.kind === "external_evidence"
      && typeof receipt.engine === "string"
      && !VALID_ENGINES.has(receipt.engine)) {
    errors.push({
      code: "engine_unknown",
      field: "overrides.receiptProof.engine",
      message: `external_evidence engine=${JSON.stringify(receipt.engine)} 不在 runtime 已知集合里。`,
      hint: `合法 engine: ${[...VALID_ENGINES].join(", ")}`,
    });
  }

  // Rule 3: expectation literal must match what the engine's runtime actually consumes.
  if (receipt && receipt.kind === "external_evidence" && typeof receipt.engine === "string") {
    const need = ENGINE_EXPECTATION_REQUIREMENT[receipt.engine];
    const exp = typeof receipt.expectation === "string" ? receipt.expectation.trim() : "";
    if (need === "deferred") {
      errors.push({
        code: "engine_deferred",
        field: "overrides.receiptProof.engine",
        message: `engine=${receipt.engine} runtime 是占位 stub，总返回 fail。任务会永远 receipt_missing。`,
        hint: "改用 sqlite / http_get / file engine，或等该 engine 实现落地后再用。",
      });
    } else if (need === "numeric") {
      if (!NUMERIC_EXPECTATION_RE.test(exp)) {
        errors.push({
          code: "expectation_invalid_for_engine",
          field: "overrides.receiptProof.expectation",
          message: `engine=${receipt.engine} 的 expectation 必须是数值比较 (e.g. ">= 1")，得到 ${JSON.stringify(exp)}`,
          hint: "合法形式: '>= N' / '> N' / '== N' / '<= N' / '< N'，N 是数字。不能写 'mtime > trigger' 或 internal kind 名。",
        });
      }
    } else if (need === "numeric_or_mtime") {
      const ok = NUMERIC_EXPECTATION_RE.test(exp) || exp === "mtime > trigger";
      if (!ok) {
        errors.push({
          code: "expectation_invalid_for_engine",
          field: "overrides.receiptProof.expectation",
          message: `engine=file 的 expectation 接受数值比较 (比 size) 或字面量 "mtime > trigger" (比 mtime)，得到 ${JSON.stringify(exp)}`,
          hint: "改为数值 (e.g. '>= 1024') 或字面量 'mtime > trigger'（注意空格）。不能写 'mtime_gt_trigger'。",
        });
      }
    }
  }

  // Rule 3b: class=sync_job / publication 必须显式提供 overrides.receiptProof。
  // 它们的 class 默认 receiptProof 是 external_evidence + sqlite + target:{}，
  // resolveOverrides 在 target 不完整时会退化到 exit_zero → evidence 校验形同虚设
  // (memory: sync_job_default_footgun)。Rule 1 只能在 user 给了 receiptProof 时
  // 检查 target 完整性；这条堵住"啥都没给"那条路径。
  // 放在所有 engine-specific 规则之后，避免和它们同时 fire。
  if ((input.class === "sync_job" || input.class === "publication") && !receipt) {
    errors.push({
      code: "classed_receipt_must_be_explicit",
      field: "overrides.receiptProof",
      message: `class=${input.class} 默认 receiptProof 是 external_evidence(sqlite) 但 target 为空，runtime 会 fallback 到 exit_zero——evidence 校验形同虚设。必须显式提供 overrides.receiptProof。`,
      hint: `示例: overrides.receiptProof = { kind: 'external_evidence', engine: 'sqlite', target: { db: '/abs/path.db', sql: 'SELECT COUNT(*) FROM table WHERE date_col >= date()' }, expectation: '>= 1' }。如果你不需要 evidence 校验，请把 class 改成 monitoring (kind=script + exit_zero 默认)。`,
    });
  }

  // Rule 4: class effective kind must match executor.
  const ovKind = overrides?.kind;
  const effectiveKind = (typeof ovKind === "string" ? ovKind : null) ?? CLASS_DEFAULTS[input.class].kind;
  if (effectiveKind !== EXECUTOR_KIND[input.executor]) {
    errors.push({
      code: "kind_executor_mismatch",
      field: "executor",
      message:
        `class=${input.class} effective kind=${effectiveKind}，但 executor=${input.executor} 期望 kind=${EXECUTOR_KIND[input.executor]}。` +
        `dispatch 按 kind 路由：kind=script → triggerShell(command/cwd)；kind=session → triggerHttp(url)。错配 → trigger_failed (undefined cwd/URL)。`,
      hint:
        `两种修复: (1) 改 executor 为 ${effectiveKind === "script" ? "shell" : "http"}；` +
        ` (2) 在 overrides.kind 显式写 ${EXECUTOR_KIND[input.executor]} 翻转 (确认这是真要的行为)。`,
    });
  }

  // Rule 5: session_reply_content_check + json_path is runtime-broken (returns fail).
  if (receipt && receipt.kind === "session_reply_content_check" && receipt.patternType === "json_path") {
    errors.push({
      code: "session_reply_json_path_unsupported",
      field: "overrides.receiptProof.patternType",
      message: "session_reply_content_check + patternType='json_path' runtime 直接判 fail (见 src/receiptProofs/sessionReplyContentCheck.ts)。任务会永远卡 receipt_missing。",
      hint: "改成 'contains' (字面包含) 或 'regex' (正则)。如果你确实需要 JSON 路径校验，得先扩展 runtime 或换 external_evidence/http_get + jsonPath target。",
    });
  }

  // Rule 6: ownerSession must be a known SM session (or framework pseudo-owner).
  // Skip when knownSessions only contains pseudo-owners — that means the SM
  // db is unreachable (or empty). Blocking all POSTs in that state would
  // turn an auxiliary-DB outage into a 503-for-everything. The runtime's
  // disabledWarning falls back to createdBy/"unknown" anyway, so a slightly
  // misrouted notification is the worst case.
  const onlyPseudoOwners = knownSessions.size <= KNOWN_SESSIONS_PSEUDO_ONLY_THRESHOLD;
  if (!onlyPseudoOwners && !knownSessions.has(input.ownerSession)) {
    errors.push({
      code: "owner_unknown",
      field: "ownerSession",
      message: `ownerSession=${JSON.stringify(input.ownerSession)} 不在已知 session 列表里。失败通知 / heal 提案会找不到 owner。`,
      hint: "ownerSession 必须是 supermatrix.db sessions 表里的 name (或框架级伪 owner: supermatrix-root / codexroot)。" +
            "查可用值: sqlite3 ~/SuperMatrixRuntime/data/supermatrix.db \"SELECT DISTINCT name FROM sessions\" 然后排除 child_/sess_ 前缀。",
    });
  }

  // Rule 7 + 8: description must be non-empty, not autoDescription placeholder, contain CJK.
  const descRaw = (input.description ?? "").trim();
  if (!descRaw) {
    errors.push({
      code: "description_empty",
      field: "description",
      message: "description 必须填写（非空）。disabledWarning DM 用它告诉 owner 任务是干嘛的。",
      hint: "1-2 句中文：做什么 / 目的 / 关键约束。例: '每 10 分钟扫订单表，用于补货告警；完成后自动停用。' 参考 sop/task-description-convention.md。",
    });
  } else if (descRaw.startsWith("执行命令:") || descRaw.startsWith("调用接口:")) {
    errors.push({
      code: "description_placeholder",
      field: "description",
      message: `description 是 autoDescription 兜底占位 (${descRaw.slice(0, 40)}...)，不算正式描述。`,
      hint: "替换成 1-2 句中文，覆盖：做什么 / 目的 / 关键约束。参考 sop/task-description-convention.md。",
    });
  } else if (!CJK_RE.test(descRaw)) {
    errors.push({
      code: "description_no_chinese",
      field: "description",
      message: `description 不含中文 (${descRaw.slice(0, 60)}...)。SOP 要求中文描述，让 owner DM 时能直接看懂。`,
      hint: "翻成中文，覆盖：做什么 / 目的 / 关键约束。",
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
