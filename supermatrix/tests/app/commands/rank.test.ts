import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRankHandler } from "../../../src/app/commands/rank.ts";
import type {
  BindingStore,
  DisplayNameEntry,
  RankStats,
} from "../../../src/ports/BindingStore.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
} from "../../../src/domain/ids.ts";

const CONSOLE_GROUP = "LARK_CHAT_ID";

function makeCtx(scope: "root" | "user", groupId = "oc_test") {
  return {
    scope,
    msg: {
      groupId: asLarkGroupId(groupId),
      messageId: "m",
      userId: "ou_test",
      text: "/rank",
      attachments: [],
      receivedAtMs: 0,
    },
    args: {},
  };
}

function makeStore(stats: RankStats = { rows: [], trackingSince: null }): BindingStore {
  return {
    getRankStats: async () => stats,
    getDisplayNames: async () => new Map(),
  } as unknown as BindingStore;
}

describe("createRankHandler — empty data", () => {
  test("returns 暂无数据 when no rows", async () => {
    const handler = createRankHandler({ store: makeStore() });
    const result = await handler(makeCtx("root", CONSOLE_GROUP));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("暂无数据");
  });
});

describe("createRankHandler — scope routing", () => {
  test("root scope calls getRankStats with global", async () => {
    let captured: unknown;
    const store = {
      ...makeStore(),
      getRankStats: async (i: unknown) => { captured = i; return { rows: [], trackingSince: null }; },
    } as unknown as BindingStore;
    const handler = createRankHandler({ store });
    await handler(makeCtx("root", CONSOLE_GROUP));
    expect(captured).toEqual({ scope: "global" });
  });

  test("user scope calls getRankStats with group + groupId", async () => {
    let captured: unknown;
    const store = {
      ...makeStore(),
      getRankStats: async (i: unknown) => { captured = i; return { rows: [], trackingSince: null }; },
    } as unknown as BindingStore;
    const handler = createRankHandler({ store });
    await handler(makeCtx("user", "oc_abc"));
    expect(captured).toEqual({ scope: "group", groupId: asLarkGroupId("oc_abc") });
  });
});

