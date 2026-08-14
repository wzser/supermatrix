const TIMEZONE = "Asia/Shanghai";

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const filenameFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const CATEGORY_RULES = [
  { label: "质量验证", automatable: true, pattern: /验证|verify|验收|测试|test|qa|回归/i },
  { label: "问题诊断", automatable: false, pattern: /调研|排查|诊断|分析|review|审查|调查|问题|故障|异常|issue/i },
  { label: "流程同步", automatable: true, pattern: /同步|sync|sop|文档|知识库|wiki|模板|原则|规范|bitable/i },
  { label: "跟进提醒", automatable: true, pattern: /提醒|通知|跟进|催|remind|notify/i },
  { label: "调度编排", automatable: true, pattern: /scheduler|cron|定时|schedule|任务/i },
  { label: "任务执行", automatable: false, pattern: /实现|implement|执行|创建|build|run|修复|编写/i },
  { label: "方案对齐", automatable: false, pattern: /方案|设计|评估|确认|建议|迁移|架构/i },
];

const CONTENT_THEME_RULES = [
  {
    key: "verification_trust_gap",
    title: "反复验证与可信度补洞",
    pattern: /验证|verify|核实|检查|smoke|probe|确认|命中|生效|是否都|测试|test|protocol|协议/i,
    interpretation: "沟通内容反复在确认“到底有没有生效”，说明系统可观测性和自证能力还不够，团队需要靠人工二次核实来建立信任。",
  },
  {
    key: "timeout_and_closure",
    title: "超时与闭环风险",
    pattern: /timeout|超时|pending|卡住|挂起|stuck|闭环|等待/i,
    interpretation: "沟通内容直接围绕超时、pending 和未闭环，这不是单点执行慢的问题，而是闭环机制和超时治理还不够硬。",
  },
  {
    key: "migration_and_consistency",
    title: "迁移与一致性校准",
    pattern: /migration|迁移|hook|plugin|skill|backend|symlink|settings\.json|一致性|template|模板/i,
    interpretation: "大量沟通花在迁移后校准和一致性确认上，说明系统改造完成后，还缺自动校验与一次性验收机制。",
  },
  {
    key: "sync_and_data_alignment",
    title: "同步与数据对齐",
    pattern: /同步|sync|bitable|wiki|table|session table|配置/i,
    interpretation: "沟通内容在反复同步和对齐配置，说明仍有不少信息要靠人工搬运，而不是结构化同步。",
  },
  {
    key: "execution_handoff",
    title: "任务交接与执行拆分",
    pattern: /实现|implement|执行|run|创建|build|task|step by step|任务描述/i,
    interpretation: "沟通内容已经深入到任务拆分和执行细节，说明跨 session 交接不只是在传信息，而是在代替正式工作流做任务编排。",
  },
];

const PMO_QUESTION_TEXT = [
  "Q1. 当前最突出的系统性摩擦点集中在哪些业务环节？",
  "Q2. 这些摩擦更像“人”的问题还是“系统”的问题？",
  "Q3. KPI（关键绩效指标）互斥或权责灰区出现在哪里？",
  "Q4. 哪些沟通是可以被 SOP（标准作业程序）或自动化替代的重复劳动？",
  "Q5. 谁是当前最像“基准制定者”的 session（会话）？",
  "Q6. 短期要建立怎样的 PDCA（计划-执行-检查-处理）止血闭环？",
  "Q7. 长期来看，系统建设应该往哪里重构？",
];

export function buildEventTimeMs(record) {
  return record.finishedAt ?? record.createdAt;
}

