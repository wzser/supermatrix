import { describe, expect, test } from "vitest";
import { createTokensHandler } from "../../../src/app/commands/tokens.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { SessionId } from "../../../src/domain/ids.ts";
import type {
  BindingStore,
  TokenUsageSummary,
} from "../../../src/ports/BindingStore.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function ctx() {
  return {
    msg: {
      groupId: asLarkGroupId("oc_root"),
      messageId: "m",
      userId: "u",
      text: "/tokens",
      attachments: [],
      receivedAtMs: 0,
    },
    scope: "root" as const,
    args: {},
  };
}

function withUsage(
  base: ReturnType<typeof createFakeBindingStore>,
  usageBySession: Record<string, TokenUsageSummary>,
): BindingStore {
  return {
    ...base,
    async getTokenUsageSummary(sessionId: SessionId) {
      return (
        usageBySession[sessionId as string] ?? {
          today: empty(),
          last7Days: empty(),
          cumulative: empty(),
        }
      );
    },
  };
}

function empty() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    rowCount: 0,
  };
}

function seed(
  store: ReturnType<typeof createFakeBindingStore>,
  name: string,
  id: string,
  backend: "claude" | "codex" | "kimi" = "claude",
) {
  store.seedSession({
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend,
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/ws/${name}`),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: null,
    depth: 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(1_700_000_000_000),
    updatedAt: asTimestamp(1_700_000_000_000),
  });
}

describe("tokens handler", () => {
  test("empty store prints friendly message", async () => {
    const store = createFakeBindingStore();
    const handler = createTokensHandler({
      store,
      clock: { now: () => asTimestamp(1_700_000_000_000) },
    });
    const result = await handler(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("没有");
  });

  test("single session renders in/out/all rows with M/Yi units and totals", async () => {
    const fake = createFakeBindingStore();
    seed(fake, "watchdog", "s1");
    const store = withUsage(fake, {
      s1: {
        today: { ...empty(), inputTokens: 1_200_000, outputTokens: 500_000, rowCount: 3 },
        last7Days: {
          ...empty(),
          inputTokens: 830_000_000,
          outputTokens: 410_000_000,
          rowCount: 10,
        },
        cumulative: {
          ...empty(),
          inputTokens: 10_200_000_000,
          outputTokens: 4_500_000_000,
          rowCount: 40,
        },
      },
    });
    const handler = createTokensHandler({
      store,
      clock: { now: () => asTimestamp(1_700_000_000_000) },
    });
    const result = await handler(ctx());
    if (!("replyCard" in result)) throw new Error("expected replyCard");
    expect(result.replyCard.title).toBe("Token 使用");
    const body = result.replyCard.body;
    // body is wrapped in ``` so Feishu renders monospace
    expect(body.startsWith("```")).toBe(true);
    expect(body.endsWith("```")).toBe(true);
    expect(body).toContain("今日(百万)");
    expect(body).toContain("7日(亿)");
    expect(body).toContain("累计(亿)");
    expect(body).toContain("watchdog");
    // in row: today 1.20M, 7d 8.3000亿, cum 102.0000亿
    expect(body).toMatch(/in\s+1\.20\s+8\.3000\s+102\.0000/);
    // out row: today 0.50M, 7d 4.1000亿, cum 45.0000亿
    expect(body).toMatch(/out\s+0\.50\s+4\.1000\s+45\.0000/);
    // all row: today 1.70M (1.2+0.5), 7d 12.4000亿, cum 147.0000亿
    expect(body).toMatch(/all\s+1\.70\s+12\.4000\s+147\.0000/);
    expect(body).toContain("合计");
    expect(body).toContain("─");
  });

  test("multi-session totals sum per window", async () => {
    const fake = createFakeBindingStore();
    seed(fake, "watchdog", "s1");
    seed(fake, "scheduler", "s2");
    const store = withUsage(fake, {
      s1: {
        today: { ...empty(), inputTokens: 1_200_000, outputTokens: 500_000, rowCount: 3 },
        last7Days: {
          ...empty(),
          inputTokens: 830_000_000,
          outputTokens: 410_000_000,
          rowCount: 10,
        },
        cumulative: {
          ...empty(),
          inputTokens: 10_200_000_000,
          outputTokens: 4_500_000_000,
          rowCount: 40,
        },
      },
      s2: {
        today: { ...empty(), inputTokens: 3_500_000, outputTokens: 1_200_000, rowCount: 2 },
        last7Days: {
          ...empty(),
          inputTokens: 2_200_000_000,
          outputTokens: 910_000_000,
          rowCount: 8,
        },
        cumulative: {
          ...empty(),
          inputTokens: 34_000_000_000,
          outputTokens: 12_000_000_000,
          rowCount: 80,
        },
      },
    });
    const handler = createTokensHandler({
      store,
      clock: { now: () => asTimestamp(1_700_000_000_000) },
    });
    const result = await handler(ctx());
    if (!("replyCard" in result)) throw new Error("expected replyCard");
    const body = result.replyCard.body;
    expect(body).toContain("watchdog");
    expect(body).toContain("scheduler");
    // totals in:  today 4.70M (1.2+3.5), 7d 30.3000亿 (8.3+22), cum 442.0000亿 (102+340)
    expect(body).toMatch(/in\s+4\.70\s+30\.3000\s+442\.0000/);
    // totals out: today 1.70M (0.5+1.2), 7d 13.2000亿 (4.1+9.1), cum 165.0000亿 (45+120)
    expect(body).toMatch(/out\s+1\.70\s+13\.2000\s+165\.0000/);
    // totals all: today 6.40M, 7d 43.5000亿, cum 607.0000亿
    expect(body).toMatch(/all\s+6\.40\s+43\.5000\s+607\.0000/);
  });

  test("renders cache hit, cache read, and fresh-input miss rows", async () => {
    const fake = createFakeBindingStore();
    seed(fake, "codexroot", "s1", "codex");
    seed(fake, "watchdog", "s2", "claude");
    const store = withUsage(fake, {
      s1: {
        today: {
          ...empty(),
          inputTokens: 10_000_000,
          cacheReadTokens: 8_000_000,
          outputTokens: 1_000_000,
          rowCount: 1,
        },
        last7Days: {
          ...empty(),
          inputTokens: 100_000_000,
          cacheReadTokens: 75_000_000,
          outputTokens: 5_000_000,
          rowCount: 2,
        },
        cumulative: {
          ...empty(),
          inputTokens: 200_000_000,
          cacheReadTokens: 180_000_000,
          outputTokens: 8_000_000,
          rowCount: 3,
        },
      },
      s2: {
        today: {
          ...empty(),
          inputTokens: 1_000_000,
          cacheReadTokens: 8_000_000,
          cacheWriteTokens: 1_000_000,
          outputTokens: 500_000,
          rowCount: 1,
        },
        last7Days: {
          ...empty(),
          inputTokens: 10_000_000,
          cacheReadTokens: 70_000_000,
          cacheWriteTokens: 20_000_000,
          outputTokens: 5_000_000,
          rowCount: 2,
        },
        cumulative: {
          ...empty(),
          inputTokens: 20_000_000,
          cacheReadTokens: 160_000_000,
          cacheWriteTokens: 20_000_000,
          outputTokens: 10_000_000,
          rowCount: 3,
        },
      },
    });
    const handler = createTokensHandler({
      store,
      clock: { now: () => asTimestamp(1_700_000_000_000) },
    });
    const result = await handler(ctx());
    if (!("replyCard" in result)) throw new Error("expected replyCard");
    const body = result.replyCard.body;

    expect(body).toContain("cache=命中输入");
    expect(body).toContain("miss=未命中/新写输入");
    expect(body).toMatch(/codexroot[\s\S]*cache\s+8\.00\s+0\.7500\s+1\.8000/);
    expect(body).toMatch(/codexroot[\s\S]*miss\s+2\.00\s+0\.2500\s+0\.2000/);
    expect(body).toMatch(/codexroot[\s\S]*hit%\s+80\.0%\s+75\.0%\s+90\.0%/);
    expect(body).toMatch(/watchdog[\s\S]*cache\s+8\.00\s+0\.7000\s+1\.6000/);
    expect(body).toMatch(/watchdog[\s\S]*miss\s+2\.00\s+0\.3000\s+0\.4000/);
    expect(body).toMatch(/watchdog[\s\S]*hit%\s+80\.0%\s+70\.0%\s+80\.0%/);
    expect(body).toMatch(/合计[\s\S]*cache\s+16\.00\s+1\.4500\s+3\.4000/);
    expect(body).toMatch(/合计[\s\S]*miss\s+4\.00\s+0\.5500\s+0\.6000/);
    expect(body).toMatch(/合计[\s\S]*hit%\s+80\.0%\s+72\.5%\s+85\.0%/);
  });
});
