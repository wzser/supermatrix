import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PMO_QUESTION_TEXT = [
  "Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？",
  "Q2. 这些摩擦更像“人”的问题还是“系统”的问题？",
  "Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？",
  "Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？",
  "Q5. 谁是当前最像“基准制定者”的 session（会话）？",
  "Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？",
  "Q7. 长期来看，系统建设应该往哪里重构？",
];

export const DEFAULT_ORCHESTRATED_CHILD_SESSION_MAX_WAIT_MS = 8 * 60 * 1000;

export function buildOrchestrationPaths({ reportsDir, timestampToken }) {
  return {
    contextPath: path.join(reportsDir, "context", `${timestampToken}-cross-session-review-context.json`),
    draftReportPath: path.join(reportsDir, `${timestampToken}-cross-session-review-draft.md`),
    finalReportPath: path.join(reportsDir, `${timestampToken}-cross-session-review.md`),
    draftSummaryPath: path.join(reportsDir, `${timestampToken}-cross-session-review-draft-summary.txt`),
    finalSummaryPath: path.join(reportsDir, `${timestampToken}-cross-session-review-summary.txt`),
    feedbackPath: path.join(reportsDir, "review", `${timestampToken}-cross-session-review-feedback.txt`),
  };
}

export function buildReviewChecklist() {
  return [
    "报告必须逐题回答 7 个 PMO 必答题，不能跳题，至少出现 Q1-Q7。",
    "每个重点判断都要有内容片段证据，不能只给数量统计；至少多处出现“内容片段”或 Prompt/Result/Error 引用。",
    "必须有“本次新增认知”章节，每天只需要 1 个高质量主洞察；主洞察必须写清事实链、偏差和修正动作。",
    "主洞察必须给出“实际影响推测”，并明确这是判断而非既成事实；最好带置信度。",
    "必须有“本次思考题”章节：题目要由本次阅读自行提出，并且基于所有沟通记录或全量背景做检查，最后给出回答解答。",
    "摘要必须独立可读，且总长度不超过 200 字；只保留问题、影响推测、置信度、文档已附。",
    "摘要要明确摘要与文档会同时发送，不能只给摘要不提文档。",
    "报告里要给出可执行建议，至少覆盖短期 PDCA（计划-执行-检查-处理）止血和长期系统重构方向。",
  ];
}