export function formatTimestamp(ms) {
  if (!Number.isFinite(ms)) return "N/A";
  return dateTimeFormatter.format(ms).replace(/\//g, "-");
}

export function formatFilenameTimestamp(ms) {
  return filenameFormatter.format(ms).replace(/[-: ]/g, "");
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "N/A";
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function normalizeText(value, maxLength = 200) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(空)";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function advanceCursor(records, fallback = null) {
  let cursor = fallback ? { ...fallback } : null;

  for (const record of records) {
    const next = {
      eventTimeMs: buildEventTimeMs(record),
      id: record.id,
    };

    if (!cursor) {
      cursor = next;
      continue;
    }

    if (next.eventTimeMs > cursor.eventTimeMs) {
      cursor = next;
      continue;
    }

    if (next.eventTimeMs === cursor.eventTimeMs && next.id > cursor.id) {
      cursor = next;
    }
  }

  return cursor;
}

function sortCountEntries(entries) {
  return entries.sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

function formatPercent(numerator, denominator) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function categorizeRecord(record) {
  const haystack = `${record.prompt ?? ""} ${record.resultPreview ?? ""} ${record.errorMessage ?? ""}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) {
      return { label: rule.label, automatable: rule.automatable };
    }
  }
  return { label: "未分类协调", automatable: false };
}

export function summarizeRecords(records) {
  const statusCounts = {
    completed: 0,
    failed: 0,
    pending: 0,
  };
  const pairCounts = new Map();
  const outgoingCounts = new Map();
  const incomingCounts = new Map();
  const failures = [];
  const pending = [];
  const longestCompleted = [];

  let firstEventAt = null;
  let lastEventAt = null;

  for (const record of records) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;

    const eventTimeMs = buildEventTimeMs(record);
    firstEventAt = firstEventAt === null ? eventTimeMs : Math.min(firstEventAt, eventTimeMs);
    lastEventAt = lastEventAt === null ? eventTimeMs : Math.max(lastEventAt, eventTimeMs);

    const pairKey = `${record.fromSession} -> ${record.toSession}`;
    const pairEntry = pairCounts.get(pairKey) ?? {
      label: pairKey,
      fromSession: record.fromSession,
      toSession: record.toSession,
      count: 0,
    };
    pairEntry.count += 1;
    pairCounts.set(pairKey, pairEntry);

    const outgoingEntry = outgoingCounts.get(record.fromSession) ?? {
      label: record.fromSession,
      session: record.fromSession,
      count: 0,
    };
    outgoingEntry.count += 1;
    outgoingCounts.set(record.fromSession, outgoingEntry);

    const incomingEntry = incomingCounts.get(record.toSession) ?? {
      label: record.toSession,
      session: record.toSession,
      count: 0,
    };
    incomingEntry.count += 1;
    incomingCounts.set(record.toSession, incomingEntry);

    if (record.status === "failed") failures.push(record);
    if (record.status === "pending") pending.push(record);

    if (record.finishedAt !== null) {
      longestCompleted.push({
        id: record.id,
        fromSession: record.fromSession,
        toSession: record.toSession,
        status: record.status,
        durationMs: record.finishedAt - record.createdAt,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt,
      });
    }
  }

  longestCompleted.sort((left, right) => {
    if (right.durationMs !== left.durationMs) return right.durationMs - left.durationMs;
    return left.id.localeCompare(right.id, "en");
  });

  return {
    total: records.length,
    statusCounts,
    firstEventAt,
    lastEventAt,
    topPairs: sortCountEntries([...pairCounts.values()]).slice(0, 10),
    topOutgoing: sortCountEntries([...outgoingCounts.values()]).slice(0, 10),
    topIncoming: sortCountEntries([...incomingCounts.values()]).slice(0, 10),
    failures,
    pending,
    longestCompleted: longestCompleted.slice(0, 5),
  };
}

function buildCategoryStats(records) {
  const map = new Map();

  for (const record of records) {
    const category = categorizeRecord(record);
    const entry = map.get(category.label) ?? {
      label: category.label,
      automatable: category.automatable,
      count: 0,
      failedCount: 0,
      pendingCount: 0,
    };
    entry.count += 1;
    if (record.status === "failed") entry.failedCount += 1;
    if (record.status === "pending") entry.pendingCount += 1;
    map.set(category.label, entry);
  }

  return [...map.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return left.label.localeCompare(right.label, "zh-CN");
  });
}

function buildHotspots(records) {
  const map = new Map();

  for (const record of records) {
    const category = categorizeRecord(record);
    const key = `${record.fromSession}|${record.toSession}|${category.label}`;
    const entry = map.get(key) ?? {
      label: `${record.fromSession} -> ${record.toSession} / ${category.label}`,
      fromSession: record.fromSession,
      toSession: record.toSession,
      category: category.label,
      count: 0,
      failedCount: 0,
      pendingCount: 0,
      durations: [],
      sampleIds: [],
    };

    entry.count += 1;
    if (record.status === "failed") entry.failedCount += 1;
    if (record.status === "pending") entry.pendingCount += 1;
    if (record.finishedAt !== null) entry.durations.push(record.finishedAt - record.createdAt);
    if (entry.sampleIds.length < 3) entry.sampleIds.push(record.id);
    map.set(key, entry);
  }

  return [...map.values()]
    .map((entry) => {
      const avgDurationMs = average(entry.durations);
      const maxDurationMs = entry.durations.length ? Math.max(...entry.durations) : null;
      const score =
        entry.count * 4 +
        entry.failedCount * 5 +
        entry.pendingCount * 4 +
        (avgDurationMs !== null && avgDurationMs >= 10 * 60 * 1000 ? 2 : 0);
      return { ...entry, avgDurationMs, maxDurationMs, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label, "zh-CN");
    });
}

function buildContentSnippet(record) {
  const parts = [];

  if (record.prompt) parts.push(`Prompt: ${normalizeText(record.prompt, 120)}`);
  if (record.resultPreview) parts.push(`Result: ${normalizeText(record.resultPreview, 120)}`);
  if (record.errorMessage) parts.push(`Error: ${normalizeText(record.errorMessage, 120)}`);

  const snippet = parts.join(" | ");
  if (!snippet) return `${record.id}: (无内容片段)`;
  return `${record.id}: ${snippet}`;
}

export function deriveContentFindings(records, limit = 5) {
  const map = new Map();

  for (const record of records) {
    const haystack = `${record.prompt ?? ""} ${record.resultPreview ?? ""} ${record.errorMessage ?? ""}`;
    let matched = false;

    for (const rule of CONTENT_THEME_RULES) {
      if (!rule.pattern.test(haystack)) continue;
      matched = true;

      const entry = map.get(rule.key) ?? {
        key: rule.key,
        title: rule.title,
        interpretation: rule.interpretation,
        count: 0,
        failedCount: 0,
        pendingCount: 0,
        recordIds: [],
        snippets: [],
      };

      entry.count += 1;
      if (record.status === "failed") entry.failedCount += 1;
      if (record.status === "pending") entry.pendingCount += 1;
      if (entry.recordIds.length < 5) entry.recordIds.push(record.id);

      const snippet = buildContentSnippet(record);
      if (entry.snippets.length < 3 && !entry.snippets.includes(snippet)) {
        entry.snippets.push(snippet);
      }

      map.set(rule.key, entry);
    }

    if (!matched) {
      const fallbackKey = "uncategorized_content";
      const fallback = map.get(fallbackKey) ?? {
        key: fallbackKey,
        title: "未归类但值得读的沟通内容",
        interpretation: "有一部分沟通内容不落在固定主题上，仍然需要人工抽读，防止真正的新问题被统计分类吞掉。",
        count: 0,
        failedCount: 0,
        pendingCount: 0,
        recordIds: [],
        snippets: [],
      };

      fallback.count += 1;
      if (record.status === "failed") fallback.failedCount += 1;
      if (record.status === "pending") fallback.pendingCount += 1;
      if (fallback.recordIds.length < 5) fallback.recordIds.push(record.id);
      const snippet = buildContentSnippet(record);
      if (fallback.snippets.length < 3 && !fallback.snippets.includes(snippet)) {
        fallback.snippets.push(snippet);
      }
      map.set(fallbackKey, fallback);
    }
  }

  return [...map.values()]
    .map((entry) => {
      const baseScore = entry.count * 4 + entry.failedCount * 5 + entry.pendingCount * 4;
      const score = entry.key === "uncategorized_content" ? Math.max(baseScore - 20, 0) : baseScore;
      const summary = `${entry.title}：${entry.interpretation}`;
      return { ...entry, score, summary };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.count !== left.count) return right.count - left.count;
      return left.title.localeCompare(right.title, "zh-CN");
    })
    .slice(0, limit);
}

function pickPrimaryContentFinding(findings) {
  return findings.find((entry) => entry.key !== "uncategorized_content") ?? findings[0] ?? null;
}

function buildActorPerformance(records) {
  const map = new Map();

  for (const record of records) {
    const participants = [
      { session: record.fromSession, role: "initiator", counterparty: record.toSession },
      { session: record.toSession, role: "receiver", counterparty: record.fromSession },
    ];

    for (const participant of participants) {
      const entry = map.get(participant.session) ?? {
        session: participant.session,
        totalCount: 0,
        initiatedCount: 0,
        receivedCount: 0,
        completedCount: 0,
        failedCount: 0,
        pendingCount: 0,
        counterparties: new Set(),
        completedDurations: [],
      };

      entry.totalCount += 1;
      if (participant.role === "initiator") entry.initiatedCount += 1;
      if (participant.role === "receiver") entry.receivedCount += 1;
      if (record.status === "completed") entry.completedCount += 1;
      if (record.status === "failed") entry.failedCount += 1;
      if (record.status === "pending") entry.pendingCount += 1;
      entry.counterparties.add(participant.counterparty);

      if (record.finishedAt !== null) {
        entry.completedDurations.push(record.finishedAt - record.createdAt);
      }

      map.set(participant.session, entry);
    }
  }

  return [...map.values()]
    .map((entry) => {
      const uniqueCounterparties = entry.counterparties.size;
      const avgDurationMs = average(entry.completedDurations);
      const successRate = entry.totalCount === 0 ? 0 : entry.completedCount / entry.totalCount;
      const score =
        entry.completedCount * 3 +
        uniqueCounterparties * 4 +
        Math.round(successRate * 10) -
        entry.failedCount * 5 -
        entry.pendingCount * 4 -
        Math.round((avgDurationMs ?? 0) / 600000);

      return {
        session: entry.session,
        totalCount: entry.totalCount,
        initiatedCount: entry.initiatedCount,
        receivedCount: entry.receivedCount,
        completedCount: entry.completedCount,
        failedCount: entry.failedCount,
        pendingCount: entry.pendingCount,
        uniqueCounterparties,
        avgDurationMs,
        successRate,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.completedCount !== left.completedCount) return right.completedCount - left.completedCount;
      return left.session.localeCompare(right.session, "zh-CN");
    });
}

function takeLabels(entries, limit, formatter) {
  if (entries.length === 0) return "(无)";
  return entries.slice(0, limit).map(formatter).join("；");
}

function buildEvidenceLevel(score) {
  if (score >= 8) return "高";
  if (score >= 4) return "中";
  return "低";
}

export function derivePmoInsights(input) {
  const {
    records,
    summary,
    baselineRecords,
    baselineSummary,
    generatedAtMs = Date.now(),
  } = input;

  const windowCategoryStats = buildCategoryStats(records);
  const baselineCategoryStats = buildCategoryStats(baselineRecords);
  const windowHotspots = buildHotspots(records);
  const baselineHotspots = buildHotspots(baselineRecords);
  const windowContentFindings = deriveContentFindings(records);
  const baselineContentFindings = deriveContentFindings(baselineRecords);
  const actorPerformance = buildActorPerformance(baselineRecords);

  const primaryWindowHotspot = windowHotspots[0] ?? null;
  const primaryBaselineHotspot = baselineHotspots[0] ?? null;
  const primaryWindowContent = pickPrimaryContentFinding(windowContentFindings);
  const primaryBaselineContent = pickPrimaryContentFinding(baselineContentFindings);
  const topInitiator = baselineSummary.topOutgoing[0] ?? null;
  const topReceiver = baselineSummary.topIncoming[0] ?? null;
  const topInitiatorShare = topInitiator ? topInitiator.count / Math.max(baselineSummary.total, 1) : 0;
  const stalePending = baselineSummary.pending.filter((record) => generatedAtMs - record.createdAt >= 24 * 60 * 60 * 1000);
  const automatableCategories = baselineCategoryStats.filter((entry) => entry.automatable);
  const automatableCount = automatableCategories.reduce((sum, entry) => sum + entry.count, 0);
  const automatableRatio = baselineSummary.total === 0 ? 0 : automatableCount / baselineSummary.total;
  const benchmarkCandidates = actorPerformance.filter((entry) => entry.totalCount >= 2).slice(0, 3);
  const repeatedHotspots = baselineHotspots.filter((entry) => entry.count >= 2);

  const q1EvidenceLevel = buildEvidenceLevel(
    (primaryWindowHotspot?.score ?? 0) + (primaryBaselineHotspot?.count ?? 0)
  );
  const q1Answer = summary.total === 0
    ? `本次增量没有新增记录，因此没有新的摩擦结论；沿用全量背景看，当前最突出的摩擦点仍集中在 \`${primaryBaselineHotspot?.fromSession ?? "N/A"} -> ${primaryBaselineHotspot?.toSession ?? "N/A"}\` 的 \`${primaryBaselineHotspot?.category ?? "未分类协调"}\` 环节，而且内容上持续围绕“${primaryBaselineContent?.title ?? "未归类内容"}”打转。`
    : `本次增量里最需要盯住的摩擦点是 \`${primaryWindowHotspot?.fromSession ?? "N/A"} -> ${primaryWindowHotspot?.toSession ?? "N/A"}\` 的 \`${primaryWindowHotspot?.category ?? "未分类协调"}\` 环节；放回全量背景看，\`${primaryBaselineHotspot?.fromSession ?? "N/A"} -> ${primaryBaselineHotspot?.toSession ?? "N/A"}\` 仍是累计最重的高频摩擦带，而内容上反复出现的是“${primaryWindowContent?.title ?? primaryBaselineContent?.title ?? "未归类内容"}”。`;
  const q1Evidence = [
    `本次窗口业务环节分布：${takeLabels(windowCategoryStats, 3, (entry) => `\`${entry.label}\` ${entry.count} 次`)}`,
    `全量高频摩擦带：${takeLabels(baselineHotspots, 3, (entry) => `\`${entry.fromSession} -> ${entry.toSession}\` / ${entry.category}（${entry.count} 次）`)}`,
    primaryBaselineContent
      ? `内容主题：${primaryBaselineContent.summary} 代表片段：${primaryBaselineContent.snippets[0] ?? "(无)"}`
      : "当前没有足够内容样本做主题提炼。",
    primaryBaselineHotspot
      ? `全量第一摩擦带的失败 ${primaryBaselineHotspot.failedCount} 次，pending ${primaryBaselineHotspot.pendingCount} 次。`
      : "当前没有可识别的摩擦带样本。",
  ];

  let q2Answer = "当前证据不足，无法把问题直接归因到具体个人。";
  let q2EvidenceLevel = "低";
  if (repeatedHotspots.length > 0 || stalePending.length > 0 || automatableRatio >= 0.3 || topInitiatorShare >= 0.4) {
    q2Answer = `当前更像系统问题，不像单点人的问题。原因不是单纯“次数多”，而是内容上反复出现“${primaryBaselineContent?.title ?? "重复确认"}”这类模式，说明团队在靠人工补系统，而不是在处理一次性的个体失误。`;
    q2EvidenceLevel = "中";
  } else if (baselineSummary.statusCounts.failed > 0) {
    q2Answer = "当前更像混合问题：日志里已经出现失败或断点，但样本量还不足以把责任压到某一位具体执行者，更合理的判断是局部执行问题叠加流程设计不够稳。";
    q2EvidenceLevel = "低";
  }
  const q2Evidence = [
    `可自动化沟通占全量 ${formatPercent(automatableCount, baselineSummary.total)}。`,
    primaryBaselineContent
      ? `内容片段：${primaryBaselineContent.snippets[0] ?? "(无)"}`
      : "当前没有足够内容样本。",
    topInitiator
      ? `发起最集中的 session 是 \`${topInitiator.session}\`，占全量 ${formatPercent(topInitiator.count, baselineSummary.total)}。`
      : "当前没有明显的发起集中点。",
    stalePending.length > 0
      ? `存在 ${stalePending.length} 条超过 24 小时仍未闭环的 pending 记录。`
      : "当前没有超过 24 小时的 pending 记录。",
  ];

  const q3Answer = [
    baselineSummary.total === 0
      ? "当前没有足够样本判断 KPI（关键绩效指标）互斥。"
      : "当前没有直接证据证明 KPI 互斥，但权责灰区已经出现信号。",
    topInitiator
      ? `最明显的灰区是任务归口过度集中：\`${topInitiator.session}\` 单点发起 ${topInitiator.count} 次，说明不少跨 session 协作还依赖中心节点人工分发。`
      : "尚未看到明显的任务归口集中。",
    topReceiver
      ? `同时，\`${topReceiver.session}\` 接收量最高，意味着这个环节容易成为责任兜底点。`
      : "尚未看到明显的责任兜底点。",
    stalePending.length > 0
      ? `未闭环记录 ${stalePending.length} 条，反映 owner（责任人）与 SLA（时限）字段还不够明确。`
      : "暂时没有看到拖长到暴露 owner 缺失的样本。",
  ].join(" ");
  const q3Evidence = [
    `发起方排行：${takeLabels(baselineSummary.topOutgoing, 3, (entry) => `\`${entry.session}\` ${entry.count} 次`)}`,
    `接收方排行：${takeLabels(baselineSummary.topIncoming, 3, (entry) => `\`${entry.session}\` ${entry.count} 次`)}`,
    baselineSummary.pending.length > 0
      ? `当前 pending：${takeLabels(baselineSummary.pending, 3, (record) => `\`${record.id}\` / ${record.fromSession} -> ${record.toSession}`)}`
      : "当前没有 pending 样本。",
  ];

  const q4Answer = automatableCount === 0
    ? "当前没有足够样本证明重复劳动已经成规模。"
    : `最像重复劳动的是 ${takeLabels(automatableCategories, 3, (entry) => `\`${entry.label}\`（${entry.count} 次）`)}。这类沟通天然适合沉淀成 SOP（标准作业程序）或自动化 workflow（工作流），不应该继续靠人工逐条协调。`;
  const q4Evidence = [
    `可自动化类沟通总计 ${automatableCount} 次，占全量 ${formatPercent(automatableCount, baselineSummary.total)}。`,
    `其中本次窗口内：${takeLabels(windowCategoryStats.filter((entry) => entry.automatable), 3, (entry) => `\`${entry.label}\` ${entry.count} 次`)}`,
    takeLabels(
      baselineContentFindings.filter((entry) => ["verification_trust_gap", "sync_and_data_alignment", "migration_and_consistency"].includes(entry.key)),
      2,
      (entry) => `${entry.title} -> ${entry.snippets[0] ?? "(无片段)"}`
    ),
    "优先可替代对象：验证、同步、提醒、调度四类固定模式沟通。",
  ];

  const q5Answer = benchmarkCandidates.length === 0
    ? "当前样本太少，暂时不点名基准制定者。"
    : `当前最像“基准制定者”的候选 session（会话）是 ${takeLabels(benchmarkCandidates, 2, (entry) => `\`${entry.session}\``)}。它们的共同特征是跨对象协作面更广、闭环率更高、没有明显失败堆积，更适合被抽样成组织基准流程。`;
  const q5Evidence = benchmarkCandidates.length === 0
    ? ["当前没有达到最小样本阈值（至少 2 次互动）的候选。"] 
    : benchmarkCandidates.map((entry) => `${entry.session}: 总量 ${entry.totalCount}，完成率 ${formatPercent(entry.completedCount, entry.totalCount)}，协作对象 ${entry.uniqueCounterparties} 个，平均闭环 ${formatDuration(entry.avgDurationMs ?? 0)}。`);

  const primaryAutomationCategory = automatableCategories[0]?.label ?? "质量验证";
  const q6Answer = `短期的 PDCA（计划-执行-检查-处理）止血闭环应围绕 \`${primaryAutomationCategory}\` 和当前第一摩擦带来建：先指定唯一 owner 与 SLA，再把每天新增的失败/pending 做成固定复盘表，最后把复盘里重复出现的动作沉淀成可执行 SOP。`;
  const q6Evidence = [
    primaryBaselineHotspot
      ? `先盯 \`${primaryBaselineHotspot.fromSession} -> ${primaryBaselineHotspot.toSession}\` / ${primaryBaselineHotspot.category}。`
      : "当前没有明显第一摩擦带，先从失败与 pending 清单入手。",
    primaryBaselineContent
      ? `先把“${primaryBaselineContent.title}”这类内容做成固定检查单，避免重复问同一类问题。`
      : "当前没有足够内容样本沉淀检查单。",
    baselineSummary.statusCounts.pending > 0
      ? `当前还有 ${baselineSummary.statusCounts.pending} 条 pending，可直接作为 PDCA 第一批止血对象。`
      : "当前没有 pending，可直接从高频验证/同步任务入手。",
    "建议最小闭环：每日增量审阅 -> 指派 owner -> 次日检查是否闭环 -> 未闭环进入 SOP 或系统改造池。",
  ];

  const q7Answer = `长期来看，系统建设重点不该是“把报告写得更漂亮”，而是把跨 session 协作从消息转成结构化流转：给每条协作补齐业务环节、owner、SLA、结果标签，再把高频验证/同步/提醒动作迁到自动化管道。这样 PMO（项目管理办公室）才能从读日志，升级到看流程健康。`;
  const q7Evidence = [
    "当前日志字段只有 from/to/prompt/status/时间，足够做诊断，不足够做责任链治理。",
    `全量 top 环节：${takeLabels(baselineCategoryStats, 4, (entry) => `\`${entry.label}\` ${entry.count} 次`)}`,
    "一旦补齐 owner、业务阶段、SLA、复用模板 ID，后续就能判断 KPI 冲突、责任灰区和 SOP 命中率。",
  ];

  return {
    questions: [
      { question: PMO_QUESTION_TEXT[0], answer: q1Answer, evidenceLevel: q1EvidenceLevel, evidence: q1Evidence },
      { question: PMO_QUESTION_TEXT[1], answer: q2Answer, evidenceLevel: q2EvidenceLevel, evidence: q2Evidence },
      { question: PMO_QUESTION_TEXT[2], answer: q3Answer, evidenceLevel: "中", evidence: q3Evidence },
      { question: PMO_QUESTION_TEXT[3], answer: q4Answer, evidenceLevel: automatableCount > 0 ? "中" : "低", evidence: q4Evidence },
      { question: PMO_QUESTION_TEXT[4], answer: q5Answer, evidenceLevel: benchmarkCandidates.length > 0 ? "中" : "低", evidence: q5Evidence },
      { question: PMO_QUESTION_TEXT[5], answer: q6Answer, evidenceLevel: "中", evidence: q6Evidence },
      { question: PMO_QUESTION_TEXT[6], answer: q7Answer, evidenceLevel: "中", evidence: q7Evidence },
    ],
    windowCategoryStats,
    baselineCategoryStats,
    windowHotspots,
    baselineHotspots,
    windowContentFindings,
    baselineContentFindings,
    benchmarkCandidates,
  };
}

function buildCandidateInsights({ pmoInsights, summary, baselineSummary }) {
  const candidates = [];
  const primaryHotspot = pmoInsights.baselineHotspots[0] ?? null;
  const primaryContent = pickPrimaryContentFinding(pmoInsights.baselineContentFindings);
  const topInitiator = baselineSummary.topOutgoing[0] ?? null;
  const topReceiver = baselineSummary.topIncoming[0] ?? null;
  const topBenchmark = pmoInsights.benchmarkCandidates[0] ?? null;
  const longestCycle = baselineSummary.longestCompleted[0] ?? null;
  const automatableCount = pmoInsights.baselineCategoryStats
    .filter((entry) => entry.automatable)
    .reduce((sum, entry) => sum + entry.count, 0);
  const automatableRatio = baselineSummary.total === 0 ? 0 : automatableCount / baselineSummary.total;
  const stalePending = baselineSummary.pending.filter((record) => buildEventTimeMs(record) <= Date.now() - 24 * 60 * 60 * 1000);

  if (primaryHotspot) {
    candidates.push({
      key: "hotspot_primary",
      priority: 100,
      title: "系统性摩擦主战场",
      text: `高频摩擦仍然集中在 \`${primaryHotspot.fromSession} -> ${primaryHotspot.toSession}\` 的 \`${primaryHotspot.category}\` 环节，这条链路应被当成一号诊断入口。`,
    });
  }

  if (primaryContent) {
    candidates.push({
      key: `content_${primaryContent.key}`,
      priority: 99,
      title: `内容洞察：${primaryContent.title}`,
      text: `${primaryContent.interpretation} 代表片段：${primaryContent.snippets[0] ?? "(无片段)"}`,
    });
  }

  if (topInitiator) {
    candidates.push({
      key: "initiator_centralization",
      priority: 95,
      title: "单点归口压力",
      text: `\`${topInitiator.session}\` 发起了 ${topInitiator.count} 条跨 session 协作，占全量 ${formatPercent(topInitiator.count, baselineSummary.total)}，说明当前仍存在中心节点人工分发。`,
    });
  }

  if (topReceiver) {
    candidates.push({
      key: "receiver_bottleneck",
      priority: 90,
      title: "接收端瓶颈",
      text: `\`${topReceiver.session}\` 是当前最高频的接收方，共接收 ${topReceiver.count} 条记录，天然有成为责任兜底点和瓶颈点的风险。`,
    });
  }

  candidates.push({
    key: "automation_ratio",
    priority: 88,
    title: "重复劳动占比",
    text: `可自动化的验证/同步/提醒/调度类沟通占全量 ${formatPercent(automatableCount, baselineSummary.total)}，说明组织里还有大量人工补系统的重复劳动。`,
  });

  candidates.push({
    key: "pmo_system_judgment",
    priority: 84,
    title: "系统问题判断",
    text: pmoInsights.questions[1]?.answer ?? "当前证据不足，暂时无法判断是人还是系统的问题。",
  });

  if (stalePending.length > 0) {
    candidates.push({
      key: "stale_pending_gap",
      priority: 83,
      title: "未闭环责任缺口",
      text: `当前有 ${stalePending.length} 条超过 24 小时仍未闭环的 pending 记录，暴露出 owner（责任人）和 SLA（时限）字段还不够硬。`,
    });
  }

  if (topBenchmark) {
    candidates.push({
      key: "benchmark_candidate",
      priority: 80,
      title: "基准制定者候选",
      text: `\`${topBenchmark.session}\` 是当前最值得抽样的基准制定者候选：跨对象协作 ${topBenchmark.uniqueCounterparties} 个，完成率 ${formatPercent(topBenchmark.completedCount, topBenchmark.totalCount)}。`,
    });
  }

  if (longestCycle) {
    candidates.push({
      key: "longest_cycle",
      priority: 78,
      title: "最长闭环样本",
      text: `当前最长闭环出现在 \`${longestCycle.fromSession} -> ${longestCycle.toSession}\`，耗时 ${formatDuration(longestCycle.durationMs)}，适合反查哪一步在拖长响应。`,
    });
  }

  if (summary.total === 0) {
    candidates.push({
      key: "no_new_records",
      priority: 76,
      title: "零增量提醒",
      text: "本次增量为 0，说明今天没有新增跨 session 互动；这不是“没事发生”，而是提醒应该把注意力转到历史高频摩擦带和未闭环项目上。",
    });
  }

  candidates.push({
    key: "long_term_rebuild",
    priority: 74,
    title: "长期重构方向",
    text: pmoInsights.questions[6]?.answer ?? "长期方向仍应是把消息式协作升级为结构化流转。",
  });

  return candidates.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.key.localeCompare(right.key, "en");
  });
}

