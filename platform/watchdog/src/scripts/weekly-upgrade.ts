// "Do" entry：升级 + writeLog + 派 root review (fire-and-forget) + 写 pending file
// + 简短 Console 卡片。完事即退出（≤2min）。Report 由独立 cron weekly-upgrade-report.ts
// 接管，互不阻塞。
//
// 拆分动机（2026-05-07）：单 cron 把"升级"和"等 root review"绑死时，
// review 卡 30min/2h 就让整个 task 占住 scheduler 槽位、easy 撞 evidence_missing。
// 现在 do 这边只管动作 + 派单 + 留 handoff 文件，report 那边轮询 + 交付。

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNotifyClient } from "../notify/console.js";
import {
  buildWeeklyModelAudit,
  captureModelSurface,
  collectCodexUpgradeProbeTargets,
  formatModelAuditForReview,
  formatModelAuditReviewInstructions,
  runBtwModelProbes,
  runCatalogModelProbes,
  runCodexEffortProbes,
  runCodexModelProbes,
  type WeeklyModelAudit,
} from "./_weekly-upgrade-model-audit.js";
import {
  buildBackendModelEffortProbeSnapshot,
  publishBackendModelEffortCatalog,
  readCatalogSelectableModels,
} from "./_weekly-upgrade-catalog-publisher.js";
import {
  KIMI_AUTONOMOUS_TURN_PATCH_BINARY,
  buildKimiPatchFailureSpawnBody,
  discardKimiBinarySnapshot,
  restoreKimiBinarySnapshot,
  runKimiAutonomousTurnPatch,
  snapshotKimiBinary,
  type KimiBinarySnapshot,
  type KimiAutonomousTurnPatchResult,
} from "./_weekly-upgrade-kimi-patch.js";
import {
  restoreLarkManifests,
  snapshotLarkManifests,
  type LarkManifestSnapshot,
} from "./_weekly-upgrade-lark-rollback.js";
import {
  assessCliUpgradeCompatibilityRuns,
  extractCodexReferencedModels,
  formatCliUpgradeCompatibilityAssessment,
  runCliUpgradeCompatibilityCheck,
  runCliUpgradeCompatibilityPostCheck,
  type CliUpgradeCompatibilityAssessment,
  type CliUpgradeCompatibilityRun,
} from "./_weekly-upgrade-compatibility.js";

const CHECKLIST_FILE = join(process.cwd(), "docs", "weekly-cli-upgrade-checklist.md");
import {
  CLAUDE_AUTH_KEYCHAIN_SERVICE,
  CLAUDE_AUTH_REQUIRED_SCOPES,
  CLAUDE_AUTH_STATUS_ATTEMPTS,
  LOG_FILE,
  PENDING_FILE,
  ROOT_SESSION,
  SPAWN_API,
  assessClaudeAuthCheck,
  captureClaudeAuthStatusProbes,
  runQuietCommand,
  type Spawn2DelegationRecord,
  type UpgradeResult,
  type ClaudeAuthRequiredScope,
  type ClaudeAuthSnapshotSummary,
  type WeeklyCatalogPublishOutcome,
  buildRootReviewSpawnBody,
  computeReviewChanges,
  formatWeeklyRunDate,
  formatSpawnAdmissionError,
  formatUpgradeLines,
  normalizeSpawn2Delegation,
  readLastReviewedVersions,
  resultFromVersionProbe,
  shouldKickoffRootReview,
  summarizeClaudeAuthSnapshot,
  writePending,
  writeReceipt,
} from "./_weekly-upgrade-shared.js";
import {
  captureChangelogs,
  coverageExpectations,
  formatChangelogSection,
  type CliChangelogCapture,
} from "./_weekly-upgrade-changelog.js";

const CLAUDE_BIN = "/Users/LOCAL_USER/.local/bin/claude";
const CODEX_BIN = "/Users/LOCAL_USER/.npm-global/bin/codex";
const LARK_BIN = "/Users/LOCAL_USER/SuperMatrix/node_modules/.bin/lark-cli";
const SUPERMATRIX_DIR = "/Users/LOCAL_USER/SuperMatrix";
const NPM_BIN = "/usr/local/bin/npm";
const AUDIT_FILE = join(process.cwd(), "data", "scheduler_receipts", "weekly-cli-upgrade.audit.jsonl");
const KIMI_CODE_INSTALLER_URL = "https://code.kimi.com/kimi-code/install.sh";
// hold 文件存在时跳过 Kimi 升级（保住当前健康构建），用于上游 SM-PATCH
// 修复期间避免每周空转一次「换二进制→patch 失败→回滚」。文件内容
// {reason, issueId, createdAt}；对应 issue 关闭后删除该文件恢复升级。
const KIMI_HOLD_FILE = join(process.cwd(), "data", "kimi-upgrade-hold.json");
// 只读快照自己的 scheduler v2 任务配置（timeout 曾被静默改为 120000 导致
// 2026-08-06 04:30 run 被 SIGTERM 截断）；低于此阈值先发 warn 再继续。
const SCHEDULER_TASKS_URL = "http://localhost:3502/tasks";
const SCHEDULER_TASK_NAME = "weekly-cli-upgrade";
const MIN_EXPECTED_TIMEOUT_MS = 600000;
const BACKEND_MODEL_EFFORT_CATALOG_BIN = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/backend-model-effort-catalog";
const BACKEND_MODEL_EFFORT_SNAPSHOT_DIR = join(process.cwd(), "data", "model-audit");

function resolveKimiBin(): string {
  const override = process.env["SM_KIMI_CLI_PATH"]?.trim();
  if (override) return override;
  try {
    const envFile = readFileSync(join(SUPERMATRIX_DIR, ".env.local"), "utf-8");
    const match = envFile.match(/^\s*(?:export\s+)?SM_KIMI_CLI_PATH\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/m);
    const configured = match?.[1] ?? match?.[2] ?? match?.[3];
    if (configured?.trim()) return configured.trim();
  } catch {
    // A missing local runtime override falls back to Kimi Code's documented home.
  }
  return "/Users/LOCAL_USER/.kimi-code/bin/kimi";
}

const KIMI_BIN = resolveKimiBin();

type ClaudeMarkerCheckRun = {
  status: "pass" | "repaired" | "fail" | "skipped";
  reason?: string;
  claudeVersion?: string;
  versionFile?: string;
  backupPath?: string;
  dynamicSummary?: string[];
  error?: string;
};

type KimiUpgradeRun = {
  result: UpgradeResult;
  patch?: KimiAutonomousTurnPatchResult;
  snapshot?: Extract<KimiBinarySnapshot, { status: "pass" }>;
  rollback?: KimiRollbackRun;
};

type KimiPatchFailureHandoff = {
  status: "accepted" | "already-registered" | "failed";
  childSessionId?: string;
  error?: string;
};

