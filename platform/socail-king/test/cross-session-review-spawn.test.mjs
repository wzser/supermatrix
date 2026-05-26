import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionResultUrl,
  spawnAndCollectResult,
  waitForSessionResult,
} from "../src/cross-session-review-spawn.mjs";

test("buildSessionResultUrl derives the result endpoint from the spawn endpoint", () => {
  assert.equal(
    buildSessionResultUrl("http://127.0.0.1:3501/api/spawn", "sess_child_123"),
    "http://127.0.0.1:3501/api/sessions/sess_child_123/result",
  );
});

test("spawnAndCollectResult recovers the child session after spawn fetch fails and polls until completion", async () => {
  const fetchCalls = [];
  let resultPolls = 0;

  const result = await spawnAndCollectResult({
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
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

test("waitForSessionResult retries a transient result fetch failure", async () => {
  let fetchCalls = 0;

  const result = await waitForSessionResult({
    spawnUrl: "http://127.0.0.1:3501/api/spawn",
    childSessionId: "sess_child_123",
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