export function selectNovelInsights(input) {
  const {
    pmoInsights,
    summary,
    baselineSummary,
    previousInsightKeys = [],
    limit = 1,
  } = input;

  const candidates = buildCandidateInsights({ pmoInsights, summary, baselineSummary });
  const previousSet = new Set(previousInsightKeys);
  const selected = [];

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (!previousSet.has(candidate.key)) {
      selected.push(candidate);
    }
  }

  if (selected.length < limit) {
    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      if (!selected.some((item) => item.key === candidate.key)) {
        selected.push(candidate);
      }
    }
  }

  return selected;
}

export function buildSummaryMessage(input) {
  const {
    sessionName,
    reportWindowLabel,
    summary,
    baselineSummary,
    novelInsights,
    nextCursor,
  } = input;

  const lines = [
    `PMO 摘要 | ${sessionName}`,
    `窗口：${reportWindowLabel}`,
    `本次记录：${summary.total} | 全量背景：${baselineSummary.total}`,
    `本次状态：completed ${summary.statusCounts.completed} / failed ${summary.statusCounts.failed} / pending ${summary.statusCounts.pending}`,
    `最新游标：${nextCursor ? `${formatTimestamp(nextCursor.eventTimeMs)} / ${nextCursor.id}` : "(无记录)"}`,
    "",
    "本次新增认知：",
    ...novelInsights.map((insight, index) => `${index + 1}. ${insight.title}：${insight.text}`),
  ];

  return lines.join("\n");
}

