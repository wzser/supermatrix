import { execFileSync } from "node:child_process";

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

export function buildSessionResultUrl(spawnUrl, childSessionId) {
  const url = new URL(spawnUrl);
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
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = Date.now,
  pollIntervalMs = 5_000,
  maxWaitMs = 14 * 60 * 1000,
}) {
  const resultUrl = buildSessionResultUrl(spawnUrl, childSessionId);
  const deadline = now() + maxWaitMs;

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
  backend,
  prompt,
  dbPath,
  verificationPredicate = null,
  requestTimeoutMs = 10_000,
  recoveryWaitMs = 15_000,
  pollIntervalMs = 5_000,
  maxWaitMs = 14 * 60 * 1000,
  fetchImpl = fetch,
  queryJson = defaultQueryJson,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const startedAtMs = now();

  try {
    const body = {
      target,
      backend,
      prompt,
    };
    if (verificationPredicate) {
      body.verification_predicate = verificationPredicate;
    }
    const response = await fetchImpl(spawnUrl, {
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
        spawnUrl,
        childSessionId: payload.childSessionId,
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
      spawnUrl,
      childSessionId,
      fetchImpl,
      sleep,
      now,
      pollIntervalMs,
      maxWaitMs,
    });
  }
}
