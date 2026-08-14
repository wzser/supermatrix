import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceCursor,
  buildSummaryMessage,
  buildEventTimeMs,
  deriveContentFindings,
  derivePmoInsights,
  renderMarkdownReport,
  selectNovelInsights,
  summarizeRecords,
} from "../src/cross-session-review.mjs";

const sampleRecords = [
  {
    id: "comm-001",
    fromSession: "alpha",
    toSession: "beta",
    kind: "spawn",
    prompt: "请帮我检查调度器",
    childSessionId: "sess_child_001",
    status: "completed",
    resultPreview: "已完成检查",
    errorMessage: null,
    createdAt: 1713517200000,
    finishedAt: 1713517260000,
  },
  {
    id: "comm-002",
    fromSession: "alpha",
    toSession: "gamma",
    kind: "spawn",
    prompt: "请看一下最近失败的任务",
    childSessionId: "sess_child_002",
    status: "failed",
    resultPreview: null,
    errorMessage: "timeout",
    createdAt: 1713517320000,
    finishedAt: 1713517380000,
  },
  {
    id: "comm-003",
    fromSession: "delta",
    toSession: "beta",
    kind: "spawn",
    prompt: "同步一下最新知识库",
    childSessionId: null,
    status: "pending",
    resultPreview: null,
    errorMessage: null,
    createdAt: 1713517440000,
    finishedAt: null,
  },
];

const contentHeavyRecords = [
  {
    id: "comm-a",
    fromSession: "root",
    toSession: "watchdog",
    kind: "spawn",
    prompt: "请验证 backend selection 三个选项是否都生效",
    childSessionId: "sess-a",
    status: "completed",
    resultPreview: "已核实 Backend Selection 的 A/B/C 选项存在",
    errorMessage: null,
    createdAt: 1713517200000,
    finishedAt: 1713517260000,
  },
  {
    id: "comm-b",
    fromSession: "root",
    toSession: "skill-master",
    kind: "spawn",
    prompt: "post-migration 验证 SessionStart hook 是否命中",
    childSessionId: "sess-b",
    status: "completed",
    resultPreview: "SessionStart 注入成功，hook 已生效",
    errorMessage: null,
    createdAt: 1713517320000,
    finishedAt: 1713517380000,
  },
  {
    id: "comm-c",
    fromSession: "root",
    toSession: "watchdog",
    kind: "spawn",
    prompt: "调研 600s timeout 限制在哪一层",
    childSessionId: "sess-c",
    status: "completed",
    resultPreview: "确认 child session 默认 10 分钟超时",
    errorMessage: null,
    createdAt: 1713517440000,
    finishedAt: 1713517500000,
  },
  {
    id: "comm-d",
    fromSession: "root",
    toSession: "ads-master",
    kind: "spawn",
    prompt: "跟进昨天 pending 的 timeout 任务为什么还没闭环",
    childSessionId: "sess-d",
    status: "failed",
    resultPreview: null,
    errorMessage: "timeout while waiting for response",
    createdAt: 1713517560000,
    finishedAt: 1713517620000,
  },
  {
    id: "comm-e",
    fromSession: "root",
    toSession: "first-principle",
    kind: "spawn",
    prompt: "同步 session table 到 bitable，确认模板一致性",
    childSessionId: "sess-e",
    status: "completed",
    resultPreview: "bitable 同步完成",
    errorMessage: null,
    createdAt: 1713517680000,
    finishedAt: 1713517740000,
  },
];

test("buildEventTimeMs prefers finishedAt when present", () => {
  assert.equal(buildEventTimeMs(sampleRecords[0]), 1713517260000);
  assert.equal(buildEventTimeMs(sampleRecords[2]), 1713517440000);
});

test("advanceCursor returns latest event timestamp with tie-broken id", () => {
  const cursor = advanceCursor([
    ...sampleRecords,
    {
      ...sampleRecords[2],
      id: "comm-999",
      createdAt: 1713517440000,
    },
  ]);

  assert.deepEqual(cursor, {
    eventTimeMs: 1713517440000,
    id: "comm-999",
  });
});

test("summarizeRecords aggregates statuses, pairs, and latency leaders", () => {
  const summary = summarizeRecords(sampleRecords);

  assert.equal(summary.total, 3);
  assert.deepEqual(summary.statusCounts, {
    completed: 1,
    failed: 1,
    pending: 1,
  });
  assert.equal(summary.topPairs[0].fromSession, "alpha");
  assert.equal(summary.topPairs[0].toSession, "beta");
  assert.equal(summary.topPairs[0].count, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.pending.length, 1);
  assert.equal(summary.longestCompleted[0].durationMs, 60000);
});

