import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDraftAnalysisPrompt,
  buildOrchestrationPaths,
  buildSessionResultUrl,
  buildRevisionPrompt,
  buildReviewChecklist,
  DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS,
  spawnAndCollectResult,
  waitForSessionResult,
  reviewDraftArtifacts,
} from "../src/cross-session-review-orchestration.mjs";

test("buildOrchestrationPaths returns draft/final/context and summary paths", () => {
  const paths = buildOrchestrationPaths({
    reportsDir: "/tmp/reports",
    timestampToken: "20260420094500",
  });

  assert.equal(paths.contextPath, "/tmp/reports/context/20260420094500-cross-session-review-context.json");
  assert.equal(paths.draftReportPath, "/tmp/reports/20260420094500-cross-session-review-draft.md");
  assert.equal(paths.finalReportPath, "/tmp/reports/20260420094500-cross-session-review.md");
  assert.equal(paths.draftSummaryPath, "/tmp/reports/20260420094500-cross-session-review-draft-summary.txt");
  assert.equal(paths.finalSummaryPath, "/tmp/reports/20260420094500-cross-session-review-summary.txt");
});

test("buildDraftAnalysisPrompt forces the child session to analyze content and write draft artifacts only", () => {
  const prompt = buildDraftAnalysisPrompt({
    contextPath: "/tmp/context.json",
    draftReportPath: "/tmp/draft.md",
    draftSummaryPath: "/tmp/draft-summary.txt",
  });

  assert.match(prompt, /读取 .*context\.json/);
  assert.match(prompt, /meta\.sopPath/);
  assert.match(prompt, /先读取该 SOP/);
  assert.match(prompt, /必须具体看沟通内容/);
  assert.match(prompt, /只写 draft/);
  assert.match(prompt, /不要发送飞书/);
  assert.match(prompt, /PMO/);
  assert.match(prompt, /思考题/);
  assert.match(prompt, /所有沟通记录|baselineRecords/);
  assert.match(prompt, /回答解答|回答/);
  assert.match(prompt, /不要粘贴报告全文/);
  assert.doesNotMatch(prompt, /BEGIN_DRAFT_REPORT/);
  assert.doesNotMatch(prompt, /BEGIN_DRAFT_SUMMARY/);
});

test("buildDraftAnalysisPrompt asks for one high-quality main insight instead of multiple shallow insights", () => {
  const prompt = buildDraftAnalysisPrompt({
    contextPath: "/tmp/context.json",
    draftReportPath: "/tmp/draft.md",
    draftSummaryPath: "/tmp/draft-summary.txt",
  });

  assert.match(prompt, /1 个.*主洞察/);
  assert.match(prompt, /事实链/);
  assert.match(prompt, /偏差/);
  assert.match(prompt, /修正/);
  assert.doesNotMatch(prompt, /1-3 条/);
});

test("buildDraftAnalysisPrompt requires a sub-200-char summary with inferred impact", () => {
  const prompt = buildDraftAnalysisPrompt({
    contextPath: "/tmp/context.json",
    draftReportPath: "/tmp/draft.md",
    draftSummaryPath: "/tmp/draft-summary.txt",
  });

  assert.match(prompt, /200 字/);
  assert.match(prompt, /影响推测|实际影响/);
  assert.match(prompt, /置信度|判断性质/);
});

test("buildRevisionPrompt requires the second child to address review feedback before final output", () => {
  const prompt = buildRevisionPrompt({
    contextPath: "/tmp/context.json",
    draftReportPath: "/tmp/draft.md",
    finalReportPath: "/tmp/final.md",
    finalSummaryPath: "/tmp/final-summary.txt",
    feedback: [
      "Q1 还是太偏数量，需要具体引用内容片段",
      "摘要必须写清楚这次新增认知和上次的差异",
    ],
  });

  assert.match(prompt, /根据下面的反馈逐条修订/);
  assert.match(prompt, /meta\.sopPath/);
  assert.match(prompt, /先读取该 SOP/);
  assert.match(prompt, /Q1 还是太偏数量/);
  assert.match(prompt, /摘要必须写清楚/);
  assert.match(prompt, /写入 final/);
  assert.match(prompt, /不要直接发送/);
  assert.match(prompt, /思考题/);
  assert.match(prompt, /不要粘贴报告全文/);
  assert.doesNotMatch(prompt, /BEGIN_FINAL_REPORT/);
  assert.doesNotMatch(prompt, /BEGIN_FINAL_SUMMARY/);
});