type KimiRollbackRun = {
  status: "pass" | "fail";
  restoredVersion: string;
  markerCount: number;
  error?: string;
  retainedSnapshotPath?: string;
};

type CliUpgradeCompatibilityEvidence = {
  before: CliUpgradeCompatibilityRun;
  after: CliUpgradeCompatibilityRun;
  postCheck: {
    attempts: 1 | 2;
    firstFailure?: string;
  };
  assessment: CliUpgradeCompatibilityAssessment;
  recovery?: CliUpgradeCompatibilityRun;
  kimiRollback?: KimiRollbackRun;
};

const CLAUDE_MARKER_CHECK_DISABLED_REASON =
  "disabled 2026-07-09: upstream hidden marker checklist is no longer active; keep checker script for manual fallback only";

function readVersion(bin: string, parser: (s: string) => string): string {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 10000 });
    return parser(out.trim());
  } catch {
    return "unknown";
  }
}

const claudeVersion = () => readVersion(CLAUDE_BIN, (s) => s.split(/\s+/)[0]);
const codexVersion = () => readVersion(CODEX_BIN, (s) => s.replace(/^codex-cli\s+/, ""));
const larkVersion = () => readVersion(LARK_BIN, (s) => s.replace(/^lark-cli version\s+/, ""));
const kimiVersion = () => readVersion(KIMI_BIN, (s) => {
  const match = s.match(/(?:kimi(?:-cli)?[,\s]+version\s*)?v?(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? s;
});

function emptyKeychainScopes(): Record<ClaudeAuthRequiredScope, boolean> {
  return Object.fromEntries(CLAUDE_AUTH_REQUIRED_SCOPES.map((scope) => [scope, false])) as Record<ClaudeAuthRequiredScope, boolean>;
}

async function readClaudeKeychainScopes(): Promise<Record<ClaudeAuthRequiredScope, boolean>> {
  // `-w` is intentionally captured instead of inherited: it is required to
  // parse the credential's scope list but the credential itself never leaves
  // this function. Only the two boolean membership results are persisted.
  const result = await runQuietCommand("/usr/bin/security", [
    "find-generic-password",
    "-s",
    CLAUDE_AUTH_KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.exitCode !== 0) return emptyKeychainScopes();
  try {
    const credential = JSON.parse(result.output) as { claudeAiOauth?: { scopes?: unknown } };
    const scopes = Array.isArray(credential.claudeAiOauth?.scopes)
      ? credential.claudeAiOauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    return Object.fromEntries(CLAUDE_AUTH_REQUIRED_SCOPES.map((scope) => [scope, scopes.includes(scope)])) as Record<ClaudeAuthRequiredScope, boolean>;
  } catch {
    return emptyKeychainScopes();
  }
}

async function captureClaudeAuthSnapshot(): Promise<ClaudeAuthSnapshotSummary> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const [keychainScopes, authStatusProbes] = await Promise.all([
    readClaudeKeychainScopes(),
    captureClaudeAuthStatusProbes({ claudeBin: CLAUDE_BIN, uid }),
  ]);
  return summarizeClaudeAuthSnapshot({
    version: claudeVersion(),
    keychainScopes,
    probes: authStatusProbes,
  });
}

// All three fds "ignore": stdin prevents confirmation hang (2026-05-07 root cause);
// stdout/stderr prevents orphan grandchildren from holding scheduler's stdio pipe open
// (trigger.ts SIGKILL orphan bug — close event would otherwise fire 100 min late).
// We never use the captured output anyway — errors surface via catch(err).
const UPGRADE_STDIO: ("ignore" | "pipe")[] = ["ignore", "ignore", "ignore"];

function commandError(err: unknown): string {
  return (err as Error).message.slice(0, 200);
}

function writeAudit(event: Record<string, unknown>): void {
  mkdirSync(dirname(AUDIT_FILE), { recursive: true });
  appendFileSync(AUDIT_FILE, JSON.stringify({ writtenAt: Date.now(), ...event }) + "\n");
}

type KimiHoldState = { reason?: string; issueId?: string; createdAt?: string };

function readKimiHold(): KimiHoldState | null {
  if (!existsSync(KIMI_HOLD_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(KIMI_HOLD_FILE, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as KimiHoldState : {};
  } catch {
    return {};
  }
}

type SchedulerTaskConfigSnapshot =
  | { found: true; timeout: number | null; retryEnabled: unknown; alertThreshold: unknown; cron: unknown; enabled: unknown; updatedAt: unknown }
  | { found: false; reason: string };

async function captureSchedulerTaskConfig(): Promise<SchedulerTaskConfigSnapshot> {
  try {
    const res = await fetch(SCHEDULER_TASKS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { found: false, reason: `HTTP ${res.status}` };
    const tasks = await res.json();
    if (!Array.isArray(tasks)) return { found: false, reason: "unexpected tasks payload" };
    const task = tasks.find((t) => t && typeof t === "object" && (t as Record<string, unknown>).name === SCHEDULER_TASK_NAME) as Record<string, unknown> | undefined;
    if (!task) return { found: false, reason: `task ${SCHEDULER_TASK_NAME} not found` };
    const config = task.config && typeof task.config === "object" ? task.config as Record<string, unknown> : {};
    return {
      found: true,
      timeout: typeof config.timeout === "number" ? config.timeout : null,
      retryEnabled: task.retryEnabled,
      alertThreshold: task.alertThreshold,
      cron: task.cron,
      enabled: task.enabled,
      updatedAt: task.updatedAt,
    };
  } catch (error) {
    return { found: false, reason: (error as Error).message.slice(0, 120) };
  }
}

function compatibilitySkippedResult(
  cli: string,
  before: string,
  error: string,
): UpgradeResult {
  return {
    cli,
    before,
    after: before,
    changed: false,
    error: `pre-upgrade compatibility check failed; upgrade skipped: ${error}`.slice(0, 200),
  };
}

function upgradeClaude(before: string): UpgradeResult {
  try {
    execFileSync(CLAUDE_BIN, ["update"], { encoding: "utf-8", timeout: 300000, stdio: UPGRADE_STDIO });
    const after = claudeVersion();
    return resultFromVersionProbe({ cli: "claude-code", before, after, versionCommand: "claude --version" });
  } catch (err) {
    // claude update 是先下载 staging 再原子替换：失败/超时且版本探测确认仍是
    // 升级前版本时，系统状态等同"回滚验证健康"（如 2026-08-06 代理通道 37KB/s
    // 导致 5min 超时），标 recovered 不阻断其它 CLI 的 review；版本探测异常则
    // 维持 fail-closed。
    const after = claudeVersion();
    const verifiedUnchanged = after === before && after !== "unknown";
    return {
      ...resultFromVersionProbe({
        cli: "claude-code",
        before,
        after: verifiedUnchanged ? before : after,
        versionCommand: "claude --version",
        error: commandError(err),
      }),
      ...(verifiedUnchanged ? { recovered: true } : {}),
    };
  }
}

function installCodexLatest(): void {
  execFileSync(NPM_BIN, ["install", "-g", "@openai/codex@latest"], {
    encoding: "utf-8",
    timeout: 300000,
    stdio: UPGRADE_STDIO,
  });
}

function rollbackCodex(before: string, failedResult: UpgradeResult): UpgradeResult {
  if (before === "unknown") {
    return {
      ...failedResult,
      error: `${failedResult.error}; exact rollback baseline unavailable`.slice(0, 200),
    };
  }

  try {
    execFileSync(NPM_BIN, ["install", "-g", `@openai/codex@${before}`], {
      encoding: "utf-8",
      timeout: 300000,
      stdio: UPGRADE_STDIO,
    });
    const restoredAfter = codexVersion();
    const restored = resultFromVersionProbe({
      cli: "codex",
      before,
      after: restoredAfter,
      versionCommand: "codex --version",
    });
    if (restored.error) {
      return {
        ...failedResult,
        after: restored.after,
        error: `${failedResult.error}; rollback probe failed: ${restored.error}`.slice(0, 200),
      };
    }
    return {
      ...restored,
      changed: false,
      error: `${failedResult.error}; rolled back to ${restored.after}`.slice(0, 200),
      recovered: true,
    };
  } catch (err) {
    return {
      ...failedResult,
      error: `${failedResult.error}; rollback failed: ${commandError(err)}`.slice(0, 200),
    };
  }
}

function upgradeCodex(): UpgradeResult {
  const before = codexVersion();
  if (before === "unknown") {
    return {
      cli: "codex",
      before,
      after: before,
      changed: false,
      error: "codex --version failed before upgrade; exact rollback baseline unavailable",
    };
  }
  try {
    installCodexLatest();
    const after = codexVersion();
    const result = resultFromVersionProbe({ cli: "codex", before, after, versionCommand: "codex --version" });
    return result.error ? rollbackCodex(before, result) : result;
  } catch (err) {
    return rollbackCodex(before, resultFromVersionProbe({
      cli: "codex",
      before,
      after: codexVersion(),
      versionCommand: "codex --version",
      error: commandError(err),
    }));
  }
}

function upgradeLarkCli(): UpgradeResult {
  // @larksuite/cli 是 supermatrix 项目的 dep，升级走 npm install --save 改 package.json + lock
  const before = larkVersion();
  if (before === "unknown") {
    return {
      cli: "lark-cli",
      before,
      after: before,
      changed: false,
      error: "lark-cli --version failed before upgrade; exact rollback baseline unavailable",
    };
  }
  const snapshot = snapshotLarkManifests(SUPERMATRIX_DIR);
  if (snapshot.status === "fail") {
    return {
      cli: "lark-cli",
      before,
      after: before,
      changed: false,
      error: snapshot.error.slice(0, 200),
    };
  }
  try {
    execFileSync(NPM_BIN, ["install", "@larksuite/cli@latest", "--save"], {
      cwd: SUPERMATRIX_DIR,
      encoding: "utf-8",
      timeout: 300000,
      stdio: UPGRADE_STDIO,
    });
    const after = larkVersion();
    const result = resultFromVersionProbe({
      cli: "lark-cli",
      before,
      after,
      versionCommand: "lark-cli --version",
    });
    return result.error
      ? rollbackLarkToSnapshot(snapshot, before, result.error)
      : result;
  } catch (err) {
    return rollbackLarkToSnapshot(snapshot, before, commandError(err));
  }
}

function rollbackLarkToSnapshot(
  snapshot: Extract<LarkManifestSnapshot, { status: "pass" }>,
  expectedVersion: string,
  failure: string,
): UpgradeResult {
  const restored = restoreLarkManifests(snapshot, {
    supermatrixDir: SUPERMATRIX_DIR,
    npmBin: NPM_BIN,
    runCommand(command, args, options) {
      execFileSync(command, args, {
        ...options,
        encoding: "utf-8",
      });
    },
  });
  const restoredVersion = larkVersion();
  if (restored.status === "pass" && restoredVersion === expectedVersion) {
    return {
      cli: "lark-cli",
      before: expectedVersion,
      after: restoredVersion,
      changed: false,
      error: `${failure}; rolled back manifests and dependency to ${restoredVersion}`.slice(0, 200),
      recovered: true,
    };
  }
  return {
    cli: "lark-cli",
    before: expectedVersion,
    after: restoredVersion,
    changed: restoredVersion !== expectedVersion,
    error: `${failure}; rollback failed: ${
      restored.status === "fail"
        ? restored.error
        : `expected ${expectedVersion}, got ${restoredVersion}`
    }`.slice(0, 200),
  };
}

function rollbackKimiToSnapshot(
  snapshot: Extract<KimiBinarySnapshot, { status: "pass" }>,
  expectedVersion: string,
): KimiRollbackRun {
  const restored = restoreKimiBinarySnapshot(snapshot);
  if (restored.status === "fail") {
    return {
      status: "fail",
      restoredVersion: kimiVersion(),
      markerCount: 0,
      error: restored.error,
      retainedSnapshotPath: snapshot.snapshotPath,
    };
  }
  const restoredVersion = kimiVersion();
  const patch = runKimiAutonomousTurnPatch();
  if (restoredVersion !== expectedVersion || patch.status === "fail") {
    return {
      status: "fail",
      restoredVersion,
      markerCount: patch.markerCount,
      error: [
        restoredVersion !== expectedVersion
          ? `rollback version mismatch: expected ${expectedVersion}, got ${restoredVersion}`
          : null,
        patch.error,
      ].filter((part): part is string => Boolean(part)).join("; "),
      retainedSnapshotPath: snapshot.snapshotPath,
    };
  }
  discardKimiBinarySnapshot(snapshot);
  return {
    status: "pass",
    restoredVersion,
    markerCount: patch.markerCount,
  };
}

function upgradeKimi(): KimiUpgradeRun {
  const before = kimiVersion();
  const snapshot = snapshotKimiBinary(KIMI_BIN);
  if (snapshot.status === "fail") {
    return {
      result: {
        cli: "kimi-code",
        before,
        after: before,
        changed: false,
        error: snapshot.error.slice(0, 200),
      },
    };
  }
  try {
    // Kimi Code's `upgrade` command is intentionally interactive; in cron it
    // only prints this documented installer command and exits without updating.
    execFileSync("/bin/bash", [
      "-l",
      "-o",
      "pipefail",
      "-c",
      `curl -fsSL ${KIMI_CODE_INSTALLER_URL} | bash`,
    ], {
      encoding: "utf-8",
      timeout: 300000,
      stdio: UPGRADE_STDIO,
      env: {
        ...process.env,
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_CLI_NO_AUTO_UPDATE: "1",
      },
    });
    const patch = runKimiAutonomousTurnPatch();
    const after = kimiVersion();
    const versionResult = resultFromVersionProbe({ cli: "kimi-code", before, after, versionCommand: "kimi --version" });
    if (patch.status === "fail" || versionResult.error) {
      // 保留 installer 实际装出的版本：回滚后 result.after 会变回旧版，
      // 不记这里会丢失"patch 是在哪个版本的二进制上失败的"（2026-08-06
      // 曾因此把 0.33.0 误判为"同版本构建"）。
      const failure = `${versionResult.error
        ?? `post-upgrade SM-PATCH recovery failed: ${patch.error ?? "unknown error"}`} (installer produced ${after})`;
      const rollback = rollbackKimiToSnapshot(snapshot, before);
      return {
        patch,
        rollback,
        result: {
          cli: "kimi-code",
          before,
          after: rollback.restoredVersion,
          changed: rollback.restoredVersion !== before,
          error: `${failure}; ${rollback.status === "pass"
            ? `rolled back to ${rollback.restoredVersion}`
            : rollback.error ?? "rollback failed"}`.slice(0, 200),
          // rollback pass 已验证版本恢复 + SM-PATCH marker>=1
          ...(rollback.status === "pass" ? { recovered: true } : {}),
        },
      };
    }
    return { result: versionResult, patch, snapshot };
  } catch (err) {
    const rollback = rollbackKimiToSnapshot(snapshot, before);
    return {
      rollback,
      result: {
        cli: "kimi-code",
        before,
        after: rollback.restoredVersion,
        changed: rollback.restoredVersion !== before,
        error: `${commandError(err)}; ${rollback.status === "pass"
          ? `rolled back to ${rollback.restoredVersion}`
          : rollback.error ?? "rollback failed"}`.slice(0, 200),
        ...(rollback.status === "pass" ? { recovered: true } : {}),
      },
    };
  }
}

async function reportKimiPatchFailure(
  date: string,
  patch: KimiAutonomousTurnPatchResult,
): Promise<KimiPatchFailureHandoff> {
  const body = buildKimiPatchFailureSpawnBody({ runDate: date, patch });
  try {
    const response = await fetch(SPAWN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 409 && payload && typeof payload === "object" && (payload as { duplicate?: unknown }).duplicate === true) {
      return { status: "already-registered" };
    }
    if (!response.ok) return { status: "failed", error: formatSpawnAdmissionError(response.status, payload) };
    try {
      const delegation = normalizeSpawn2Delegation(payload, body.client_request_id);
      return { status: "accepted", childSessionId: delegation.childSessionId };
    } catch (error) {
      return { status: "failed", error: `spawn2.0 success response was not a valid handoff: ${(error as Error).message}`.slice(0, 200) };
    }
  } catch (error) {
    return { status: "failed", error: (error as Error).message.slice(0, 200) };
  }
}

function writeLog(
  date: string,
  results: UpgradeResult[],
  markerCheck: ClaudeMarkerCheckRun,
  claudeAuthCheck: ReturnType<typeof assessClaudeAuthCheck>,
  modelAudit: WeeklyModelAudit,
  compatibilityEvidence: CliUpgradeCompatibilityEvidence,
  catalogPublish: WeeklyCatalogPublishOutcome,
  kimiPatch?: KimiAutonomousTurnPatchResult,
): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({
    date,
    results,
    claudeMarkerCheck: markerCheck,
    claudeAuthCheck,
    modelAudit,
    compatibilityEvidence,
    catalogPublish,
    ...(kimiPatch ? { kimiPatch } : {}),
  }) + "\n");
}

function runClaudeMarkerCheck(): ClaudeMarkerCheckRun {
  return { status: "skipped", reason: CLAUDE_MARKER_CHECK_DISABLED_REASON };
}

async function kickoffRootReview(
  date: string,
  changes: UpgradeResult[],
  modelAudit: WeeklyModelAudit,
  changelogCaptures: CliChangelogCapture[] = [],
): Promise<{ delegation?: Spawn2DelegationRecord; error?: string }> {
  const list = changes.length > 0
    ? changes.map((c) => `- ${c.cli}: ${c.before} → ${c.after}`).join("\n")
    : "- CLI 版本未变化；模型审计检测到需要复核的运行态变化";
  let checklist: string;
  try {
    checklist = readFileSync(CHECKLIST_FILE, "utf-8");
  } catch (err) {
    return {
      error: `required weekly upgrade checklist is unavailable: ${(err as Error).message}`.slice(0, 200),
    };
  }
  if (!checklist.trim()) {
    return { error: "required weekly upgrade checklist is unavailable: file is empty" };
  }

  const prompt = `本周 watchdog 自动升级了以下 CLI：

${list}

请按下面 **Checklist** 逐项核对 changelog，再给出处理决定。

输出语言要求：除固定 Markdown 协议标题（## Checklist / ## Changelog coverage / ## Checklist meta / ## Auto-fixed / ## Proposed for human）以及 CLI 名、flag、命令、代码路径、commit message 外，正文必须使用中文；不要输出英文开场摘要。

${formatModelAuditReviewInstructions(modelAudit)}

==================================================================
【Changelog 材料（watchdog 已抓取，逐版本核对）】
==================================================================

${formatChangelogSection(changelogCaptures)}

==================================================================
【Checklist（每项必须显式标注，不要跳）】
状态用 [✓] / [⚠️ <一句原因>] / [N/A <原因>]
==================================================================

${checklist}

==================================================================
【Checklist 自身的演化（meta review）】
==================================================================
本次 review 你做完现 checklist 全部项目核对后，反思一下：

- 这次 changelog 有没有暴露 checklist **没覆盖到**的 SuperMatrix 调用面/失败模式？（如有 → 提议增加）
- checklist 里有没有项已经**长期 N/A** 或**信息冗余**？（如有 → 提议删除/合并）
- 有没有项措辞**模糊到容易判错**？（如有 → 提议改写）

把建议放在 ## Checklist meta 段，每条独立一行，watchdog 收到后会 file 成 issue 由人审。
格式示例：
\`+ [claude-code] 检查 reasoning_text 字段防御性解析: 上轮 codex 那边踩过类似空 token 边界，claude 也该列入\`
\`- [lark-cli] event +subscribe --compact: 1.0.21 起官方推 event consume，老命令将进入维护期，本项可在 1.0.25 后删\`
\`~ [codex] 默认模型项: 措辞太宽，建议改为"检查 codex --version 输出与本仓 backend-codex/index.ts 默认模型常量是否一致"\`

如果本次没建议，写"无"即可。

==================================================================
【处理决定（在 checklist 与 meta 之后给出）】
==================================================================

档 1：自动修复（直接动手）
  适用：checklist 里任何 [⚠️] 项属于"低风险机械修复"（重命名 flag、替换函数名、补必传参数等改动小且语义不变）
  动作：直接改 SuperMatrix/src 文件 + git commit
  commit message 形如 "fix(deps): adapt to <cli>@<new-version> <change-desc>"

档 2：写方案推给人工（不要动手改）
  适用：
  - 风险高 / 影响多模块 / 需要权衡的兼容修复
  - 新功能可接入（写明 feature 名 / 启用后能做什么 / 实施代价初判）
  - 行为变更需要全局策略调整
  动作：写 title + ≤3 行方案，不 commit

==================================================================
【回执格式】严格按此格式输出，watchdog 会原样转发到 Console 群：
==================================================================

## Checklist
（按 checklist 文件给出的 cluster 与项目顺序逐条标，每行一项；cluster 名称照抄 checklist 标题）

### <cluster>
- [...] <项目>
...

## Changelog coverage
（**强制段，watchdog 会机器校验**：上面 changelog 材料区间内的**每个版本号**逐行标注；
漏掉任一版本号本次 review 会被判为不完整、最终报告不发出。
watchdog 抓取失败/跳过的 CLI 自行取源核对后同样逐版本列出；确实无来源写明"无公开来源，以 live probe 为准"。）
- [<cli>] <version>: 影响 SuperMatrix — <哪个调用面/怎么处理> ｜ 或：不影响 — <一句原因>
...

## Checklist meta
- + [cluster] <新增检查项>: <一句话说明 / 为什么要加>
- - [cluster] <既有项关键词>: <为什么要删>
- ~ [cluster] <既有项关键词>: <改写建议>
（或 "无"）

## Auto-fixed
- <description> (commit: <短 hash> in <repo>)
（或 "无"）

## Proposed for human
- **<title>**: <one-line summary>
  方案/原因: <2-3 lines>
（或 "无"）

==================================================================
【no-cascade 强约束】
==================================================================
- 不要 spawn 其它 session
- 不要触发 atp / scheduler / 跨 session test run；本仓 checklist 指定的 targeted tests 必须实际运行
- 档 1 自己动手，不要转包给别的 session
- 修复完只在 SuperMatrix repo commit + 在 reply 里列出，不要再发额外卡片
- 直接回复最终 review，交付由 spawn2 closure 处理`;

  try {
    const body = buildRootReviewSpawnBody(prompt, date);
    const res = await fetch(SPAWN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { error: formatSpawnAdmissionError(res.status, body) };
    }
    const data = await res.json();
    return { delegation: normalizeSpawn2Delegation(data, body.client_request_id) };
  } catch (err) {
    return { error: (err as Error).message.slice(0, 200) };
  }
}

async function notifyInitial(
  date: string,
  results: UpgradeResult[],
  markerCheck: ClaudeMarkerCheckRun,
  claudeAuthCheck: ReturnType<typeof assessClaudeAuthCheck>,
  modelAudit: WeeklyModelAudit,
  compatibilityEvidence: CliUpgradeCompatibilityEvidence,
  catalogPublish: WeeklyCatalogPublishOutcome,
  spawn: { delegation?: Spawn2DelegationRecord; error?: string } | null,
  kimiPatch?: KimiAutonomousTurnPatchResult,
): Promise<void> {
  const { lines, changed, failed } = formatUpgradeLines(results);
  const sections = [lines.join("\n")];
  const markerIcon = markerCheck.status === "pass"
    ? "✅"
    : markerCheck.status === "repaired"
      ? "🛠️"
      : markerCheck.status === "skipped"
        ? "⏭️"
        : "❌";
  sections.push([
    "---",
    `${markerIcon} **claude-code hidden marker check**: ${markerCheck.status}`,
    markerCheck.reason ? `reason: ${markerCheck.reason}` : null,
    markerCheck.claudeVersion ? `version: ${markerCheck.claudeVersion}` : null,
    markerCheck.versionFile ? `file: ${markerCheck.versionFile}` : null,
    markerCheck.backupPath ? `backup: ${markerCheck.backupPath}` : null,
    ...(markerCheck.dynamicSummary ?? []),
    markerCheck.error ? `error: ${markerCheck.error}` : null,
  ].filter((line): line is string => typeof line === "string").join("\n"));
  const formatAuthSnapshot = (label: "before" | "after", snapshot: ClaudeAuthSnapshotSummary) => {
    const scopes = CLAUDE_AUTH_REQUIRED_SCOPES.map((scope) => `${scope}=${snapshot.keychainScopes[scope] ? "present" : "missing"}`).join(", ");
    return `${label}: claude --version=${snapshot.version}; claude auth status=${snapshot.authStatus}; ${scopes}; interactive=${snapshot.probeCounts["interactive-terminal"]}/${CLAUDE_AUTH_STATUS_ATTEMPTS}; launchctl-asuser=${snapshot.probeCounts["launchctl-asuser"]}/${CLAUDE_AUTH_STATUS_ATTEMPTS}`;
  };
  sections.push([
    "---",
    `${claudeAuthCheck.status === "pass" ? "✅" : "❌"} **claude-code auth check**: ${claudeAuthCheck.status}`,
    formatAuthSnapshot("before", claudeAuthCheck.before),
    formatAuthSnapshot("after", claudeAuthCheck.after),
    "429 quota is recorded as quota, not an auth failure.",
    `reboot/wake: ${claudeAuthCheck.rebootWakeFollowUp}; active reboot: ${claudeAuthCheck.activeReboot}.`,
    claudeAuthCheck.remediation
      ? `FAIL CLOSED: no automatic login/recovery; run manually: ${claudeAuthCheck.remediation}`
      : null,
  ].filter((line): line is string => typeof line === "string").join("\n"));
  if (kimiPatch) {
    sections.push([
      "---",
      `${kimiPatch.status === "pass" ? "✅" : "❌"} **kimi-code SM-PATCH recovery**: ${kimiPatch.status}`,
      `strings ${KIMI_AUTONOMOUS_TURN_PATCH_BINARY} | grep -c "SM-PATCH" = ${kimiPatch.markerCount} (expected >= 1)`,
      kimiPatch.error ? `error: ${kimiPatch.error}` : null,
    ].filter((line): line is string => typeof line === "string").join("\n"));
  }
  sections.push([
    "---",
    `${compatibilityEvidence.assessment.status === "fail" ? "❌" : compatibilityEvidence.assessment.status === "adjustment-required" ? "⚠️" : "✅"} **SuperMatrix CLI upgrade compatibility**`,
    ...formatCliUpgradeCompatibilityAssessment(
      compatibilityEvidence.assessment,
      compatibilityEvidence.recovery,
    ),
    compatibilityEvidence.postCheck.attempts === 2
      ? compatibilityEvidence.after.kind === "ok"
        ? `post-check retry: recovered after first failure (${compatibilityEvidence.postCheck.firstFailure})`
        : `post-check retry: failed after two attempts; first failure (${compatibilityEvidence.postCheck.firstFailure})`
      : null,
  ].filter((line): line is string => typeof line === "string").join("\n"));
  sections.push(`---\n**模型审计**\n${formatModelAuditForReview(modelAudit)}`);
  sections.push([
    "---",
    `${catalogPublish.status === "failed" ? "❌" : "✅"} **backend model/effort catalog 发布**: ${catalogPublish.status}`,
    `catalog revision: ${catalogPublish.catalogRevision ?? "unknown"}`,
    `snapshot: ${catalogPublish.snapshotPath}`,
    catalogPublish.status === "failed"
      ? `reason: ${catalogPublish.reason}`
      : `receipt: ${catalogPublish.receiptId ?? "unchanged-no-new-receipt"}`,
  ].join("\n"));
  if (spawn) {
    if (spawn.delegation) {
      const record = spawn.delegation;
      sections.push(`---\nRoot review 已派出（childSessionId=${record.childSessionId}${record.spawnCommId ? `, spawnCommId=${record.spawnCommId}` : ""}）。完整两档报告由 weekly-upgrade-report cron 完工时单独发出，最迟 8h 内（${date} 13:00 前）。`);
    } else {
      sections.push(`---\n⚠️ Root review 派单失败：${spawn.error}。本次 review 跳过，已是最新版本部分不影响。`);
    }
  } else if (failed > 0 || catalogPublish.status === "failed") {
    sections.push(`---\n⚠️ Root review 未派出：${catalogPublish.status === "failed" ? "catalog publish 未闭环" : "CLI 升级阶段有失败项"}，避免把失败升级误当成兼容性 review。`);
  }
  const body = sections.join("\n\n");
  console.log(`[Weekly CLI upgrade · do] ${date}\n${body}`);
  try {
    await createNotifyClient().notify({
      source: "watchdog",
      title: `每周 CLI 升级 · ${date}（升级阶段）`,
      body,
      level: failed > 0
        || markerCheck.status === "fail"
        || claudeAuthCheck.status === "fail"
        || compatibilityEvidence.assessment.status === "fail"
        || catalogPublish.status === "failed"
        ? "error"
        : "info",
      metadata: {
        date, changed, failed, total: results.length,
        claudeMarkerCheck: markerCheck.status,
        claudeAuthCheck: claudeAuthCheck.status,
        claudeAuthQuotaObserved: claudeAuthCheck.before.quotaObserved || claudeAuthCheck.after.quotaObserved ? "yes" : "no",
        claudeAuthRebootWakeFollowUp: claudeAuthCheck.rebootWakeFollowUp,
        modelSurfaceChanged: modelAudit.diff.changed ? "yes" : "no",
        modelAdjustmentRequired: modelAudit.requiresAdjustment ? "yes" : "no",
        catalogPublish: catalogPublish.status,
        catalogRevision: catalogPublish.catalogRevision ?? "unknown",
        catalogReceipt: catalogPublish.status === "failed" ? "none" : catalogPublish.receiptId ?? "unchanged",
        cliUpgradeCompatibility: compatibilityEvidence.assessment.status,
        cliUpgradeRollback: compatibilityEvidence.assessment.rollbackClis.join(",") || "none",
        spawned: spawn?.delegation ? "yes" : "no",
      },
    });
  } catch (err) {
    console.error("Notify failed:", (err as Error).message);
  }
}

const date = formatWeeklyRunDate();
console.log(`[Weekly CLI upgrade · do] ${date}`);
const taskConfigSnapshot = await captureSchedulerTaskConfig();
writeAudit({ date, phase: "start", pid: process.pid, taskConfig: taskConfigSnapshot });
if (taskConfigSnapshot.found && taskConfigSnapshot.timeout !== null && taskConfigSnapshot.timeout < MIN_EXPECTED_TIMEOUT_MS) {
  // 继续跑（中断有 exit 守卫兜底），但先把配置漂移喊出来。
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${date}（scheduler timeout 配置过低）`,
    body: `weekly-cli-upgrade 任务 timeout=${taskConfigSnapshot.timeout}ms，低于该链实际所需（>= ${MIN_EXPECTED_TIMEOUT_MS}ms，2026-08-06 曾因 120000ms 被 SIGTERM 截断）。本次继续执行，但请让 scheduler 修正配置。`,
    level: "warn",
    metadata: { date, timeout: taskConfigSnapshot.timeout },
  }).catch(() => {});
}

// 中断安全：run 被 SIGTERM/SIGINT 杀死或异常退出而未写终态 receipt 时，
// 同步补写 aborted receipt + 审计（2026-08-06 04:30 被 scheduler 超时杀死后
// 无 receipt、无告警，report entry 静默跳过，靠人工翻日志才发现）。
// Console 通知不在 exit 守卫里发（无法 await）；孤儿/aborted 告警由
// weekly-upgrade-report.ts 的孤儿检测负责。
let terminalReceiptWritten = false;
const results: UpgradeResult[] = [];
function writeAbortedState(reason: string): void {
  if (terminalReceiptWritten) return;
  terminalReceiptWritten = true;
  try {
    writeAudit({ date, phase: "run-aborted", reason });
    writeReceipt({ date, aborted: true, abortReason: reason, results });
  } catch {
    // 尽力而为；孤儿检测仍能从 audit start-without-terminal 判断
  }
}
process.on("exit", (code) => {
  writeAbortedState(`process exited (code ${code}) before terminal receipt`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    writeAbortedState(`received ${signal} before terminal receipt`);
    process.exit(1);
  });
}

const modelSurfaceBefore = captureModelSurface({ claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN, kimiBin: KIMI_BIN });
writeAudit({ date, phase: "model-surface-before", modelSurface: modelSurfaceBefore });
const compatibilityBefore = runCliUpgradeCompatibilityCheck();
writeAudit({ date, phase: "cli-upgrade-compatibility-before", compatibility: compatibilityBefore });
const compatibilityPrecheckError = compatibilityBefore.kind === "fail"
  ? compatibilityBefore.error
  : null;

const claudeAuthBefore = await captureClaudeAuthSnapshot();
writeAudit({ date, phase: "claude-auth-before", claudeAuthSnapshot: claudeAuthBefore });
writeAudit({ date, phase: "step-start", cli: "claude-code" });
const claudeResult = compatibilityPrecheckError
  ? compatibilitySkippedResult("claude-code", claudeAuthBefore.version, compatibilityPrecheckError)
  : claudeAuthBefore.status === "pass"
    ? upgradeClaude(claudeAuthBefore.version)
    : {
      cli: "claude-code",
      before: claudeAuthBefore.version,
      after: claudeAuthBefore.version,
      changed: false,
      error: "pre-upgrade Claude auth verification failed; claude update skipped (fail closed)",
      };
results.push(claudeResult);
writeAudit({ date, phase: "step-finish", result: claudeResult });
const claudeAuthAfter = await captureClaudeAuthSnapshot();
const claudeAuthCheck = assessClaudeAuthCheck(claudeAuthBefore, claudeAuthAfter);
if (claudeAuthCheck.status === "fail") {
  const result = results[0]!;
  const authError = `Claude auth verification failed; fail closed; manual remediation: ${claudeAuthCheck.remediation}`;
  results[0] = {
    ...result,
    error: result.error ? `${result.error}; ${authError}`.slice(0, 200) : authError,
  };
}
writeAudit({ date, phase: "claude-auth-after", claudeAuthSnapshot: claudeAuthAfter });
writeAudit({ date, phase: "claude-auth-check", claudeAuthCheck });

for (const [cli, run] of [
  ["codex", upgradeCodex],
] as const) {
  writeAudit({ date, phase: "step-start", cli });
  const result = compatibilityPrecheckError
    ? compatibilitySkippedResult(cli, codexVersion(), compatibilityPrecheckError)
    : run();
  results.push(result);
  writeAudit({ date, phase: "step-finish", result });
}
writeAudit({ date, phase: "step-start", cli: "kimi-code" });
const kimiHold = readKimiHold();
if (kimiHold) {
  writeAudit({ date, phase: "kimi-hold-skip", hold: kimiHold });
}
const kimiUpgrade: KimiUpgradeRun = kimiHold
  ? (() => {
      const held = kimiVersion();
      return {
        result: {
          cli: "kimi-code",
          before: held,
          after: held,
          changed: false,
          held: true,
          holdReason: (kimiHold.reason ?? "kimi-upgrade-hold.json present").slice(0, 200),
        },
      };
    })()
  : compatibilityPrecheckError
  ? {
      result: compatibilitySkippedResult(
        "kimi-code",
        kimiVersion(),
        compatibilityPrecheckError,
      ),
    }
  : upgradeKimi();
const kimiResultIndex = results.length;
results.push(kimiUpgrade.result);
let kimiPatchHandoff: KimiPatchFailureHandoff | undefined;
if (kimiUpgrade.patch?.status === "fail") {
  kimiPatchHandoff = await reportKimiPatchFailure(date, kimiUpgrade.patch);
  if (kimiPatchHandoff.status === "failed") {
    const prior = results[kimiResultIndex]!;
    results[kimiResultIndex] = {
      ...prior,
      error: `${prior.error ?? "post-upgrade SM-PATCH recovery failed"}; codexroot failure handoff failed: ${kimiPatchHandoff.error ?? "unknown error"}`.slice(0, 200),
    };
  }
}
writeAudit({
  date,
  phase: "step-finish",
  result: results[kimiResultIndex],
  ...(kimiUpgrade.patch ? { kimiPatch: kimiUpgrade.patch } : {}),
  ...(kimiPatchHandoff ? { kimiPatchHandoff } : {}),
});
for (const [cli, run] of [
  ["lark-cli", upgradeLarkCli],
] as const) {
  writeAudit({ date, phase: "step-start", cli });
  const result = compatibilityPrecheckError
    ? compatibilitySkippedResult(cli, larkVersion(), compatibilityPrecheckError)
    : run();
  results.push(result);
  writeAudit({ date, phase: "step-finish", result });
}
const compatibilityAfterAttempt = runCliUpgradeCompatibilityPostCheck();
const compatibilityAfter = compatibilityAfterAttempt.run;
const compatibilityAssessment = assessCliUpgradeCompatibilityRuns(
  compatibilityBefore,
  compatibilityAfter,
);
writeAudit({
  date,
  phase: "cli-upgrade-compatibility-after",
  compatibility: compatibilityAfter,
  attempts: compatibilityAfterAttempt.attempts,
  compatibilityAssessment,
});

if (compatibilityAssessment.rollbackClis.includes("codex")) {
  const codexIndex = results.findIndex((result) => result.cli === "codex");
  const prior = results[codexIndex];
  if (codexIndex >= 0 && prior) {
    results[codexIndex] = rollbackCodex(prior.before, {
      ...prior,
      error: `post-upgrade compatibility failed: ${compatibilityAssessment.error ?? "codex boot check failed"}`.slice(0, 200),
    });
  }
}

if (compatibilityAssessment.rollbackClis.includes("kimi-code")) {
  const prior = results[kimiResultIndex]!;
  if (kimiUpgrade.snapshot) {
    const rollback = rollbackKimiToSnapshot(
      kimiUpgrade.snapshot,
      prior.before,
    );
    kimiUpgrade.rollback = rollback;
    results[kimiResultIndex] = {
      ...prior,
      after: rollback.restoredVersion,
      changed: rollback.restoredVersion !== prior.before,
      error: `post-upgrade compatibility failed: ${compatibilityAssessment.error ?? "Kimi ACP check failed"}; ${
        rollback.status === "pass"
          ? `rolled back to ${rollback.restoredVersion}`
          : rollback.error ?? "rollback failed"
      }`.slice(0, 200),
      ...(rollback.status === "pass" ? { recovered: true } : {}),
    };
  } else {
    results[kimiResultIndex] = {
      ...prior,
      error: `${prior.error ?? "post-upgrade Kimi compatibility failed"}; rollback snapshot unavailable`.slice(0, 200),
    };
  }
}

let compatibilityRecovery: CliUpgradeCompatibilityRun | undefined;
if (compatibilityAssessment.rollbackClis.length > 0) {
  compatibilityRecovery = runCliUpgradeCompatibilityCheck();
  writeAudit({
    date,
    phase: "cli-upgrade-compatibility-recovery",
    compatibility: compatibilityRecovery,
  });
  if (compatibilityRecovery.kind !== "ok") {
    // 回滚后的 recovery check 没过 → 撤销 recovered 标记，维持 fail-closed。
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.recovered) results[i] = { ...results[i]!, recovered: false };
    }
  }
}
if (
  kimiUpgrade.snapshot
  && !compatibilityAssessment.rollbackClis.includes("kimi-code")
) {
  discardKimiBinarySnapshot(kimiUpgrade.snapshot);
}
const markerCheck = runClaudeMarkerCheck();
const modelSurfaceAfter = captureModelSurface({ claudeBin: CLAUDE_BIN, codexBin: CODEX_BIN, kimiBin: KIMI_BIN });
const btwModelProbes = runBtwModelProbes({
  claudeBin: CLAUDE_BIN,
  codexBin: CODEX_BIN,
  supermatrixDir: SUPERMATRIX_DIR,
});
const compatibilityAfterReport = compatibilityAfter.report;
const referencedCodexModels = compatibilityAfterReport
  ? extractCodexReferencedModels(compatibilityAfterReport)
  : [];
const alreadyProbedCodexTargets = new Set(
  btwModelProbes
    .filter(({ backend }) => backend === "codex")
    .map(({ target }) => target),
);
const changedReferencedCodexTargets = collectCodexUpgradeProbeTargets(
  modelSurfaceBefore,
  modelSurfaceAfter,
  referencedCodexModels,
).filter((target) => !alreadyProbedCodexTargets.has(target));
const modelProbes = [
  ...btwModelProbes,
  ...runCodexModelProbes({
    targets: changedReferencedCodexTargets,
    codexBin: CODEX_BIN,
    supermatrixDir: SUPERMATRIX_DIR,
  }),
];
const catalogSnapshotPath = join(
  BACKEND_MODEL_EFFORT_SNAPSHOT_DIR,
  `backend-model-effort-probe-${date}-${modelSurfaceAfter.capturedAt}.json`,
);
let catalogPublish: WeeklyCatalogPublishOutcome;
try {
  const currentCatalog = readCatalogSelectableModels({
    catalogBin: BACKEND_MODEL_EFFORT_CATALOG_BIN,
  });
  modelProbes.push(...runCatalogModelProbes({
    catalogModels: currentCatalog.models,
    alreadyProbed: modelProbes,
    claudeBin: CLAUDE_BIN,
    codexBin: CODEX_BIN,
    kimiBin: KIMI_BIN,
    supermatrixDir: SUPERMATRIX_DIR,
  }));
  const catalogCodexModels = new Set(currentCatalog.models.codex);
  const catalogCodexEffortProbes = runCodexEffortProbes({
    targets: modelSurfaceAfter.codex.models
      .filter((model) => catalogCodexModels.has(model.slug))
      .map((model) => ({ target: model.slug, efforts: model.reasoningEfforts })),
    codexBin: CODEX_BIN,
    supermatrixDir: SUPERMATRIX_DIR,
  });
  const catalogSnapshot = buildBackendModelEffortProbeSnapshot({
    runId: `weekly-${date}-${modelSurfaceAfter.capturedAt}`,
    observedAt: new Date(modelSurfaceAfter.capturedAt).toISOString(),
    evidenceRef: `watchdog://weekly-cli-upgrade/${date}/model-audit/${modelSurfaceAfter.capturedAt}`,
    catalogRevision: currentCatalog.revision,
    catalogModels: currentCatalog.models,
    modelSurface: modelSurfaceAfter,
    modelProbes,
    effortProbes: catalogCodexEffortProbes.map((probe) => ({
      backend: probe.backend,
      model: probe.target,
      effort: probe.effort,
      status: probe.status,
      ...(probe.detail ? { detail: probe.detail } : {}),
    })),
  });
  catalogPublish = publishBackendModelEffortCatalog({
    catalogBin: BACKEND_MODEL_EFFORT_CATALOG_BIN,
    snapshotPath: catalogSnapshotPath,
    snapshot: catalogSnapshot,
  });
} catch (error) {
  catalogPublish = {
    status: "failed",
    snapshotPath: catalogSnapshotPath,
    catalogRevision: null,
    reason: commandError(error),
  };
}
writeAudit({
  date,
  phase: "backend-model-effort-catalog-publish",
  catalogPublish,
});
const compatibilityEvidence: CliUpgradeCompatibilityEvidence = {
  before: compatibilityBefore,
  after: compatibilityAfter,
  postCheck: {
    attempts: compatibilityAfterAttempt.attempts,
    ...(compatibilityAfterAttempt.firstFailure
      ? { firstFailure: compatibilityAfterAttempt.firstFailure }
      : {}),
  },
  assessment: compatibilityAssessment,
  ...(compatibilityRecovery ? { recovery: compatibilityRecovery } : {}),
  ...(kimiUpgrade.rollback ? { kimiRollback: kimiUpgrade.rollback } : {}),
};
const modelAudit = buildWeeklyModelAudit(modelSurfaceBefore, modelSurfaceAfter, modelProbes, compatibilityAssessment);
writeAudit({ date, phase: "model-audit", modelAudit });
writeAudit({ date, phase: "claude-marker-check", claudeMarkerCheck: markerCheck });
writeLog(date, results, markerCheck, claudeAuthCheck, modelAudit, compatibilityEvidence, catalogPublish, kimiUpgrade.patch);
writeReceipt({ date, results, claudeMarkerCheck: markerCheck, claudeAuthCheck, modelAudit,
  compatibilityEvidence,
  catalogPublish,
  ...(kimiUpgrade.patch ? { kimiPatch: kimiUpgrade.patch } : {}),
  ...(kimiPatchHandoff ? { kimiPatchHandoff } : {}),
});
terminalReceiptWritten = true;

// review 基线：与上次 root review 完成时的版本比对（而非本进程 changed 标志），
// 中断补跑时才不会漏审；基线由 report entry 在 review 完成后更新。
const reviewBaseline = readLastReviewedVersions();
const reviewChanges = computeReviewChanges(results, reviewBaseline);
const reviewRequired = compatibilityAssessment.status !== "fail"
  && catalogPublish.status !== "failed"
  && shouldKickoffRootReview(results, modelAudit.requiresReview, reviewChanges);
writeAudit({
  date,
  phase: "review-gate",
  reviewRequired,
  baseline: reviewBaseline?.versions ?? null,
  reviewChanges: reviewChanges.map((c) => ({ cli: c.cli, before: c.before, after: c.after })),
});
const changes = reviewRequired ? reviewChanges : [];
let changelogCaptures: CliChangelogCapture[] = [];
let spawn: { delegation?: Spawn2DelegationRecord; error?: string } | null = null;
if (reviewRequired) {
  changelogCaptures = await captureChangelogs(
    changes.map((c) => ({ cli: c.cli, before: c.before, after: c.after })),
  );
  writeAudit({
    date,
    phase: "changelog-capture",
    changelogs: changelogCaptures.map((c) => ({
      cli: c.cli, status: c.status, source: c.source,
      versions: c.versions.map((v) => v.version),
      ...(c.reason ? { reason: c.reason } : {}),
    })),
  });
  try {
    mkdirSync(BACKEND_MODEL_EFFORT_SNAPSHOT_DIR, { recursive: true });
    writeFileSync(
      join(BACKEND_MODEL_EFFORT_SNAPSHOT_DIR, `changelogs-${date}.json`),
      JSON.stringify(changelogCaptures, null, 2),
    );
  } catch (error) {
    console.error("changelog archive write failed:", (error as Error).message);
  }
  spawn = await kickoffRootReview(date, changes, modelAudit, changelogCaptures);
  if (spawn.delegation) {
    writePending({
      runDate: date,
      spawnedAt: Date.now(),
      delegation: spawn.delegation,
      results,
      modelAudit,
      catalogPublish,
      changelogCoverage: coverageExpectations(changelogCaptures),
    });
    console.log(`Pending review handoff written: ${PENDING_FILE}`);
  }
}

await notifyInitial(
  date,
  results,
  markerCheck,
  claudeAuthCheck,
  modelAudit,
  compatibilityEvidence,
  catalogPublish,
  spawn,
  kimiUpgrade.patch,
);
if (catalogPublish.status === "failed") process.exitCode = 1;
