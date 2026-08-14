#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  advanceCursor,
  buildSummaryMessage,
  derivePmoInsights,
  formatFilenameTimestamp,
  formatTimestamp,
  renderMarkdownReport,
  selectNovelInsights,
  summarizeRecords,
} from "../src/cross-session-review.mjs";

function parseArgs(argv) {
  const args = {
    mode: "incremental",
    sendFeishu: false,
    writeState: false,
    stateFile: null,
    outputPath: null,
    dbPath: null,
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
      case "--output-path":
        args.outputPath = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--db-path":
        args.dbPath = argv[index + 1] ?? null;
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

function resolveOutputPath(reportsDir, nowMs, explicitPath) {
  if (explicitPath) return explicitPath;
  ensureDir(reportsDir);
  return path.join(reportsDir, `${formatFilenameTimestamp(nowMs)}-cross-session-review.md`);
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
    },
  );
}

function buildWindowLabel(mode, previousCursor, records) {
  if (mode === "full") return "全量历史";
  if (!previousCursor && records.length > 0) return "全量历史（首次建立增量游标）";
  if (!previousCursor) return "首次运行，但当前没有记录";
  return `${formatTimestamp(previousCursor.eventTimeMs)} 之后的增量变动`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = getWorkspaceContext(process.cwd());
  const dbPath = args.dbPath ?? workspace.dbPath;
  const stateFile = args.stateFile ?? workspace.stateFile;
  const nowMs = Date.now();

  const previousState = args.mode === "incremental" ? loadState(stateFile) : null;
  const previousCursor = previousState?.cursor ?? null;
  const previousInsightKeys = previousState?.lastInsightKeys ?? [];

  const rows = runSqliteJson(dbPath, buildQuery(args.mode, previousCursor));
  const records = rows.map((row) => mapRow(row));
  const baselineRows = runSqliteJson(dbPath, buildQuery("full", null));
  const baselineRecords = baselineRows.map((row) => mapRow(row));
  const nextCursor = advanceCursor(records, previousCursor);
  const summary = summarizeRecords(records);
  const baselineSummary = summarizeRecords(baselineRecords);
  const reportWindowLabel = buildWindowLabel(args.mode, previousCursor, records);
  const outputPath = resolveOutputPath(workspace.reportsDir, nowMs, args.outputPath);
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
  const summaryMessage = buildSummaryMessage({
    sessionName: workspace.sessionName,
    reportWindowLabel,
    summary,
    baselineSummary,
    novelInsights,
    nextCursor,
  });

  const markdown = renderMarkdownReport({
    sessionName: workspace.sessionName,
    mode: args.mode,
    generatedAtMs: nowMs,
    reportWindowLabel,
    records,
    baselineRecords,
    summary,
    baselineSummary,
    previousCursor,
    nextCursor,
    previousInsightKeys,
    pmoInsights,
    novelInsights,
  });

  fs.writeFileSync(outputPath, markdown);

  if (args.writeState && nextCursor) {
    saveState(stateFile, {
      sessionName: workspace.sessionName,
      updatedAt: nowMs,
      cursor: nextCursor,
      lastReportPath: outputPath,
      lastInsightKeys: novelInsights.map((insight) => insight.key),
      lastSummaryText: summaryMessage,
    });
  }

  if (args.sendFeishu) {
    const chatId = resolveChatId(dbPath, workspace.sessionName);
    sendTextToFeishu(summaryMessage, chatId);
    sendReportToFeishu(outputPath, chatId);
  }

  const result = {
    mode: args.mode,
    recordCount: records.length,
    baselineRecordCount: baselineRecords.length,
    reportPath: outputPath,
    previousCursor,
    nextCursor,
    firstEventAt: summary.firstEventAt,
    lastEventAt: summary.lastEventAt,
    failures: summary.statusCounts.failed,
    pending: summary.statusCounts.pending,
    summaryMessage,
    novelInsightKeys: novelInsights.map((insight) => insight.key),
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