test("buildReviewChecklist includes the required reviewer gates", () => {
  const checklist = buildReviewChecklist();

  assert.ok(checklist.length >= 5);
  assert.equal(checklist.some((item) => /内容片段/.test(item)), true);
  assert.equal(checklist.some((item) => /新增认知/.test(item)), true);
  assert.equal(checklist.some((item) => /摘要.*200/.test(item)), true);
  assert.equal(checklist.some((item) => /影响推测|实际影响/.test(item)), true);
  assert.equal(checklist.some((item) => /摘要.*文档/.test(item)), true);
  assert.equal(checklist.some((item) => /思考题/.test(item)), true);
});

test("orchestrated child session wait has enough headroom for slow artifact writes", () => {
  assert.equal(DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS, 8 * 60 * 1000);
  assert.ok(DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS > 6 * 60 * 1000);
  assert.ok(DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS * 2 + 2 * 45_000 < 20 * 60 * 1000);
});

test("buildSessionResultUrl derives the result endpoint from the spawn endpoint", () => {
  assert.equal(
    buildSessionResultUrl("http://127.0.0.1:3501/api/spawn", "sess_child_123"),
    "http://127.0.0.1:3501/api/sessions/sess_child_123/result",
  );
  assert.equal(
    buildSessionResultUrl("http://localhost:3501/api/spawn", "sess_child_123"),
    "http://127.0.0.1:3501/api/sessions/sess_child_123/result",
  );
});

test("spawnAndCollectResult omits public spawn mode and polls the child result endpoint", async () => {
  const requests = [];

  const result = await spawnAndCollectResult({
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
    target: "mythos",
    from: "socail-king",
    backend: "claude",
    prompt: "draft prompt",
    dbPath: "/tmp/supermatrix.db",
    pollIntervalMs: 1,
    maxWaitMs: 1000,
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });

      if (options.method === "POST") {
        return {
          ok: true,
          status: 202,
          async json() {
            return {
              ok: true,
              mode: "async_kickoff",
              childSessionId: "sess_child_123",
              childSessionName: "child_mythos_123",
              messageRunId: "run_123",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            status: "completed",
            childSessionId: "sess_child_123",
            finalMessage: "done",
          };
        },
      };
    },
  });

  assert.equal(Object.hasOwn(requests[0].body, "mode"), false);
  assert.equal(requests[0].body.target, "mythos");
  assert.equal(requests[0].body.from, "socail-king");
  assert.equal(requests[1].url, "http://127.0.0.1:3501/api/sessions/sess_child_123/result");
  assert.equal(result.finalMessage, "done");
});