function renderChecklistLines() {
  return buildReviewChecklist()
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

function sqlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function defaultQueryJson(dbPath, sql) {
  const stdout = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause
    ? error.cause.code ?? error.cause.message ?? String(error.cause)
    : null;
  return cause ? `${error.message} (cause: ${cause})` : error.message;
}

function isPendingStatus(status) {
  return ["queued", "pending", "running", "busy"].includes(String(status ?? "").toLowerCase());
}

function isFailedStatus(status) {
  return ["error", "failed", "timeout", "cancelled"].includes(String(status ?? "").toLowerCase());
}

function normalizeSpawnPayload(payload, childSessionId) {
  return {
    ok: true,
    childSessionId: payload.childSessionId ?? childSessionId,
    childSessionName: payload.childSessionName ?? null,
    status: payload.status ?? "completed",
    finalMessage: payload.finalMessage ?? "",
    errorMessage: payload.errorMessage ?? null,
    startedAt: payload.startedAt ?? null,
    finishedAt: payload.finishedAt ?? null,
  };
}

function readArtifactSnapshot(artifactPaths) {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) return null;

  const files = [];
  for (const artifactPath of artifactPaths) {
    let stat;
    try {
      stat = fs.statSync(artifactPath);
    } catch {
      return null;
    }

    if (!stat.isFile() || stat.size <= 0) return null;
    files.push({
      path: artifactPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return files;
}

function sameArtifactSnapshot(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.path === other.path && item.size === other.size && item.mtimeMs === other.mtimeMs;
  });
}

function normalizeLoopbackUrl(input) {
  const url = new URL(input);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url;
}

export function buildSessionResultUrl(spawnUrl, childSessionId) {
  const url = normalizeLoopbackUrl(spawnUrl);
  url.pathname = `/api/sessions/${encodeURIComponent(childSessionId)}/result`;
  url.search = "";
  return url.toString();
}

export function findSpawnedChildSessionId({
  dbPath,
  target,
  prompt,
  startedAfterMs,
  queryJson = defaultQueryJson,
}) {
  const sql = `
    SELECT child.id AS child_session_id
    FROM message_runs mr
    JOIN sessions child ON child.id = mr.session_id
    JOIN sessions parent ON parent.id = child.parent_id
    WHERE parent.name = ${sqlQuote(target)}
      AND child.scope = 'child'
      AND mr.prompt = ${sqlQuote(prompt)}
      AND mr.started_at >= ${Math.max(0, Math.floor(startedAfterMs) - 1000)}
    ORDER BY mr.started_at DESC
    LIMIT 1;
  `;
  const rows = queryJson(dbPath, sql);
  return rows[0]?.child_session_id ?? null;
}

async function recoverChildSessionId({
  dbPath,
  target,
  prompt,
  startedAfterMs,
  recoveryWaitMs,
  pollIntervalMs,
  queryJson,
  sleep,
  now,
}) {
  const deadline = now() + recoveryWaitMs;

  while (true) {
    const childSessionId = findSpawnedChildSessionId({
      dbPath,
      target,
      prompt,
      startedAfterMs,
      queryJson,
    });
    if (childSessionId) return childSessionId;
    if (now() >= deadline) return null;
    await sleep(pollIntervalMs);
  }
}

export async function waitForSessionResult({
  spawnUrl,
  childSessionId,
  artifactPaths = [],
  artifactStablePolls = 2,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = Date.now,
  pollIntervalMs = 5_000,
  maxWaitMs = 14 * 60 * 1000,
}) {
  const resultUrl = buildSessionResultUrl(spawnUrl, childSessionId);
  const deadline = now() + maxWaitMs;
  let previousArtifactSnapshot = null;
  let stableArtifactPolls = 0;

  while (true) {
    let response;
    let payload;

    try {
      response = await fetchImpl(resultUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });
      payload = await response.json();
    } catch (error) {
      if (now() >= deadline) {
        throw new Error(`读取 child session ${childSessionId} 结果失败: ${summarizeError(error)}`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (response.status === 202 || isPendingStatus(payload.status)) {
      const artifactSnapshot = readArtifactSnapshot(artifactPaths);
      if (artifactSnapshot) {
        stableArtifactPolls = sameArtifactSnapshot(artifactSnapshot, previousArtifactSnapshot)
          ? stableArtifactPolls + 1
          : 1;
        previousArtifactSnapshot = artifactSnapshot;

        if (stableArtifactPolls >= artifactStablePolls) {
          return normalizeSpawnPayload(
            {
              childSessionId,
              status: "artifacts_ready",
              finalMessage: "",
              startedAt: payload.startedAt ?? null,
              finishedAt: null,
            },
            childSessionId,
          );
        }
      } else {
        previousArtifactSnapshot = null;
        stableArtifactPolls = 0;
      }

      if (now() >= deadline) {
        throw new Error(`等待 child session ${childSessionId} 结果超时`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error ?? `读取 child session ${childSessionId} 结果失败: HTTP ${response.status}`);
    }

    if (isFailedStatus(payload.status)) {
      throw new Error(payload.errorMessage ?? `child session ${childSessionId} 执行失败`);
    }

    return normalizeSpawnPayload(payload, childSessionId);
  }
}

export async function spawnAndCollectResult({
  spawnUrl,
  target,
  from,
  backend,
  prompt,
  dbPath,
  verificationPredicate = null,
  requestTimeoutMs = 10_000,
  recoveryWaitMs = 15_000,
  pollIntervalMs = 5_000,
  maxWaitMs = 14 * 60 * 1000,
  artifactPaths = [],
  fetchImpl = fetch,
  queryJson = defaultQueryJson,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const startedAtMs = now();
  const normalizedSpawnUrl = normalizeLoopbackUrl(spawnUrl).toString();

  try {
    const body = {
      target,
      backend,
      prompt,
    };
    if (from) {
      body.from = from;
    }
    if (verificationPredicate) {
      body.verification_predicate = verificationPredicate;
    }
    const response = await fetchImpl(normalizedSpawnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`spawn 请求失败: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error ?? "spawn 返回失败");
    }

    if (payload.childSessionId && !payload.finalMessage) {
      return waitForSessionResult({
        spawnUrl: normalizedSpawnUrl,
        childSessionId: payload.childSessionId,
        artifactPaths,
        fetchImpl,
        sleep,
        now,
        pollIntervalMs,
        maxWaitMs,
      });
    }

    return normalizeSpawnPayload(payload, payload.childSessionId ?? null);
  } catch (error) {
    const childSessionId = await recoverChildSessionId({
      dbPath,
      target,
      prompt,
      startedAfterMs: startedAtMs,
      recoveryWaitMs,
      pollIntervalMs: Math.min(pollIntervalMs, 1_000),
      queryJson,
      sleep,
      now,
    });

    if (!childSessionId) {
      throw new Error(`${summarizeError(error)}；且无法恢复 childSessionId 以继续轮询结果`);
    }

    return waitForSessionResult({
      spawnUrl: normalizedSpawnUrl,
      childSessionId,
      artifactPaths,
      fetchImpl,
      sleep,
      now,
      pollIntervalMs,
      maxWaitMs,
    });
  }
}

export function buildDraftAnalysisPrompt({
  contextPath,
  draftReportPath,
  draftSummaryPath,
}) {
  return `你是 socail-king 拉起的 PMO（项目管理办公室）分析子 session（子会话）。

任务边界：
- 读取 ${contextPath}
- context.meta.sopPath 指向本任务 SOP（标准作业程序）；先读取该 SOP，再按 SOP 和本 prompt 执行
- 必须具体看沟通内容，重点读 records / baselineRecords 里的 prompt、resultPreview、errorMessage，不能只看数量统计
- 你只写 draft，不要发送飞书，也不要修改 state
- 报告必须是 PMO 视角，不是流水账

输出要求：
1. 把 draft 报告写到 ${draftReportPath}
2. 把 draft 摘要写到 ${draftSummaryPath}
3. 必须直接写文件；如果无法写文件，finalMessage 明确返回 ERROR 和原因
4. finalMessage 不要粘贴报告全文或摘要全文，避免定时任务因长消息超时
5. 报告必须包含这些固定结构：
   - 总览
   - 本次新增认知
   - 本次思考题
   - PMO 必答题
   - 内容洞察
   - 数据支撑
   - 本次窗口记录明细
6. “PMO 必答题”必须逐题回答：
${PMO_QUESTION_TEXT.map((item) => `   - ${item}`).join("\n")}
7. 每题至少包含：
   - 结论
   - 证据等级
   - 内容片段
   - 解释 / 建议
8. “本次新增认知”每天只写 1 个高质量主洞察，不要凑多条浅层判断：
   - 必须写清事实链：谁产出了什么、谁如何分发或处理、实际结果是什么
   - 必须写清偏差：实际机制偏离了什么更简单高效的工作方式
   - 必须写清修正动作：短期门禁或长期系统机制怎么改
   - 必须写清你推测的实际影响，并标明这是推测/判断，不要写成已证实事实；尽量给置信度
   - 必须说明与上次相比的新认识
9. 摘要必须包含：
   - 最多 200 字，宁可少，不要铺陈
   - 只写 1 个问题
   - 写清影响推测
   - 写清置信度
   - 明确已附文档
10. 报告必须新增“本次思考题”章节：
   - 题目由你自己提出，不要复用固定模板
   - 题目必须是组织/系统层面的，例如“所有的命名规则是否有统一规范？”
   - 必须从所有沟通记录做横向检查，至少覆盖全量背景，不允许只看当天增量
   - 必须写清：问题、检查范围、发现、回答解答
   - 回答必须回到具体沟通内容，至少附 1 条内容片段证据

审核清单：
${renderChecklistLines()}

finalMessage 只回复这几行：
Status: DONE
DraftReport: ${draftReportPath}
DraftSummary: ${draftSummaryPath}
Notes: 用一句话说明这版 draft 最突出的系统性摩擦。`;
}

export function buildRevisionPrompt({
  contextPath,
  draftReportPath,
  finalReportPath,
  finalSummaryPath,
  feedback,
}) {
  const feedbackLines = feedback.map((item, index) => `${index + 1}. ${item}`).join("\n");

  return `你是 socail-king 拉起的 PMO（项目管理办公室）修订子 session（子会话）。

请读取：
- 上下文：${contextPath}
- 上下文里的 meta.sopPath 指向本任务 SOP（标准作业程序），先读取该 SOP
- draft 报告：${draftReportPath}

根据下面的反馈逐条修订，不能漏项：
${feedbackLines}

修订要求：
- 必须具体补强内容片段证据，而不是把数量换一种说法
- 必须保留 7 个 PMO 必答题并逐题回答
- “本次新增认知”每天只保留 1 个高质量主洞察，必须清楚写出与上次相比的新判断、事实链、偏差和修正动作
- 必须补出“实际影响推测”和置信度，方便用户判断这次推测是否准确
- 必须保留并补强“本次思考题”，确认它来自本次阅读、覆盖全量沟通记录，并给出明确回答解答
- 摘要必须压到 200 字以内，同时写清问题、影响推测、置信度和已附完整文档
- 这是写入 final 的版本，不要直接发送，不要改 state
- 必须直接写文件；如果无法写文件，finalMessage 明确返回 ERROR 和原因
- finalMessage 不要粘贴报告全文或摘要全文，避免定时任务因长消息超时

输出到：
- final 报告：${finalReportPath}
- final 摘要：${finalSummaryPath}

finalMessage 只回复这几行：
Status: DONE
FinalReport: ${finalReportPath}
FinalSummary: ${finalSummaryPath}
Notes: 用一句话说明你如何响应了审核反馈。`;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findSection(text, heading) {
  const lines = String(text ?? "").split(/\r?\n/);
  let startIndex = -1;
  let startLevel = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    if (!match[2].includes(heading)) continue;
    startIndex = index + 1;
    startLevel = match[1].length;
    break;
  }

  if (startIndex < 0) return "";

  let endIndex = lines.length;
  for (let index = startIndex; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,6})\s+/);
    if (match && match[1].length <= startLevel) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n").trim();
}

function extractListItems(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+|^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function extractInsightItems(text) {
  const listItems = extractListItems(text);
  if (listItems.length > 0) return listItems;

  const headingItems = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(/^#{3,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
  if (headingItems.length > 0) return headingItems;

  const firstParagraph = String(text ?? "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .find(Boolean);
  return firstParagraph ? [firstParagraph] : [];
}

function hasQuestionCoverage(reportText) {
  return PMO_QUESTION_TEXT.every((question) => reportText.includes(question.slice(0, 3)));
}

function countSnippetEvidence(reportText) {
  const matches = reportText.match(/内容片段|Prompt:|Result:|Error:/g);
  return matches ? matches.length : 0;
}

function visibleCharCount(text) {
  return Array.from(String(text ?? "").replace(/\s+/g, "").trim()).length;
}

function hasSummaryEssentials(summaryText) {
  const hasProblem = /问题|摩擦|异常|风险|洞察/.test(summaryText);
  const hasImpact = /影响|后果|代价|损失|延误|返工|误判|噪音|盲区|阻塞/.test(summaryText);
  const hasHypothesis = /推测|可能|大概率|倾向|判断|置信度/.test(summaryText);
  const hasDoc = /文档/.test(summaryText);
  return visibleCharCount(summaryText) <= 200 && hasProblem && hasImpact && hasHypothesis && hasDoc;
}

function evaluateImpactHypothesis(reportText, summaryText) {
  const insightSection = findSection(reportText, "本次新增认知");
  const combined = `${insightSection}\n${summaryText}`;
  const hasImpact = /影响|后果|代价|损失|延误|返工|误判|噪音|盲区|阻塞/.test(combined);
  const hasHypothesis = /推测|可能|大概率|倾向|我判断|判断|置信度/.test(combined);

  if (hasImpact && hasHypothesis) {
    return {
      passed: true,
      detail: "已包含影响推测与判断性质",
      feedback: null,
    };
  }

  const missing = [];
  if (!hasImpact) missing.push("实际影响");
  if (!hasHypothesis) missing.push("推测/置信度");
  return {
    passed: false,
    detail: `缺少：${missing.join("、")}`,
    feedback: "主洞察必须写“我推测的实际影响是什么”，并标明这是推测/判断，最好给出置信度，方便用户校正。",
  };
}

function evaluateThinkingQuestion(reportText, summaryText) {
  const section = findSection(reportText, "本次思考题") || findSection(reportText, "今日思考题");
  if (!section) {
    return {
      passed: false,
      detail: "缺少“本次思考题”章节",
      feedback: "报告缺少“本次思考题”章节。每天必须自己提出一个组织/系统层面的思考题，并给出回答解答。",
    };
  }

  const hasQuestion = /问题|题目|思考题|？|\?/.test(section);
  const checksAllLogs = /所有沟通记录|全量|全部记录|baseline/i.test(section);
  const hasAnswer = /回答|解答|结论/.test(section);
  const hasEvidence = /内容片段|Prompt[:：]|Result[:：]|Error[:：]|comm_[a-z0-9]+/i.test(section);

  if (hasQuestion && checksAllLogs && hasAnswer && hasEvidence) {
    return {
      passed: true,
      detail: "已包含题目、全量检查、内容证据和回答",
      feedback: null,
    };
  }

  const missing = [];
  if (!hasQuestion) missing.push("题目");
  if (!checksAllLogs) missing.push("全量检查范围");
  if (!hasAnswer) missing.push("回答解答");
  if (!hasEvidence) missing.push("内容片段证据");

  return {
    passed: false,
    detail: `思考题缺少：${missing.join("、")}`,
    feedback: "“本次思考题”还不达标：要自己出题，明确这是基于所有沟通记录/全量背景的检查，并给出带内容片段证据的回答解答。",
  };
}

export function reviewDraftArtifacts({
  reportText,
  summaryText,
  previousSummaryText = "",
  ensureFollowup = true,
}) {
  const feedback = [];
  const gates = [];

  const questionCoverage = hasQuestionCoverage(reportText);
  gates.push({
    label: "七题完整性",
    passed: questionCoverage,
    detail: questionCoverage ? "Q1-Q7 齐全" : "缺少 PMO 必答题",
  });
  if (!questionCoverage) {
    feedback.push("7 个 PMO 必答题没有全部回答完整，必须按 Q1-Q7 逐题补齐。");
  }

  const snippetCount = countSnippetEvidence(reportText);
  const snippetCoverage = snippetCount >= 6;
  gates.push({
    label: "内容片段证据",
    passed: snippetCoverage,
    detail: `命中 ${snippetCount} 处内容片段关键词`,
  });
  if (!snippetCoverage) {
    feedback.push("内容片段证据太少，重点判断必须回到 prompt / resultPreview / errorMessage，至少补足多处代表性片段。");
  }

  const insightSection = findSection(reportText, "本次新增认知");
  const insightItems = extractInsightItems(insightSection);
  const hasInsightCount = insightItems.length >= 1;
  const hasFactualChain = /事实链|谁.*产出|谁.*分发|实际机制|发生了什么|链路|发起|处理|Prompt[:：]|Result[:：]|comm_[a-z0-9]+/i.test(
    insightSection,
  );
  const hasDeviation = /偏差|偏离|实际.*理想|不是.*而是|与上次.*差异|相较上次|架构债|冲突|不应|不能|不再/.test(
    insightSection,
  );
  const hasFix = /修正|改进|门禁|机制|SOP|闭环|下一步|建议|应|必须/.test(insightSection);
  const hasNovelInsights = hasInsightCount && hasFactualChain && hasDeviation && hasFix;
  gates.push({
    label: "新增认知",
    passed: hasNovelInsights,
    detail: hasNovelInsights
      ? "已形成 1 个包含事实链、偏差和修正动作的主洞察"
      : "主洞察缺少事实链、偏差或修正动作",
  });
  if (!hasNovelInsights) {
    feedback.push("“本次新增认知”不需要凑多条，但必须形成 1 个高质量主洞察：写清事实链、实际机制偏差、系统修正动作，并说明与上次相比的新认识。");
  }

  const impactHypothesis = evaluateImpactHypothesis(reportText, summaryText);
  gates.push({
    label: "影响推测",
    passed: impactHypothesis.passed,
    detail: impactHypothesis.detail,
  });
  if (!impactHypothesis.passed && impactHypothesis.feedback) {
    feedback.push(impactHypothesis.feedback);
  }

  const thinkingQuestion = evaluateThinkingQuestion(reportText, summaryText);
  gates.push({
    label: "思考题",
    passed: thinkingQuestion.passed,
    detail: thinkingQuestion.detail,
  });
  if (!thinkingQuestion.passed && thinkingQuestion.feedback) {
    feedback.push(thinkingQuestion.feedback);
  }

  const diffPattern = /与上(?:一)?次相比|和上(?:一)?次相比|相较上(?:一)?次|上(?:一)?次报告|上次摘要/;
  const diffMentioned = diffPattern.test(reportText) || diffPattern.test(summaryText);
  gates.push({
    label: "与上次差异",
    passed: diffMentioned,
    detail: diffMentioned ? "已明确写出与上次相比" : "未明确写出与上次相比",
  });
  if (!diffMentioned && previousSummaryText) {
    feedback.push("没有明确写出与上次相比哪里不同，请把本次新增认知和上次摘要做对照。");
  }

  const summaryEssentials = hasSummaryEssentials(summaryText);
  gates.push({
    label: "摘要完整度",
    passed: summaryEssentials,
    detail: summaryEssentials ? "摘要满足 200 字内且包含问题、影响推测、置信度、文档说明" : "摘要过长或缺少问题 / 影响推测 / 置信度 / 文档说明",
  });
  if (!summaryEssentials) {
    feedback.push("摘要必须控制在 200 字以内，并写清问题、影响推测、置信度和已附文档。");
  }

  const normalizedPrevious = normalizeText(previousSummaryText);
  const repeatedInsight = insightItems.some((item) => normalizedPrevious && normalizedPrevious.includes(normalizeText(item)));
  gates.push({
    label: "避免重复",
    passed: !repeatedInsight,
    detail: repeatedInsight ? "检测到新增认知与上次摘要高度重复" : "未检测到明显重复",
  });
  if (repeatedInsight) {
    feedback.push("本次新增认知和上次摘要重复度过高，请换一个新的观察角度并明确差异。");
  }

  if (ensureFollowup && feedback.length === 0) {
    feedback.push("整体结构已经达标，但请再收紧摘要第一句，先直接点明最突出的系统性摩擦，再落到新增认知。");
  }

  return { feedback, gates, insightItems, snippetCount };
}
