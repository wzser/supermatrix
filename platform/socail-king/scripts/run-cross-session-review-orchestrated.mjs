#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  advanceCursor,
  derivePmoInsights,
  formatFilenameTimestamp,
  formatTimestamp,
  selectNovelInsights,
  summarizeRecords,
} from "../src/cross-session-review.mjs";
import {
  buildDraftAnalysisPrompt,
  buildOrchestrationPaths,
  buildRevisionPrompt,
  buildReviewChecklist,
  DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS,
  reviewDraftArtifacts,
  spawnAndCollectResult,
} from "../src/cross-session-review-orchestration.mjs";

const SQLITE_TIMEOUT_MS = 30_000;
const LARK_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const args = {
    mode: "incremental",
    sendFeishu: false,
    writeState: false,
    stateFile: null,
    dbPath: null,
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
    backend: "claude",
    targetSession: null,
    outputPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--mode":
        args.mode = argv[index + 1] ?? args.mode;
        index += 1;
        break;
      case "--send-feishu":
        args.sendFeishu = true;
        break;
      case "--write-state":
        args.writeState = true;
        break;
      case "--state-file":
        args.stateFile = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--db-path":
        args.dbPath = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--spawn-url":
        args.spawnUrl = argv[index + 1] ?? args.spawnUrl;
        index += 1;
        break;
      case "--backend":
        args.backend = argv[index + 1] ?? args.backend;
        index += 1;
        break;
      case "--target-session":
        args.targetSession = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--output-path":
        args.outputPath = argv[index + 1] ?? null;
        index += 1;
        break;
      default:
        throw new Error(`未知参数: ${value}`);
    }
  }

  if (!["full", "incremental"].includes(args.mode)) {
    throw new Error(`--mode 仅支持 full 或 incremental，收到: ${args.mode}`);
  }

  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sqlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function runSqliteJson(dbPath, sql) {
  const stdout = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    timeout: SQLITE_TIMEOUT_MS,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function runSqliteScalar(dbPath, sql) {
  const rows = runSqliteJson(dbPath, sql);
  if (rows.length === 0) return null;
  const firstRow = rows[0];
  const firstKey = Object.keys(firstRow)[0];
  return firstRow[firstKey] ?? null;
}

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function saveState(stateFile, payload) {
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function getWorkspaceContext(cwd) {
  const sessionName = path.basename(cwd);
  const runtimeRoot = path.resolve(cwd, "..", "..");
  return {
    cwd,
    sessionName,
    runtimeRoot,
    dbPath: path.join(runtimeRoot, "data", "supermatrix.db"),
    reportsDir: path.join(cwd, "reports"),
    stateFile: path.join(cwd, "state", "cross-session-review-state.json"),
    sopPath: path.join(cwd, "sop", "daily-cross-session-review.md"),
  };
}

function buildQuery(mode, cursor) {
  const eventExpr = "CASE WHEN c.finished_at IS NOT NULL THEN c.finished_at ELSE c.created_at END";

  let whereClause = "";
  if (mode === "incremental" && cursor) {
    whereClause = `WHERE (${eventExpr} > ${Number(cursor.eventTimeMs)}) OR (${eventExpr} = ${Number(cursor.eventTimeMs)} AND c.id > ${sqlQuote(cursor.id)})`;
  }

  return `
    SELECT
      c.id,
      sf.name AS from_session,
      st.name AS to_session,
      c.kind,
      c.prompt,
      c.child_session_id,
      c.status,
      c.result_preview,
      c.error_message,
      c.created_at,
      c.finished_at
    FROM cross_session_log c
    JOIN sessions sf ON sf.id = c.from_session_id
    JOIN sessions st ON st.id = c.to_session_id
    ${whereClause}
    ORDER BY ${eventExpr} ASC, c.id ASC;
  `;
}

function mapRow(row) {
  return {
    id: row.id,
    fromSession: row.from_session,
    toSession: row.to_session,
    kind: row.kind,
    prompt: row.prompt ?? "",
    childSessionId: row.child_session_id ?? null,
    status: row.status,
    resultPreview: row.result_preview ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  };
}

function resolveChatId(dbPath, sessionName) {
  const sql = `
    SELECT b.group_id
    FROM bindings b
    JOIN sessions s ON s.id = b.session_id
    WHERE s.name = ${sqlQuote(sessionName)}
    LIMIT 1;
  `;
  const chatId = runSqliteScalar(dbPath, sql);
  if (!chatId) {
    throw new Error(`未找到 session ${sessionName} 对应的 Feishu 群 chat_id`);
  }
  return chatId;
}

function sendTextToFeishu(text, chatId) {
  execFileSync(
    "lark-cli",
    ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--text", text],
    {
      encoding: "utf8",
      stdio: "pipe",
      timeout: LARK_TIMEOUT_MS,
    },
  );
}

function sendReportToFeishu(outputPath, chatId) {
  execFileSync(
    "lark-cli",
    ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--file", `./${path.basename(outputPath)}`],
    {
      cwd: path.dirname(outputPath),
      encoding: "utf8",
      stdio: "pipe",
      timeout: LARK_TIMEOUT_MS,
    },
  );
}

function buildWindowLabel(mode, previousCursor, records) {
  if (mode === "full") return "全量历史";
  if (!previousCursor && records.length > 0) return "全量历史（首次建立增量游标）";
  if (!previousCursor) return "首次运行，但当前没有记录";
  return `${formatTimestamp(previousCursor.eventTimeMs)} 之后的增量变动`;
}

function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

function writeJsonFile(filePath, payload) {
  writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readRequiredFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少产物文件: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function extractMessageBlock(message, blockName) {
  const pattern = new RegExp(`^${blockName}\\n([\\s\\S]*?)\\n^END_${blockName.slice("BEGIN_".length)}$`, "m");
  const match = String(message ?? "").match(pattern);
  return match ? match[1] : "";
}

function ensureArtifactFromSpawn({ filePath, finalMessage, blockName }) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing.trim()) return existing;
  }

  const extracted = extractMessageBlock(finalMessage, blockName);
  if (!extracted.trim()) {
    throw new Error(`缺少产物文件，且 finalMessage 未提供旧版兜底区块 ${blockName}: ${filePath}`);
  }

  writeTextFile(filePath, extracted.endsWith("\n") ? extracted : `${extracted}\n`);
  return extracted;
}