test("spawnAndCollectResult recovers the child session after spawn fetch fails and polls until completion", async () => {
  const fetchCalls = [];
  let resultPolls = 0;

  const result = await spawnAndCollectResult({
    spawnUrl: "http://localhost:3501/api/spawn",
    target: "mythos",
    backend: "claude",
    prompt: "draft prompt",
    dbPath: "/tmp/supermatrix.db",
    requestTimeoutMs: 1000,
    pollIntervalMs: 1,
    maxWaitMs: 1000,
    now: (() => {
      let current = 1_000;
      return () => {
        current += 100;
        return current;
      };
    })(),
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, method: options?.method ?? "GET" });
      if (options?.method === "POST") {
        throw new TypeError("fetch failed");
      }

      resultPolls += 1;
      if (resultPolls === 1) {
        return {
          ok: true,
          status: 202,
          async json() {
            return {
              ok: true,
              status: "running",
              childSessionId: "sess_child_123",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            status: "completed",
            childSessionId: "sess_child_123",
            finalMessage: "done",
            startedAt: 1_000,
            finishedAt: 2_000,
          };
        },
      };
    },
    queryJson: (_dbPath, sql) => {
      assert.match(sql, /parent\.name = 'mythos'/);
      assert.match(sql, /mr\.prompt = 'draft prompt'/);
      return [{ child_session_id: "sess_child_123" }];
    },
  });

  assert.equal(result.childSessionId, "sess_child_123");
  assert.equal(result.finalMessage, "done");
  assert.deepEqual(fetchCalls, [
    { url: "http://127.0.0.1:3501/api/spawn", method: "POST" },
    { url: "http://127.0.0.1:3501/api/sessions/sess_child_123/result", method: "GET" },
    { url: "http://127.0.0.1:3501/api/sessions/sess_child_123/result", method: "GET" },
  ]);
});

test("spawnAndCollectResult surfaces a clear error when the child session cannot be recovered", async () => {
  await assert.rejects(
    () =>
      spawnAndCollectResult({
        spawnUrl: "http://127.0.0.1:3501/api/spawn",
        target: "mythos",
        backend: "claude",
        prompt: "draft prompt",
        dbPath: "/tmp/supermatrix.db",
        requestTimeoutMs: 1000,
        recoveryWaitMs: 0,
        pollIntervalMs: 1,
        maxWaitMs: 1000,
        now: () => 1_000,
        sleep: async () => {},
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
        queryJson: () => [],
      }),
    /无法恢复 childSessionId/,
  );
});

test("waitForSessionResult can return after expected artifacts are stable while child is still running", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-session-artifacts-"));
  const reportPath = path.join(tmpDir, "report.md");
  const summaryPath = path.join(tmpDir, "summary.txt");
  fs.writeFileSync(reportPath, "# report\n");
  fs.writeFileSync(summaryPath, "summary\n");

  const fetchCalls = [];
  const result = await waitForSessionResult({
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
    childSessionId: "sess_child_123",
    artifactPaths: [reportPath, summaryPath],
    pollIntervalMs: 1,
    maxWaitMs: 10_000,
    sleep: async () => {},
    now: (() => {
      let current = 1_000;
      return () => {
        current += 100;
        return current;
      };
    })(),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, method: options?.method ?? "GET" });
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            ok: true,
            status: "running",
            childSessionId: "sess_child_123",
          };
        },
      };
    },
  });

  assert.equal(result.childSessionId, "sess_child_123");
  assert.equal(result.status, "artifacts_ready");
  assert.equal(result.finalMessage, "");
  assert.equal(fetchCalls.length, 2);
});

test("waitForSessionResult retries a transient result fetch failure", async () => {
  let fetchCalls = 0;

  const result = await waitForSessionResult({
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
    childSessionId: "sess_child_123",
    pollIntervalMs: 1,
    maxWaitMs: 10_000,
    sleep: async () => {},
    now: (() => {
      let current = 1_000;
      return () => {
        current += 100;
        return current;
      };
    })(),
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new TypeError("fetch failed");
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            status: "completed",
            childSessionId: "sess_child_123",
            finalMessage: "done",
          };
        },
      };
    },
  });

  assert.equal(fetchCalls, 2);
  assert.equal(result.finalMessage, "done");
});

test("reviewDraftArtifacts requires a thinking-question section with answer based on all communications", () => {
  const review = reviewDraftArtifacts({
    reportText: `# x

## 本次新增认知

1. 新判断
2. 第二条新判断

### Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？
内容片段：Prompt: a
### Q2. 这些摩擦更像“人”的问题还是“系统”的问题？
内容片段：Result: b
### Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
内容片段：Error: c
### Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？
内容片段：Prompt: d
### Q5. 谁是当前最像“基准制定者”的 session（会话）？
内容片段：Result: e
### Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
内容片段：Prompt: f
### Q7. 长期来看，系统建设应该往哪里重构？
内容片段：Result: g
`,
    summaryText: `PMO 摘要 | socail-king
窗口：全量历史
本次新增认知：
1. a
文档同时交付`,
    previousSummaryText: "旧摘要",
    ensureFollowup: false,
  });

  assert.equal(review.gates.some((gate) => gate.label === "思考题" && gate.passed === false), true);
  assert.equal(review.feedback.some((item) => /思考题/.test(item)), true);
});