function renderRankList(entries, valueLabel) {
  if (entries.length === 0) return "- (无)";
  return entries.map((entry, index) => `${index + 1}. \`${entry.label}\` - ${entry.count} ${valueLabel}`).join("\n");
}

function renderDetail(record) {
  const category = categorizeRecord(record);
  const lines = [
    `### ${record.id}`,
    `- 方向：\`${record.fromSession} -> ${record.toSession}\``,
    `- 业务环节：\`${category.label}\``,
    `- 状态：\`${record.status}\``,
    `- 创建时间：${formatTimestamp(record.createdAt)}`,
    `- 事件时间：${formatTimestamp(buildEventTimeMs(record))}`,
  ];

  if (record.finishedAt !== null) {
    lines.push(`- 完成时间：${formatTimestamp(record.finishedAt)}`);
    lines.push(`- 耗时：${formatDuration(record.finishedAt - record.createdAt)}`);
  }

  if (record.childSessionId) lines.push(`- child session：\`${record.childSessionId}\``);
  if (record.errorMessage) lines.push(`- 错误：${normalizeText(record.errorMessage, 300)}`);

  lines.push(`- Prompt 摘要：${normalizeText(record.prompt, 240)}`);

  if (record.resultPreview) {
    lines.push(`- 结果摘要：${normalizeText(record.resultPreview, 240)}`);
  }

  return lines.join("\n");
}