function buildContextPayload({
  workspace,
  nowMs,
  mode,
  reportWindowLabel,
  previousCursor,
  nextCursor,
  previousSummaryText,
  previousInsightKeys,
  records,
  baselineRecords,
  summary,
  baselineSummary,
  pmoInsights,
  novelInsights,
  paths,
}) {
  return {
    meta: {
      sessionName: workspace.sessionName,
      workspaceRoot: workspace.cwd,
      generatedAtMs: nowMs,
      generatedAt: new Date(nowMs).toISOString(),
      mode,
      reportWindowLabel,
      previousCursor,
      nextCursor,
      previousSummaryText,
      previousInsightKeys,
      sopPath: workspace.sopPath,
    },
    artifacts: {
      contextPath: paths.contextPath,
      draftReportPath: paths.draftReportPath,
      draftSummaryPath: paths.draftSummaryPath,
      finalReportPath: paths.finalReportPath,
      finalSummaryPath: paths.finalSummaryPath,
      feedbackPath: paths.feedbackPath,
    },
    summary,
    baselineSummary,
    pmoInsights,
    novelInsights,
    reviewChecklist: buildReviewChecklist(),
    records,
    baselineRecords,
  };
}

function formatReviewFeedback(review) {
  const gateLines = review.gates.map((gate) => {
    const mark = gate.passed ? "PASS" : "FAIL";
    return `- [${mark}] ${gate.label}: ${gate.detail}`;
  });

  const feedbackLines = review.feedback.map((item, index) => `${index + 1}. ${item}`);
  return [
    "# Review Feedback",
    "",
    "## Gates",
    ...gateLines,
    "",
    "## Feedback",
    ...feedbackLines,
    "",
  ].join("\n");
}