test("reviewDraftArtifacts accepts one actionable main insight when it has a factual chain and system fix", () => {
  const review = reviewDraftArtifacts({
    reportText: `# x

## 本次新增认知

- 主洞察：与上次相比，本次发现 FP 没有采用源文档优先分发，而是先蒸馏成模板；事实链是 root 产出源文档、FP 写入 Principles、scheduler 发送摘要；偏差是相关 session 没有直接读取原文；系统修正是把 source-first 分发写入门禁。

## 本次思考题

- 问题：所有新机制分发是否都要求直接读取源文档？
- 检查范围：所有沟通记录和全量 baselineRecords。
- 发现：内容片段：Prompt: 请确认是否让各 session 直接读取源文档。
- 回答解答：当前没有统一强制，应建立 source-first 门禁。

## PMO 必答题

### Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？
内容片段：Prompt: a
### Q2. 这些摩擦更像“人”的问题还是“系统”的问题？
内容片段：Result: b
### Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
内容片段：Error: c
### Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？
内容片段：Prompt: d
### Q5. 谁是当前最像“基准制定者”的 session（会话）？
内容片段：Result: e
### Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
内容片段：Prompt: f
### Q7. 长期来看，系统建设应该往哪里重构？
内容片段：Result: g
`,
    summaryText: `窗口：全量历史
状态概览：正常
问题：FP 未让 session 直读源文档。影响推测：规则会被二次蒸馏后失真，执行偏差扩大。置信度：中。已附文档。`,
    previousSummaryText: "旧摘要：调度超时问题",
    ensureFollowup: false,
  });

  const insightGate = review.gates.find((gate) => gate.label === "新增认知");
  assert.equal(insightGate?.passed, true);
  assert.equal(review.feedback.some((item) => /新增认知/.test(item)), false);
});

test("reviewDraftArtifacts recognizes numbered section headings and comm id evidence", () => {
  const review = reviewDraftArtifacts({
    reportText: `# x

## 二、本次新增认知（主洞察）

主洞察：与上次相比，本次发生了 scheduler 自审后反向问责 socail-king 的新链路；事实链是 scheduler 产出失败清单、socail-king 处理自身任务、mythos 继续写报告；偏差是 PMO 自己监督自己，实际机制偏离第三方审核；下一步修正是把 socail-king 自审交给 watchdog 门禁。

## 三、本次思考题（组织层面）

- 问题：PMO 自身任务是否应该纳入第三方监督？
- 检查范围：所有沟通记录和全量 baselineRecords。
- 发现：comm_f75cf02f_1776789259461 Result 显示 socail-king 自己决定不要 disable。
- 回答解答：应该纳入第三方监督，由 watchdog 检查 socail-king 的定时任务健康度。

## 四、PMO 必答题

### Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？
内容片段：Prompt: a
### Q2. 这些摩擦更像“人”的问题还是“系统”的问题？
内容片段：Result: b
### Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
内容片段：Error: c
### Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？
内容片段：Prompt: d
### Q5. 谁是当前最像“基准制定者”的 session（会话）？
内容片段：Result: e
### Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
内容片段：Prompt: f
### Q7. 长期来看，系统建设应该往哪里重构？
内容片段：Result: g
`,
    summaryText: `窗口：2026-04-20 之后
问题：PMO 自审。影响推测：错误会被自己放过，日常报告失真。置信度：中高。已附文档。`,
    previousSummaryText: "旧摘要",
    ensureFollowup: false,
  });

  assert.equal(review.gates.find((gate) => gate.label === "新增认知")?.passed, true);
  assert.equal(review.gates.find((gate) => gate.label === "思考题")?.passed, true);
});