test("derivePmoInsights answers the fixed PMO questions with evidence-aware conclusions", () => {
  const windowSummary = summarizeRecords(sampleRecords);
  const baselineSummary = summarizeRecords(sampleRecords);
  const insights = derivePmoInsights({
    records: sampleRecords,
    summary: windowSummary,
    baselineRecords: sampleRecords,
    baselineSummary,
  });

  assert.equal(insights.questions.length, 7);
  assert.match(insights.questions[0].question, /系统性摩擦/);
  assert.match(insights.questions[0].answer, /alpha ->/);
  assert.match(insights.questions[1].answer, /系统|证据不足|混合/);
  assert.match(insights.questions[2].answer, /权责|KPI|证据不足/);
  assert.match(insights.questions[3].answer, /SOP|自动化|重复/);
  assert.match(insights.questions[4].answer, /候选|基准|session/);
  assert.match(insights.questions[5].answer, /PDCA|止血/);
  assert.match(insights.questions[6].answer, /系统建设|重构|长期/);
});

test("deriveContentFindings extracts repeated content themes and representative snippets", () => {
  const findings = deriveContentFindings(contentHeavyRecords);

  assert.ok(findings.length >= 2);
  assert.match(findings[0].title, /验证|超时|同步/);
  assert.ok(findings[0].snippets.length >= 1);
  assert.match(findings[0].snippets[0], /backend selection|SessionStart|timeout|bitable/);
});

test("selectNovelInsights avoids repeating the previous report insight keys", () => {
  const summary = summarizeRecords(sampleRecords);
  const pmoInsights = derivePmoInsights({
    records: sampleRecords,
    summary,
    baselineRecords: sampleRecords,
    baselineSummary: summary,
    generatedAtMs: 1713603600000,
  });

  const firstBatch = selectNovelInsights({
    pmoInsights,
    summary,
    baselineSummary: summary,
    previousInsightKeys: [],
  });
  const secondBatch = selectNovelInsights({
    pmoInsights,
    summary,
    baselineSummary: summary,
    previousInsightKeys: firstBatch.map((insight) => insight.key),
  });

  assert.equal(firstBatch.length, 1);
  assert.equal(secondBatch.length, 1);
  for (const insight of secondBatch) {
    assert.equal(firstBatch.some((previous) => previous.key === insight.key), false);
  }
});

test("buildSummaryMessage includes summary and new insights for Feishu delivery", () => {
  const summary = summarizeRecords(sampleRecords);
  const pmoInsights = derivePmoInsights({
    records: sampleRecords,
    summary,
    baselineRecords: sampleRecords,
    baselineSummary: summary,
    generatedAtMs: 1713603600000,
  });
  const novelInsights = selectNovelInsights({
    pmoInsights,
    summary,
    baselineSummary: summary,
    previousInsightKeys: [],
  });

  const message = buildSummaryMessage({
    sessionName: "socail-king",
    reportWindowLabel: "全量历史",
    summary,
    baselineSummary: summary,
    novelInsights,
    nextCursor: { eventTimeMs: 1713517440000, id: "comm-003" },
  });

  assert.match(message, /PMO 摘要/);
  assert.match(message, /本次新增认知/);
  assert.match(message, /comm-003/);
  assert.match(message, /系统性摩擦|重复劳动|单点归口|基准制定者/);
});

test("renderMarkdownReport includes key summary sections and details", () => {
  const summary = summarizeRecords(sampleRecords);
  const baselineSummary = summarizeRecords(sampleRecords);
  const markdown = renderMarkdownReport({
    sessionName: "socail-king",
    mode: "full",
    generatedAtMs: 1713603600000,
    reportWindowLabel: "全量历史",
    records: sampleRecords,
    baselineRecords: sampleRecords,
    summary,
    baselineSummary,
    previousCursor: null,
    nextCursor: { eventTimeMs: 1713517440000, id: "comm-003" },
  });

  assert.match(markdown, /# Session 通讯回顾报告/);
  assert.match(markdown, /## 本次新增认知/);
  assert.match(markdown, /## 内容洞察/);
  assert.match(markdown, /## PMO 必答题/);
  assert.match(markdown, /Q1\. 当前最突出的系统性摩擦点集中在哪些业务环节/);
  assert.match(markdown, /Q7\. 长期来看，系统建设应该往哪里重构/);
  assert.match(markdown, /证据等级/);
  assert.match(markdown, /全量历史/);
  assert.match(markdown, /alpha -> beta/);
  assert.match(markdown, /timeout/);
  assert.match(markdown, /comm-003/);
});