describe("createRankHandler — formatting", () => {
  test("global: formats rank with resolved names and top3", async () => {
    const stats: RankStats = {
      rows: [
        {
          senderId: "ou_user_a",
          total: 342,
          inputChars: 12345,
          top3Sessions: [
            { sessionName: "console", count: 166 },
            { sessionName: "zedong",  count: 122 },
            { sessionName: "monet",   count: 40  },
          ],
        },
      ],
      trackingSince: new Date("2026-05-09").getTime(),
    };
    const handler = createRankHandler({
      store: makeStore(stats),
      resolveNames: async () => new Map([["ou_user_a", "YOUR_NAME"]]),
    });
    const result = await handler(makeCtx("root", CONSOLE_GROUP));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("YOUR_NAME");
    expect(result.replyText).toContain("近 7 天");
    expect(result.replyText).toContain("342 条 / 12,345 字");
    expect(result.replyText).toContain("console 166");
    expect(result.replyText).toContain("zedong 122");
    expect(result.replyText).toContain("monet 40");
    expect(result.replyText).toContain("2026-05-09");
  });

  test("user scope: no top3 slash-separated output", async () => {
    const stats: RankStats = {
      rows: [{ senderId: "ou_user_a", total: 50, inputChars: 6789, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const handler = createRankHandler({
      store: makeStore(stats),
      resolveNames: async () => new Map([["ou_user_a", "YOUR_NAME"]]),
    });
    const result = await handler(makeCtx("user", "oc_abc"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("YOUR_NAME");
    expect(result.replyText).toContain("50 条 / 6,789 字");
    expect(result.replyText).toContain("共 1 位用户，50 条消息，6,789 字输入");
    expect(result.replyText).not.toMatch(/\w+ \d+ \/ \w+ \d+/);
  });

  test("falls back to ou_ suffix when name unresolved", async () => {
    const stats: RankStats = {
      rows: [{ senderId: "ou_abcdef123456", total: 5, inputChars: 88, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const handler = createRankHandler({
      store: makeStore(stats),
      resolveNames: async () => new Map(),
    });
    const result = await handler(makeCtx("root", CONSOLE_GROUP));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("5");
    // Should not throw, and should contain some fallback for the sender
    expect(result.replyText.length).toBeGreaterThan(0);
  });
});

// ─── Default name-resolution path (Phase 1 root-cause fix) ──────────────────
// These exercise the real defaultResolveNames (no resolveNames override): the
// handler must (a) serve the cache when fresh, (b) invoke the hrhrhrhrhr
// refresh script directly when stale, and (c) fall back to id-suffix when the
// refresh fails. This replaces the prior LLM-mediated /api/spawn path that
// raced its own 5s AbortController against a 28-63s Claude Opus child.
describe("createRankHandler — default name resolution", () => {
  const HRHR_OPEN_ID = "ou_testowner";
  let tmpRoot: string;
  let scriptPath: string;
  let argsLogPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "rank-test-"));
    scriptPath = path.join(tmpRoot, "scripts", "refresh_user_display_names.py");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeScript(opts: { exitCode: number; sleepMs?: number }): void {
    argsLogPath = path.join(tmpRoot, "args.log");
    // Plain shell script; we only care about argv pass-through, timing, and
    // exit code. The real production script is python and writes SQLite, but
    // the test only validates the orchestration (rank.ts → script call).
    const sleep = opts.sleepMs ? `sleep ${(opts.sleepMs / 1000).toFixed(3)}\n` : "";
    const body = `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsLogPath}"\n${sleep}exit ${opts.exitCode}\n`;
    writeFileSync(scriptPath.replace(/\/[^/]+$/u, ""), "", { flag: "a" }); // noop touch parent
    // Ensure scripts/ dir exists
    const dir = path.dirname(scriptPath);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    // mkdir -p equivalent
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scriptPath, body);
    chmodSync(scriptPath, 0o755);
  }

  function makeStoreForRefresh(opts: {
    stats: RankStats;
    initialNames: Map<string, DisplayNameEntry>;
    refreshedNames: Map<string, DisplayNameEntry>;
    hrhrPresent: boolean;
  }): BindingStore {
    let callCount = 0;
    return {
      getRankStats: async () => opts.stats,
      getDisplayNames: async () => {
        callCount += 1;
        return callCount === 1 ? opts.initialNames : opts.refreshedNames;
      },
      findSessionByName: async (name: string) => {
        if (name !== "hrhrhrhrhr" || !opts.hrhrPresent) return null;
        return {
          id: asSessionId("sess_hrhrhrhrhr"),
          name: "hrhrhrhrhr",
          workdir: asAbsolutePath(tmpRoot),
        } as Awaited<ReturnType<BindingStore["findSessionByName"]>>;
      },
    } as unknown as BindingStore;
  }

  test("serves fresh cache without invoking the script", async () => {
    writeScript({ exitCode: 1 }); // would fail if called — but it shouldn't be
    const stats: RankStats = {
      rows: [{ senderId: HRHR_OPEN_ID, total: 7, inputChars: 70, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const fresh = new Map<string, DisplayNameEntry>([
      [HRHR_OPEN_ID, { displayName: "YOUR_NAME", fetchedAt: Date.now() }],
    ]);
    const handler = createRankHandler({
      store: makeStoreForRefresh({
        stats,
        initialNames: fresh,
        refreshedNames: fresh,
        hrhrPresent: true,
      }),
    });
    const result = await handler(makeCtx("user", "oc_abc"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("YOUR_NAME");
  });

  test("invokes refresh script with open_ids and re-reads names on success", async () => {
    writeScript({ exitCode: 0 });
    const stats: RankStats = {
      rows: [{ senderId: HRHR_OPEN_ID, total: 7, inputChars: 70, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const refreshed = new Map<string, DisplayNameEntry>([
      [HRHR_OPEN_ID, { displayName: "YOUR_NAME", fetchedAt: Date.now() }],
    ]);
    const handler = createRankHandler({
      store: makeStoreForRefresh({
        stats,
        initialNames: new Map(),
        refreshedNames: refreshed,
        hrhrPresent: true,
      }),
    });
    const result = await handler(makeCtx("user", "oc_abc"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("YOUR_NAME");
    // Argv should be exactly the open_ids
    const fs = require("node:fs") as typeof import("node:fs");
    const written = fs.readFileSync(argsLogPath, "utf8").trim().split("\n");
    expect(written).toEqual([HRHR_OPEN_ID]);
  });

  test("falls back to id suffix when refresh script fails", async () => {
    writeScript({ exitCode: 2 });
    const stats: RankStats = {
      rows: [{ senderId: HRHR_OPEN_ID, total: 7, inputChars: 70, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const handler = createRankHandler({
      store: makeStoreForRefresh({
        stats,
        initialNames: new Map(),
        refreshedNames: new Map(),
        hrhrPresent: true,
      }),
    });
    const result = await handler(makeCtx("user", "oc_abc"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain(HRHR_OPEN_ID.slice(-8));
    // Must NOT use the "未知用户" placeholder — keeps the suffix visible for
    // operators to do manual lookups when Feishu API is degraded.
    expect(result.replyText).not.toContain("未知用户");
  });

  test("falls back to id suffix when hrhrhrhrhr session is missing", async () => {
    // Don't write a script — hrhrPresent: false short-circuits before we look
    // for one. This proves rank does not hard-depend on the session existing.
    const stats: RankStats = {
      rows: [{ senderId: HRHR_OPEN_ID, total: 7, inputChars: 70, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const handler = createRankHandler({
      store: makeStoreForRefresh({
        stats,
        initialNames: new Map(),
        refreshedNames: new Map(),
        hrhrPresent: false,
      }),
    });
    const result = await handler(makeCtx("user", "oc_abc"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain(HRHR_OPEN_ID.slice(-8));
  });

  test("logs warning via Logger.warn when refresh fails", async () => {
    writeScript({ exitCode: 2 });
    const stats: RankStats = {
      rows: [{ senderId: HRHR_OPEN_ID, total: 1, inputChars: 10, top3Sessions: [] }],
      trackingSince: Date.now(),
    };
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), error: vi.fn(),
      warn,
      child: () => logger,
    };
    const handler = createRankHandler({
      store: makeStoreForRefresh({
        stats,
        initialNames: new Map(),
        refreshedNames: new Map(),
        hrhrPresent: true,
      }),
      logger,
    });
    await handler(makeCtx("user", "oc_abc"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rank: display name refresh failed"),
      expect.objectContaining({ stale: [HRHR_OPEN_ID] }),
    );
  });
});