test("reviewDraftArtifacts accepts bracketed summary window labels and 与上一次 wording", () => {
  const review = reviewDraftArtifacts({
    reportText: `# x

## 零、与上一次报告相比，差异一览

本次新增认知与上一次报告相比，治理窗口从等待超时前移到 child session 调用模式。

## 二、本次新增认知

主洞察：与上一次相比，本次发生了 sync_inline 长任务被父流程局部等待预算切断的问题；事实链是父流程 POST /api/spawn、child 继续运行并写文件、父流程先报超时；偏差是实际机制偏离 async_kickoff + pollable result；下一步修正是改为 async_kickoff 并轮询结果端点。

## 三、本次思考题

- 问题：长任务是否仍在使用 sync_inline？
- 检查范围：所有沟通记录和全量 baselineRecords。
- 发现：comm_632227b6 Error 显示等待 child session 结果超时。
- 回答解答：应该改为 async_kickoff。

## 四、PMO 必答题

### Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？
内容片段：Prompt: a
### Q2. 这些摩擦更像“人”的问题还是“系统”的问题？
内容片段：Result: b
### Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
内容片段：Error: c
### Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？
内容片段：Prompt: d
### Q5. 谁是当前最像“基准制定者”的 session（会话）？
内容片段：Result: e
### Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
内容片段：Prompt: f
### Q7. 长期来看，系统建设应该往哪里重构？
内容片段：Result: g
`,
    summaryText: `【报告窗口】04-23。
问题：长任务仍走 sync_inline。影响推测：父流程会误报超时并重复派单。置信度：高。已附文档。`,
    previousSummaryText: "旧摘要",
    ensureFollowup: false,
  });

  assert.equal(review.gates.find((gate) => gate.label === "与上次差异")?.passed, true);
  assert.equal(review.gates.find((gate) => gate.label === "摘要完整度")?.passed, true);
});

test("reviewDraftArtifacts rejects summaries longer than 200 chars or without impact inference", () => {
  const review = reviewDraftArtifacts({
    reportText: `# x

## 本次新增认知

主洞察：与上次相比，本次发现 scheduler prompt 失真；事实链是 prompt 写死旧数字、child 按错前提执行；偏差是认知没有跟 runtime 对齐；下一步修正是模板化并插值。

## 本次思考题

- 问题：prompt 是否仍在复制瞬态事实？
- 检查范围：所有沟通记录和全量 baselineRecords。
- 发现：comm_x Prompt: old fact
- 回答解答：应改为 runtime snapshot。

## PMO 必答题

### Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？
内容片段：Prompt: a
### Q2. 这些摩擦更像“人”的问题还是“系统”的问题？
内容片段：Result: b
### Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？
内容片段：Error: c
### Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？
内容片段：Prompt: d
### Q5. 谁是当前最像“基准制定者”的 session（会话）？
内容片段：Result: e
### Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？
内容片段：Prompt: f
### Q7. 长期来看，系统建设应该往哪里重构？
内容片段：Result: g
`,
    summaryText: `这是一个很长很长的摘要，它虽然提到了问题、窗口和文档，但一直在复述事实，没有明确说实际影响是什么，也没有置信度，而且长度会明显超过两百字，因为它继续堆很多背景、过程、细节、上下文、例子和解释，让摘要失去摘要的意义。为了确保一定超过两百字，我再补一段同类废话：它继续展开无关背景、重复同一判断、罗列不必要过程、堆叠多余修饰，让摘要失去摘要的意义。再补一段：它继续展开无关背景、重复同一判断、罗列不必要过程、堆叠多余修饰，让摘要失去摘要的意义。`,
    previousSummaryText: "旧摘要",
    ensureFollowup: false,
  });

  assert.equal(review.gates.find((gate) => gate.label === "摘要完整度")?.passed, false);
  assert.equal(review.feedback.some((item) => /200 字|影响推测|置信度/.test(item)), true);
});
