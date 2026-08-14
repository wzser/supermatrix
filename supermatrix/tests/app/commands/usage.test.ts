import { describe, expect, test } from "vitest";
import { createUsageHandler } from "../../../src/app/commands/usage.ts";
import { asLarkGroupId, asTimestamp } from "../../../src/domain/ids.ts";

function ctx() {
  return {
    msg: {
      groupId: asLarkGroupId("oc_root"),
      messageId: "m",
      userId: "u",
      text: "/usage",
      attachments: [],
      receivedAtMs: 0,
    },
    scope: "root" as const,
    args: {},
  };
}

function collection(refreshAllowed: boolean) {
  return {
    method: "kimi_oauth_usages",
    refreshPolicy: "active_only",
    startsLogin: false,
    authenticationEffect: "none",
    refreshSupported: true,
    refreshAllowed,
  };
}

// Mirrors the live sm-switch snapshot (5 accounts across 3 vendors) so the
// rendering test fails if the real contract's shape drifts.
function snapshot(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    contract: "sm-switch.quota-snapshot/v1",
    schemaVersion: 1,
    generatedAt: "2026-08-05T01:56:11.892Z",
    staleAfterSeconds: 900,
    vendors: [
      {
        id: "codex",
        label: "Codex",
        accounts: [
          {
            accountId: "codex:main",
            label: "Codex Main",
            active: true,
            status: "fresh",
            statusReason: null,
            stale: false,
            collection: collection(true),
            lastRefreshAttemptAt: "2026-08-05T01:56:06.830Z",
            lastSuccessfulRefreshAt: "2026-08-05T01:56:06.830Z",
            quota: {
              plan: "pro",
              observedAt: "2026-08-05T01:56:07.758Z",
              windows: [
                {
                  id: "weekly",
                  label: "weekly",
                  usedPercent: 46,
                  remainingPercent: 54,
                  resetAt: "2026-08-11T00:53:31.000Z",
                },
              ],
            },
          },
        ],
      },
      {
        id: "claude",
        label: "Claude",
        accounts: [
          {
            accountId: "claude:main",
            label: "Claude Main",
            active: false,
            status: "stale",
            statusReason: "inactive_account",
            stale: true,
            collection: collection(false),
            lastRefreshAttemptAt: "2026-08-04T12:07:18.409Z",
            lastSuccessfulRefreshAt: "2026-08-04T12:07:18.409Z",
            quota: {
              plan: null,
              observedAt: "2026-08-04T12:07:22.119Z",
              windows: [
                {
                  id: "five_hour",
                  label: "5h",
                  usedPercent: 100,
                  remainingPercent: 0,
                  resetAt: "2026-08-04T13:29:59.703Z",
                },
                {
                  id: "weekly",
                  label: "weekly",
                  usedPercent: 16,
                  remainingPercent: 84,
                  resetAt: "2026-08-11T07:59:59.703Z",
                },
              ],
            },
          },
          {
            accountId: "claude:c-xin",
            label: "Claude C-Xin",
            active: true,
            status: "fresh",
            statusReason: null,
            stale: false,
            collection: collection(true),
            lastRefreshAttemptAt: "2026-08-05T01:56:06.830Z",
            lastSuccessfulRefreshAt: "2026-08-05T01:56:06.830Z",
            quota: {
              plan: null,
              observedAt: "2026-08-05T01:56:11.611Z",
              windows: [
                {
                  id: "five_hour",
                  label: "5h",
                  usedPercent: 39,
                  remainingPercent: 61,
                  resetAt: "2026-08-05T04:49:59.095Z",
                },
                {
                  id: "weekly",
                  label: "weekly",
                  usedPercent: 10,
                  remainingPercent: 90,
                  resetAt: "2026-08-11T07:59:59.095Z",
                },
              ],
            },
          },
        ],
      },
      {
        id: "kimi",
        label: "Kimi",
        accounts: [
          {
            accountId: "kimi:zs",
            label: "Kimi ZS",
            active: true,
            status: "fresh",
            statusReason: null,
            stale: false,
            collection: collection(true),
            lastRefreshAttemptAt: "2026-08-05T01:56:06.830Z",
            lastSuccessfulRefreshAt: "2026-08-05T01:56:06.830Z",
            quota: {
              plan: null,
              observedAt: "2026-08-05T01:56:11.858Z",
              windows: [
                {
                  id: "five_hour",
                  label: "5h",
                  usedPercent: 4,
                  remainingPercent: 96,
                  resetAt: "2026-08-05T03:56:50.505Z",
                },
              ],
            },
          },
          {
            accountId: "kimi:zp",
            label: "Kimi ZP",
            active: false,
            status: "stale",
            statusReason: "inactive_account",
            stale: true,
            collection: collection(false),
            lastRefreshAttemptAt: "2026-08-04T01:28:07.744Z",
            lastSuccessfulRefreshAt: "2026-08-04T01:28:07.744Z",
            quota: {
              plan: null,
              observedAt: "2026-08-04T01:28:11.035Z",
              windows: [
                {
                  id: "weekly",
                  label: "weekly",
                  usedPercent: 100,
                  remainingPercent: 0,
                  resetAt: "2026-08-07T02:49:17.661Z",
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  });
}

function handlerFor(text: string | null, nowIso = "2026-08-05T02:00:00.000Z") {
  return createUsageHandler({
    loadSnapshotText: async () => text,
    clock: { now: () => asTimestamp(Date.parse(nowIso)) },
  });
}

async function bodyOf(text: string | null, nowIso?: string) {
  const result = await handlerFor(text, nowIso)(ctx());
  if (!("replyCard" in result)) throw new Error("expected replyCard");
  return result.replyCard.body;
}

describe("usage handler", () => {
  test("renders every vendor account with remaining percent and reset time", async () => {
    const result = await handlerFor(snapshot())(ctx());
    if (!("replyCard" in result)) throw new Error("expected replyCard");
    expect(result.replyCard.title).toBe("订阅额度");
    const body = result.replyCard.body;
    // Feishu renders plain text proportionally; the fence keeps columns aligned.
    expect(body.startsWith("```")).toBe(true);
    expect(body.endsWith("```")).toBe(true);

    for (const label of ["Codex", "Claude", "Kimi"]) {
      expect(body).toContain(label);
    }
    for (const account of ["Codex Main", "Claude Main", "Claude C-Xin", "Kimi ZS", "Kimi ZP"]) {
      expect(body).toContain(account);
    }
    // remaining % + reset time, rendered in Asia/Shanghai
    expect(body).toMatch(/Codex Main[\s\S]*?weekly\s+剩余 54%\s+重置 08-11 08:53/u);
    expect(body).toMatch(/Claude C-Xin[\s\S]*?5h\s+剩余 61%\s+重置 08-05 12:49/u);
    expect(body).toMatch(/Claude C-Xin[\s\S]*?weekly\s+剩余 90%\s+重置 08-11 15:59/u);
    expect(body).toMatch(/Kimi ZS[\s\S]*?5h\s+剩余 96%\s+重置 08-05 11:56/u);
    expect(body).toMatch(/Kimi ZP[\s\S]*?weekly\s+剩余 0%\s+重置 08-07 10:49/u);
    // snapshot age is stated so nobody reads an old file as live
    expect(body).toContain("快照生成于 2026-08-05 09:56 CST");
    expect(body).toContain("3 分钟前");
  });

  test("marks inactive accounts as old readings with the observation time", async () => {
    const body = await bodyOf(snapshot());
    expect(body).toMatch(
      /Claude Main\s+\[非当前账号 · 旧值（观测于 2026-08-04 20:07 CST） · 非活跃账号，不主动刷新\]/u,
    );
    expect(body).toMatch(/Kimi ZP\s+\[非当前账号 · 旧值（观测于 2026-08-04 09:28 CST）/u);
    // active accounts stay labelled as live
    expect(body).toMatch(/Codex Main\s+\[当前账号 · 实时 · plan pro\]/u);
    expect(body).toMatch(/Kimi ZS\s+\[当前账号 · 实时\]/u);
    // an inactive account must never be presented as a live reading
    expect(body).not.toMatch(/Claude Main\s+\[[^\]]*实时/u);
  });

  test("flags the whole snapshot as stale once it outlives staleAfterSeconds", async () => {
    const fresh = await bodyOf(snapshot(), "2026-08-05T02:00:00.000Z");
    expect(fresh).not.toContain("⚠️");

    const old = await bodyOf(snapshot(), "2026-08-05T03:00:00.000Z");
    expect(old).toContain("⚠️ 快照已超过 15 分钟未刷新，以下数值一律按旧值看待");
    // the per-account "实时" flag only described snapshot-write time
    expect(old).toContain("Codex Main");
  });

  test("renders unavailable accounts without inventing numbers", async () => {
    const text = JSON.stringify({
      contract: "sm-switch.quota-snapshot/v1",
      schemaVersion: 1,
      generatedAt: "2026-08-05T01:56:11.892Z",
      staleAfterSeconds: 900,
      vendors: [
        {
          id: "kimi",
          label: "Kimi",
          accounts: [
            {
              accountId: "kimi:zp",
              label: "Kimi ZP",
              active: false,
              status: "unavailable",
              statusReason: "collection_failed",
              stale: true,
              collection: collection(false),
              lastRefreshAttemptAt: "2026-08-05T01:56:06.830Z",
              lastSuccessfulRefreshAt: null,
              quota: null,
            },
          ],
        },
      ],
    });
    const body = await bodyOf(text);
    expect(body).toMatch(/Kimi ZP\s+\[非当前账号 · 不可用 · 采集失败\]/u);
    expect(body).toContain("（无额度数据）");
    expect(body).not.toContain("剩余");
  });

  test("projects only quota fields, never credentials or paths", async () => {
    // Defense in depth: the contract carries no secrets today, but the renderer
    // must not become the leak if sm-switch ever adds fields.
    const raw = JSON.parse(snapshot()) as Record<string, unknown>;
    const vendors = raw["vendors"] as Array<Record<string, unknown>>;
    const account = (vendors[0]["accounts"] as Array<Record<string, unknown>>)[0];
    account["accessToken"] = "sk-live-should-never-render";
    account["email"] = "someone@example.com";
    account["configPath"] = "/Users/LOCAL_USER/.codex/auth.json";
    const body = await bodyOf(JSON.stringify(raw));
    expect(body).not.toContain("sk-live-should-never-render");
    expect(body).not.toContain("someone@example.com");
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain(".codex");
  });

  test("missing snapshot returns a friendly message instead of an error", async () => {
    const result = await handlerFor(null)(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("还没有额度快照");
  });

  test("refuses to render an unknown contract version", async () => {
    const text = snapshot({ contract: "sm-switch.quota-snapshot/v2" });
    const result = await handlerFor(text)(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("契约不匹配");
    expect(result.replyText).toContain("sm-switch.quota-snapshot/v1");
  });

  test("malformed json degrades to a message, not a throw", async () => {
    const result = await handlerFor("{not json")(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("不是合法 JSON");
  });

  test("read failures are reported instead of crashing the command", async () => {
    const handler = createUsageHandler({
      loadSnapshotText: async () => {
        throw new Error("EACCES: permission denied");
      },
      clock: { now: () => asTimestamp(Date.parse("2026-08-05T02:00:00.000Z")) },
    });
    const result = await handler(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("读取额度快照失败");
    expect(result.replyText).toContain("EACCES");
  });
});