function renderQuestion(question) {
  return [
    `### ${question.question}`,
    "",
    `- 结论：${question.answer}`,
    `- 证据等级：${question.evidenceLevel}`,
    "- 证据：",
    ...question.evidence.map((entry) => `  - ${entry}`),
    "",
  ].join("\n");
}

function renderCategoryBreakdown(title, entries) {
  return [
    `### ${title}`,
    "",
    entries.length === 0
      ? "- (无)"
      : entries.map((entry, index) => `${index + 1}. \`${entry.label}\` - ${entry.count} 次（failed ${entry.failedCount} / pending ${entry.pendingCount}）`).join("\n"),
    "",
  ].join("\n");
}

function renderContentFinding(finding, index) {
  return [
    `### ${index + 1}. ${finding.title}`,
    "",
    `- 主题摘要：${finding.summary}`,
    `- 涉及记录：${finding.count} 条（failed ${finding.failedCount} / pending ${finding.pendingCount}）`,
    "- 代表性片段：",
    ...finding.snippets.map((snippet) => `  - ${snippet}`),
    "",
  ].join("\n");
}

export function renderMarkdownReport(input) {
  const {
    sessionName,
    mode,
    generatedAtMs,
    reportWindowLabel,
    records,
    baselineRecords,
    summary,
    baselineSummary,
    previousCursor,
    nextCursor,
    previousInsightKeys = [],
  } = input;

  const insights = input.pmoInsights ?? derivePmoInsights({
    records,
    summary,
    baselineRecords,
    baselineSummary,
    generatedAtMs,
  });
  const novelInsights = input.novelInsights ?? selectNovelInsights({
    pmoInsights: insights,
    summary,
    baselineSummary,
    previousInsightKeys,
  });

  const orderedDetails = [...records].sort((left, right) => {
    const rightEvent = buildEventTimeMs(right);
    const leftEvent = buildEventTimeMs(left);
    if (rightEvent !== leftEvent) return rightEvent - leftEvent;
    return right.id.localeCompare(left.id, "en");
  });

  const sections = [
    "# Session 通讯回顾报告",
    "",
    `- Session（会话）：\`${sessionName}\``,
    `- 生成时间：${formatTimestamp(generatedAtMs)}`,
    `- 模式：\`${mode}\``,
    `- 窗口：${reportWindowLabel}`,
    `- 上次游标：${
      previousCursor ? `${formatTimestamp(previousCursor.eventTimeMs)} / ${previousCursor.id}` : "(首次运行)"
    }`,
    `- 本次游标：${
      nextCursor ? `${formatTimestamp(nextCursor.eventTimeMs)} / ${nextCursor.id}` : "(无记录)"
    }`,
    "",
    "> 报告规则：从这版开始，每次运行都必须逐题回答 PMO（项目管理办公室）必答题；如果证据不足，也必须明确写出“证据不足”，不能跳题。",
    "",
    "## 总览",
    "",
    `- 本次窗口记录数：${summary.total}`,
    `- 全量背景记录数：${baselineSummary.total}`,
    `- 本次窗口 completed：${summary.statusCounts.completed} / failed：${summary.statusCounts.failed} / pending：${summary.statusCounts.pending}`,
    `- 全量背景 completed：${baselineSummary.statusCounts.completed} / failed：${baselineSummary.statusCounts.failed} / pending：${baselineSummary.statusCounts.pending}`,
    `- 本次窗口最早事件：${summary.firstEventAt !== null ? formatTimestamp(summary.firstEventAt) : "(无)"}`,
    `- 本次窗口最晚事件：${summary.lastEventAt !== null ? formatTimestamp(summary.lastEventAt) : "(无)"}`,
    "",
    "## PMO 必答题",
    "",
    ...insights.questions.map((question) => renderQuestion(question)),
    "## 本次新增认知",
    "",
    ...novelInsights.map((insight, index) => `${index + 1}. **${insight.title}**：${insight.text}`),
    "",
    "## 内容洞察",
    "",
    insights.baselineContentFindings.length === 0
      ? "- (当前没有足够内容样本)"
      : insights.baselineContentFindings.map((finding, index) => renderContentFinding(finding, index)).join("\n"),
    "",
    "## 数据支撑",
    "",
    renderCategoryBreakdown("本次窗口业务环节分布", insights.windowCategoryStats),
    renderCategoryBreakdown("全量背景业务环节分布", insights.baselineCategoryStats),
    "### 高频通讯对",
    "",
    renderRankList(baselineSummary.topPairs, "次"),
    "",
    "### 发起方排行",
    "",
    renderRankList(baselineSummary.topOutgoing, "次"),
    "",
    "### 接收方排行",
    "",
    renderRankList(baselineSummary.topIncoming, "次"),
    "",
    "### 最慢闭环",
    "",
    baselineSummary.longestCompleted.length === 0
      ? "- (无已完成记录)"
      : baselineSummary.longestCompleted
        .map(
          (record, index) =>
            `${index + 1}. \`${record.fromSession} -> ${record.toSession}\` - ${formatDuration(record.durationMs)}`
        )
        .join("\n"),
    "",
    "### 失败记录",
    "",
    baselineSummary.failures.length === 0
      ? "- (无)"
      : baselineSummary.failures.map((record) => `- \`${record.id}\` | \`${record.fromSession} -> ${record.toSession}\` | ${normalizeText(record.errorMessage, 160)}`).join("\n"),
    "",
    "### Pending 记录",
    "",
    baselineSummary.pending.length === 0
      ? "- (无)"
      : baselineSummary.pending.map((record) => `- \`${record.id}\` | \`${record.fromSession} -> ${record.toSession}\` | 创建于 ${formatTimestamp(record.createdAt)}`).join("\n"),
    "",
    "## 本次窗口记录明细",
    "",
    orderedDetails.length === 0 ? "- (本次窗口无新增记录)" : orderedDetails.map((record) => renderDetail(record)).join("\n\n"),
    "",
  ];

  return sections.join("\n");
}