function buildResultPayload({
  mode,
  records,
  baselineRecords,
  previousCursor,
  nextCursor,
  summary,
  paths,
  draftSpawn,
  revisionSpawn,
  draftReview,
  finalReview,
}) {
  return {
    mode,
    recordCount: records.length,
    baselineRecordCount: baselineRecords.length,
    previousCursor,
    nextCursor,
    firstEventAt: summary.firstEventAt,
    lastEventAt: summary.lastEventAt,
    failures: summary.statusCounts.failed,
    pending: summary.statusCounts.pending,
    reportPath: paths.finalReportPath,
    summaryPath: paths.finalSummaryPath,
    contextPath: paths.contextPath,
    feedbackPath: paths.feedbackPath,
    draftChildSessionId: draftSpawn.childSessionId ?? null,
    revisionChildSessionId: revisionSpawn.childSessionId ?? null,
    draftFinalMessage: draftSpawn.finalMessage ?? "",
    revisionFinalMessage: revisionSpawn.finalMessage ?? "",
    draftFeedback: draftReview.feedback,
    finalGateStatus: finalReview.gates,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = getWorkspaceContext(process.cwd());
  const dbPath = args.dbPath ?? workspace.dbPath;
  const stateFile = args.stateFile ?? workspace.stateFile;
  const targetSession = args.targetSession ?? workspace.sessionName;
  const nowMs = Date.now();
  const timestampToken = formatFilenameTimestamp(nowMs);

  const previousState = loadState(stateFile);
  const previousCursor = args.mode === "incremental" ? previousState?.cursor ?? null : previousState?.cursor ?? null;
  const previousInsightKeys = previousState?.lastInsightKeys ?? [];
  const previousSummaryText = previousState?.lastSummaryText ?? "";

  const rows = runSqliteJson(dbPath, buildQuery(args.mode, previousCursor));
  const records = rows.map((row) => mapRow(row));
  const baselineRows = runSqliteJson(dbPath, buildQuery("full", null));
  const baselineRecords = baselineRows.map((row) => mapRow(row));
  const nextCursor = advanceCursor(records, previousCursor);
  const summary = summarizeRecords(records);
  const baselineSummary = summarizeRecords(baselineRecords);
  const reportWindowLabel = buildWindowLabel(args.mode, previousCursor, records);
  const pmoInsights = derivePmoInsights({
    records,
    summary,
    baselineRecords,
    baselineSummary,
    generatedAtMs: nowMs,
  });
  const novelInsights = selectNovelInsights({
    pmoInsights,
    summary,
    baselineSummary,
    previousInsightKeys,
  });
  const paths = buildOrchestrationPaths({
    reportsDir: workspace.reportsDir,
    timestampToken,
  });

  if (args.outputPath) {
    paths.finalReportPath = args.outputPath;
  }

  ensureDir(workspace.reportsDir);
  ensureDir(path.dirname(paths.contextPath));
  ensureDir(path.dirname(paths.feedbackPath));

  const contextPayload = buildContextPayload({
    workspace,
    nowMs,
    mode: args.mode,
    reportWindowLabel,
    previousCursor,
    nextCursor,
    previousSummaryText,
    previousInsightKeys,
    records,
    baselineRecords,
    summary,
    baselineSummary,
    pmoInsights,
    novelInsights,
    paths,
  });
  writeJsonFile(paths.contextPath, contextPayload);

  const draftPrompt = buildDraftAnalysisPrompt({
    contextPath: paths.contextPath,
    draftReportPath: paths.draftReportPath,
    draftSummaryPath: paths.draftSummaryPath,
  });
  const draftSpawn = await spawnAndCollectResult({
    spawnUrl: args.spawnUrl,
    target: targetSession,
    from: "socail-king",
    backend: args.backend,
    prompt: draftPrompt,
    dbPath,
    artifactPaths: [paths.draftReportPath, paths.draftSummaryPath],
    maxWaitMs: DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS,
    verificationPredicate: {
      type: "inbox-message",
      session_name: targetSession,
      field: "final_message",
      contains_all: ["BEGIN_DRAFT_REPORT"],
      expected_window_sec: Math.floor(DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS / 1000),
    },
  });

  const draftReportText = ensureArtifactFromSpawn({
    filePath: paths.draftReportPath,
    finalMessage: draftSpawn.finalMessage,
    blockName: "BEGIN_DRAFT_REPORT",
  });
  const draftSummaryText = ensureArtifactFromSpawn({
    filePath: paths.draftSummaryPath,
    finalMessage: draftSpawn.finalMessage,
    blockName: "BEGIN_DRAFT_SUMMARY",
  });
  const draftReview = reviewDraftArtifacts({
    reportText: draftReportText,
    summaryText: draftSummaryText,
    previousSummaryText,
    ensureFollowup: true,
  });
  writeTextFile(paths.feedbackPath, formatReviewFeedback(draftReview));

  const revisionPrompt = buildRevisionPrompt({
    contextPath: paths.contextPath,
    draftReportPath: paths.draftReportPath,
    finalReportPath: paths.finalReportPath,
    finalSummaryPath: paths.finalSummaryPath,
    feedback: draftReview.feedback,
  });
  const revisionSpawn = await spawnAndCollectResult({
    spawnUrl: args.spawnUrl,
    target: targetSession,
    from: "socail-king",
    backend: args.backend,
    prompt: revisionPrompt,
    dbPath,
    artifactPaths: [paths.finalReportPath, paths.finalSummaryPath],
    maxWaitMs: DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS,
    verificationPredicate: {
      type: "inbox-message",
      session_name: targetSession,
      field: "final_message",
      contains_all: ["BEGIN_FINAL_REPORT"],
      expected_window_sec: Math.floor(DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS / 1000),
    },
  });

  const finalReportText = ensureArtifactFromSpawn({
    filePath: paths.finalReportPath,
    finalMessage: revisionSpawn.finalMessage,
    blockName: "BEGIN_FINAL_REPORT",
  });
  const finalSummaryText = ensureArtifactFromSpawn({
    filePath: paths.finalSummaryPath,
    finalMessage: revisionSpawn.finalMessage,
    blockName: "BEGIN_FINAL_SUMMARY",
  });
  const finalReview = reviewDraftArtifacts({
    reportText: finalReportText,
    summaryText: finalSummaryText,
    previousSummaryText,
    ensureFollowup: false,
  });

  const failedGates = finalReview.gates.filter((gate) => !gate.passed);
  if (failedGates.length > 0) {
    throw new Error(`final 报告未通过审核: ${failedGates.map((gate) => gate.label).join("、")}`);
  }

  if (args.sendFeishu) {
    const chatId = resolveChatId(dbPath, workspace.sessionName);
    sendTextToFeishu(finalSummaryText, chatId);
    sendReportToFeishu(paths.finalReportPath, chatId);
  }

  if (args.writeState && nextCursor) {
    saveState(stateFile, {
      sessionName: workspace.sessionName,
      updatedAt: nowMs,
      cursor: nextCursor,
      lastReportPath: paths.finalReportPath,
      lastSummaryPath: paths.finalSummaryPath,
      lastFeedbackPath: paths.feedbackPath,
      lastInsightKeys: novelInsights.map((insight) => insight.key),
      lastSummaryText: finalSummaryText,
      lastDraftChildSessionId: draftSpawn.childSessionId ?? null,
      lastRevisionChildSessionId: revisionSpawn.childSessionId ?? null,
    });
  }

  const result = buildResultPayload({
    mode: args.mode,
    records,
    baselineRecords,
    previousCursor,
    nextCursor,
    summary,
    paths,
    draftSpawn,
    revisionSpawn,
    draftReview,
    finalReview,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
