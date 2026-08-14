import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildAsyncChildCompletedCardJson,
  buildCardJson,
  createRealLarkClient,
  degradeMarkdownTables,
  eventMentionsBot,
  extractAttachments,
  extractForwardedTranscript,
  finalizeCardWithFallback,
  MAX_PROCESS_LOG_CHARS,
  PROCESS_LOG_AUTO_EXPAND_MAX_CHARS,
  MERGE_FORWARD_MAX_CHARS,
  MERGE_FORWARD_MAX_LINES,
  parseAsyncChildCompletedMessage,
  parseDriveCommentEvent,
  reconcileDriveCommentSubscription,
  renderForwardedTranscript,
  templateForRunStatus,
  truncateProcessLog,
} from "../../../src/adapters/lark-cli/realClient.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";
import type { LarkRawInbound, LarkRawMessage } from "../../../src/adapters/lark-cli/client.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function requireRawMessage(raw: LarkRawInbound): LarkRawMessage {
  if ("kind" in raw && raw.kind === "drive_comment") {
    throw new Error("expected LarkRawMessage, got Drive comment event");
  }
  return raw as LarkRawMessage;
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type TestWsEventHandler = (data: Record<string, unknown>) => unknown | Promise<unknown>;

type TestWsConnectionStatus = {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
};

function createWsHarness() {
  const handlers = new Map<string, TestWsEventHandler>();
  const close = vi.fn();
  const start = vi.fn(({ eventDispatcher }: { eventDispatcher: unknown }) => {
    void eventDispatcher;
  });
  let connectionStatus: TestWsConnectionStatus = {
    state: "connecting",
    reconnectAttempts: 0,
  };
  let lifecycle: {
    onError?: (err: Error) => void;
    onReady?: () => void;
    onReconnected?: () => void;
    onReconnecting?: () => void;
  } | undefined;
  return {
    handlers,
    wsClientFactory: vi.fn((params: typeof lifecycle) => {
      lifecycle = params;
      return {
        start,
        close,
        getConnectionStatus: () => connectionStatus,
      };
    }),
    eventDispatcherFactory: vi.fn(() => ({
      register(next: Record<string, TestWsEventHandler>) {
        for (const [key, handler] of Object.entries(next)) handlers.set(key, handler);
        return this;
      },
    })),
    start,
    close,
    setConnectionStatus(next: TestWsConnectionStatus) {
      connectionStatus = next;
    },
    fail(err: Error) {
      lifecycle?.onError?.(err);
    },
  };
}

type DriveSubscriptionIdentitySpec = {
  initial: boolean;
  verified: boolean;
};

type DriveSubscriptionSpec = {
  bot: DriveSubscriptionIdentitySpec;
  user: DriveSubscriptionIdentitySpec;
};

async function createDriveSubscriptionCli(spec: DriveSubscriptionSpec, statusError?: string) {
  const dir = await mkdtemp(join(tmpdir(), "supermatrix-drive-subscription-"));
  const callsPath = join(dir, "calls.jsonl");
  const fakeLarkCli = join(dir, "lark-cli");
  await writeFile(
    fakeLarkCli,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      `const statusError = ${JSON.stringify(statusError ?? "")};`,
      `const specs = ${JSON.stringify(spec)};`,
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
      "if (args[0] !== 'drive' || args[1] !== 'user') process.exit(12);",
      "const identity = args[args.indexOf('--as') + 1] ?? 'bot';",
      "const identitySpec = specs[identity] ?? { initial: false, verified: false };",
      `const statePath = path.join(${JSON.stringify(dir)}, 'created-' + identity);`,
      "if (args[2] === 'subscription_status' && statusError) {",
      `  process.stdout.write(JSON.stringify({ ok: false, identity, error: { type: 'feishu', message: statusError } }));`,
      "} else if (args[2] === 'subscription_status') {",
      "  const status = fs.existsSync(statePath) ? identitySpec.verified : identitySpec.initial;",
      "  process.stdout.write(JSON.stringify({ ok: true, identity, data: { is_subscribe: status } }));",
      "} else if (args[2] === 'subscription') {",
      "  fs.writeFileSync(statePath, 'created');",
      "  process.stdout.write(JSON.stringify({ ok: true, identity, data: {} }));",
      "} else {",
      "  process.exit(13);",
      "}",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(fakeLarkCli, 0o755);
  return { callsPath, dir, fakeLarkCli };
}

describe("Drive comment user subscription reconciliation", () => {
  test("keeps already-confirmed bot and user subscriptions without creating them", async () => {
    const fixture = await createDriveSubscriptionCli({
      bot: { initial: true, verified: true },
      user: { initial: true, verified: true },
    });
    try {
      await expect(reconcileDriveCommentSubscription({ larkCliPath: fixture.fakeLarkCli })).resolves.toEqual({
        eventType: "drive.notice.comment_add_v1",
        identities: [
          { identity: "bot", initialStatus: true, createAttempted: false, finalStatus: true },
          { identity: "user", initialStatus: true, createAttempted: false, finalStatus: true },
        ],
      });
      const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toEqual([
        [
          "drive", "user", "subscription_status",
          "--as", "bot",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
        [
          "drive", "user", "subscription_status",
          "--as", "user",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
      ]);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("creates missing bot and user subscriptions and confirms the final true status", async () => {
    const fixture = await createDriveSubscriptionCli({
      bot: { initial: false, verified: true },
      user: { initial: false, verified: true },
    });
    try {
      await expect(reconcileDriveCommentSubscription({ larkCliPath: fixture.fakeLarkCli })).resolves.toEqual({
        eventType: "drive.notice.comment_add_v1",
        identities: [
          { identity: "bot", initialStatus: false, createAttempted: true, finalStatus: true },
          { identity: "user", initialStatus: false, createAttempted: true, finalStatus: true },
        ],
      });
      const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toEqual([
        [
          "drive", "user", "subscription_status",
          "--as", "bot",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
        [
          "drive", "user", "subscription",
          "--as", "bot",
          "--data", JSON.stringify({ event_type: "drive.notice.comment_add_v1" }),
          "--format", "json",
        ],
        [
          "drive", "user", "subscription_status",
          "--as", "bot",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
        [
          "drive", "user", "subscription_status",
          "--as", "user",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
        [
          "drive", "user", "subscription",
          "--as", "user",
          "--data", JSON.stringify({ event_type: "drive.notice.comment_add_v1" }),
          "--format", "json",
        ],
        [
          "drive", "user", "subscription_status",
          "--as", "user",
          "--event-type", "drive.notice.comment_add_v1",
          "--format", "json",
        ],
      ]);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("reconciles bot and user independently when one identity stays false", async () => {
    const fixture = await createDriveSubscriptionCli({
      bot: { initial: true, verified: true },
      user: { initial: false, verified: false },
    });
    try {
      await expect(reconcileDriveCommentSubscription({ larkCliPath: fixture.fakeLarkCli })).resolves.toEqual({
        eventType: "drive.notice.comment_add_v1",
        identities: [
          { identity: "bot", initialStatus: true, createAttempted: false, finalStatus: true },
          {
            identity: "user",
            initialStatus: false,
            createAttempted: true,
            finalStatus: false,
            error: "Drive comment subscription (user) remained false after create",
          },
        ],
      });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("returns an unknown final status when the CLI status query fails", async () => {
    const fixture = await createDriveSubscriptionCli({
      bot: { initial: false, verified: true },
      user: { initial: false, verified: true },
    }, "permission denied");
    try {
      await expect(reconcileDriveCommentSubscription({ larkCliPath: fixture.fakeLarkCli })).resolves.toEqual({
        eventType: "drive.notice.comment_add_v1",
        identities: [
          {
            identity: "bot",
            initialStatus: null,
            createAttempted: false,
            finalStatus: null,
            error: "lark-cli drive user error [feishu]: permission denied",
          },
          {
            identity: "user",
            initialStatus: null,
            createAttempted: false,
            finalStatus: null,
            error: "lark-cli drive user error [feishu]: permission denied",
          },
        ],
      });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe("buildCardJson (schema 2.0)", () => {
  test("running card without processLog has a single markdown element", () => {
    const card = parse(buildCardJson("hello", "blue", "session · running"));
    expect(card.schema).toBe("2.0");
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe("blue");
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(1);
    expect(body.elements[0]).toEqual({ tag: "markdown", content: "hello" });
  });

  test("finalized card with a short processLog appends an auto-expanded panel", () => {
    const card = parse(
      buildCardJson("final answer", "green", "session · done", "💭 thinking\n🔧 tool\n✅ result"),
    );
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(2);
    expect(body.elements[0]).toEqual({ tag: "markdown", content: "final answer" });
    const panel = body.elements[1] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(true);
    const inner = panel.elements as Array<Record<string, unknown>>;
    expect(inner).toEqual([
      { tag: "markdown", content: "💭 thinking\n🔧 tool\n✅ result" },
    ]);
  });

  test("processLog at or above the auto-expand threshold stays collapsed", () => {
    // A long trace expanded by default would bury the answer and push the
    // panel below Feishu's own "展开更多" fold on tall cards.
    const long = "💭 ".concat("x".repeat(PROCESS_LOG_AUTO_EXPAND_MAX_CHARS));
    const card = parse(buildCardJson("body", "green", "t · done", long));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const panel = body.elements[1] as Record<string, unknown>;
    expect(panel.expanded).toBe(false);
  });

  test("auto-expand boundary is exclusive — exactly threshold chars stays collapsed", () => {
    const atLimit = "x".repeat(PROCESS_LOG_AUTO_EXPAND_MAX_CHARS);
    const justUnder = "x".repeat(PROCESS_LOG_AUTO_EXPAND_MAX_CHARS - 1);
    const at = parse(buildCardJson("b", "green", "t · done", atLimit));
    const under = parse(buildCardJson("b", "green", "t · done", justUnder));
    const panelAt = (at.body as { elements: Array<Record<string, unknown>> }).elements[1]!;
    const panelUnder = (under.body as { elements: Array<Record<string, unknown>> }).elements[1]!;
    expect(panelAt.expanded).toBe(false);
    expect(panelUnder.expanded).toBe(true);
  });

  test("process-log panel carries the turquoise header and an explicit icon", () => {
    const card = parse(buildCardJson("answer", "green", "t · done", "💭 x"));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const panel = body.elements[1] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    const header = panel.header as Record<string, unknown>;
    expect(header.background_color).toBe("turquoise-100");
    const icon = header.icon as Record<string, unknown>;
    expect(icon.tag).toBe("standard_icon");
    expect(icon.color).toBe("turquoise");
    expect(header.icon_expanded_angle).toBe(-180);
  });

  test("the hint rides inside the panel header and adapts to expanded state", () => {
    // Collapsed → tell the user they can click. Expanded → the content is
    // already visible, so "点击查看详情" would be wrong.
    const short = parse(buildCardJson("answer", "green", "t · done", "💭 x"));
    const longLog = "x".repeat(PROCESS_LOG_AUTO_EXPAND_MAX_CHARS + 10);
    const long = parse(buildCardJson("answer", "green", "t · done", longLog));

    const titleOf = (card: Record<string, unknown>) => {
      const els = (card.body as { elements: Array<Record<string, unknown>> }).elements;
      expect(els).toHaveLength(2);
      expect(els[0]!.tag).toBe("markdown");
      expect(els[1]!.tag).toBe("collapsible_panel");
      const header = els[1]!.header as Record<string, unknown>;
      return String((header.title as Record<string, unknown>).content);
    };

    const shortTitle = titleOf(short);
    const longTitle = titleOf(long);
    for (const t of [shortTitle, longTitle]) {
      expect(t).toContain("📋 查看流式过程");
      expect(t).toContain("<font color='grey'>");
      expect(t).toContain("以下为模型输出过程中的关键要点");
    }
    expect(shortTitle).not.toContain("点击查看详情");
    expect(longTitle).toContain("如果 final message 信息不够，可以点击查看详情");
  });

  test("empty/whitespace processLog is dropped — no panel and no hint", () => {
    const card = parse(buildCardJson("done", "green", "t · done", "   \n "));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(1);
  });

  test("error card keeps red template and still gets the panel", () => {
    const card = parse(
      buildCardJson("❌ boom", "red", "t · failed", "💭 step\n❌ boom"),
    );
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe("red");
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(2);
    expect((body.elements[1] as Record<string, unknown>).tag).toBe("collapsible_panel");
  });

  test("empty body falls back to placeholder", () => {
    const card = parse(buildCardJson("", "blue", "t · running"));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect((body.elements[0] as { content: string }).content).toContain("等待输出");
  });

  test("oversized processLog is truncated inside the collapsed panel", () => {
    const bigLog =
      "HEAD: session and initial narrative\n" +
      "x".repeat(MAX_PROCESS_LOG_CHARS * 3) +
      "\nTAIL: latest commentary, error, and hidden tool counts";
    const card = parse(buildCardJson("body", "green", "t · done", bigLog));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements[0]).toEqual({ tag: "markdown", content: "body" });
    const panel = body.elements[1] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    const inner = panel.elements as Array<Record<string, unknown>>;
    const logContent = (inner[0] as { content: string }).content;
    expect(logContent.length).toBeLessThanOrEqual(MAX_PROCESS_LOG_CHARS);
    expect(logContent).toContain("已截断 stream log");
    expect(logContent).toContain("DB message_runs");
    expect(logContent).toContain("HEAD: session and initial narrative");
    expect(logContent).toContain("TAIL: latest commentary, error, and hidden tool counts");
  });

  test("renders sm-child-completed as a grey collapsed async-return card", () => {
    const card = parse(buildCardJson([
      "comm_id: comm_delayed_123",
      '<sm-child-completed child_id="sess_child_abc" child_name="child_alpha" child_type="one_shot_delegation">',
      "<result>",
      "line 1",
      "line 2 full result",
      "</result>",
      "</sm-child-completed>",
    ].join("\n"), "green", "parent · done"));
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe("grey");
    const headerTitle = header.title as Record<string, unknown>;
    expect(headerTitle.content).toContain("异步回传");
    expect(headerTitle.content).toContain("child_alpha");
    expect(headerTitle.content).toContain("comm_delayed_123");
    expect(headerTitle.content).toContain("sess_child_abc");
    expect(headerTitle.content).toContain("one_shot_delegation");

    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(1);
    const panel = body.elements[0] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    const panelHeader = panel.header as Record<string, unknown>;
    expect(panelHeader.background_color).toBe("grey-100");
    const panelTitle = panelHeader.title as Record<string, unknown>;
    expect(panelTitle.content).toContain("异步回传");
    const inner = panel.elements as Array<Record<string, unknown>>;
    expect(inner).toEqual([
      {
        tag: "markdown",
        content: [
          "**异步回传 / 延迟投递**",
          "- 来源：child_alpha",
          "- comm ID：comm_delayed_123",
          "- child ID：sess_child_abc",
          "- 类型：one_shot_delegation",
          "",
          "line 1",
          "line 2 full result",
        ].join("\n"),
      },
    ]);
  });

  test("processLog shorter than cap is untouched", () => {
    const log = "normal short log";
    expect(truncateProcessLog(log)).toBe(log);
  });
});

describe("templateForRunStatus", () => {
  // Regression for the "green card with ❌ body" divergence (watchdog
  // issue eee04198): template must be chosen from the authoritative
  // RunStatus, not from prefix-sniffing the final body text.
  test("maps completed → green, timeout/failed → red, cancelled → grey, running → blue", () => {
    expect(templateForRunStatus("completed")).toBe("green");
    expect(templateForRunStatus("failed")).toBe("red");
    expect(templateForRunStatus("timeout")).toBe("red");
    expect(templateForRunStatus("cancelled")).toBe("grey");
    expect(templateForRunStatus("running")).toBe("blue");
  });
});

describe("async child completion cards", () => {
  test("parses child-completed envelope metadata and optional comm id", () => {
    const parsed = parseAsyncChildCompletedMessage([
      "这是你请求〔comm_cont_abc123〕的结果,框架兜底送回。",
      `<sm-child-completed child_id="sess_child_123" child_name="child_socail-king_foo&amp;bar" child_type="one_shot_delegation">`,
      "<result>",
      "line 1",
      "line 2",
      "</result>",
      "</sm-child-completed>",
    ].join("\n"));

    expect(parsed).toEqual({
      childId: "sess_child_123",
      childName: "child_socail-king_foo&bar",
      childType: "one_shot_delegation",
      commId: "comm_cont_abc123",
      result: "line 1\nline 2",
    });
  });

  test("renders child-completed envelope as a grey collapsed card", () => {
    const cardJson = buildAsyncChildCompletedCardJson([
      "这是你请求〔comm_cont_abc123〕的结果,框架兜底送回。",
      `<sm-child-completed child_id="sess_child_123" child_name="child_socail-king_demo" child_type="one_shot_delegation">`,
      "<result>",
      "complete result",
      "</result>",
      "</sm-child-completed>",
    ].join("\n"));
    expect(cardJson).toBeTypeOf("string");
    const card = parse(cardJson ?? "{}");

    const header = card.header as { template?: string; title?: { content?: string } };
    expect(header.template).toBe("grey");
    expect(header.title?.content).toBe(
      "[异步回传] child_socail-king_demo 的回复 (comm: comm_cont_abc123, id: sess_child_123, type: one_shot_delegation)",
    );

    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(1);
    const panel = body.elements[0] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    expect(JSON.stringify(panel)).toContain("延迟投递");
    expect(JSON.stringify(panel)).toContain("complete result");
    expect(JSON.stringify(panel)).not.toContain("sm-child-completed");
  });

  test("bot sendText posts child-completed envelope as an interactive card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-async-child-card-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: "oc_1", message_id: "om_card", create_time: "1" } }));
`,
        { mode: 0o755 },
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "ou_owner",
      });
      await client.sendText(asLarkGroupId("oc_1"), [
        `<sm-child-completed child_id="sess_child_123" child_name="child_socail-king_demo" child_type="one_shot_delegation">`,
        "<result>",
        "complete result",
        "</result>",
        "</sm-child-completed>",
      ].join("\n"));

      const calls = await readFile(callsPath, "utf8");
      const call = JSON.parse(calls.trim().split("\n")[0] ?? "[]") as string[];
      expect(call).toContain("--msg-type");
      expect(call).toContain("interactive");
      const content = call[call.indexOf("--content") + 1];
      const card = parse(content ?? "{}");
      expect((card.header as { template?: string }).template).toBe("grey");
      expect(JSON.stringify(card)).toContain("complete result");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("card action subscription", () => {
  test("reports the SDK WS lifecycle without treating idle Drive comments as a failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    try {
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: "/unused/lark-cli",
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      }) as ReturnType<typeof createRealLarkClient> & {
        getWsHealth(): {
          status: string;
          ingress: string;
          state: string;
          reconnectAttempts: number;
          lastError?: string;
        };
      };

      const unsubscribe = client.subscribeInbound(() => {});

      expect(client.getWsHealth()).toMatchObject({
        status: "grace",
        ingress: "node-sdk-ws",
        state: "connecting",
        reconnectAttempts: 0,
      });

      vi.advanceTimersByTime(90_001);
      expect(client.getWsHealth()).toMatchObject({ status: "degraded", state: "connecting" });

      ws.setConnectionStatus({
        state: "connected",
        lastConnectTime: Date.now(),
        reconnectAttempts: 0,
      });
      expect(client.getWsHealth()).toMatchObject({ status: "ok", state: "connected" });

      // No Drive comment arrives during this hour, but SDK connection state—not
      // event traffic—is the ingress liveness signal.
      vi.advanceTimersByTime(60 * 60 * 1_000);
      expect(client.getWsHealth()).toMatchObject({ status: "ok", state: "connected" });

      ws.setConnectionStatus({
        state: "reconnecting",
        lastConnectTime: Date.now(),
        nextConnectTime: Date.now() + 1_000,
        reconnectAttempts: 1,
      });
      expect(client.getWsHealth()).toMatchObject({
        status: "grace",
        state: "reconnecting",
        reconnectAttempts: 1,
      });

      vi.advanceTimersByTime(90_001);
      ws.setConnectionStatus({ state: "failed", reconnectAttempts: 2 });
      expect(client.getWsHealth()).toMatchObject({
        status: "degraded",
        state: "failed",
        reconnectAttempts: 2,
      });

      ws.fail(new Error("token=super-secret websocket failed"));
      expect(client.getWsHealth()).toMatchObject({
        status: "degraded",
        state: "failed",
        lastError: "token=[redacted] websocket failed",
      });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("starts a single node-sdk WSClient dispatcher for message events and card callbacks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-single-ingress-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
          "  process.exit(17);",
          "}",
          "process.stdout.write(JSON.stringify({ ok: true, data: {} }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        botOpenId: "ou_bot",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });

      const rawPromise = new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(ws.wsClientFactory).toHaveBeenCalledWith(expect.objectContaining({
        appId: "cli_REDACTEDAPPID",
        appSecret: "secret",
      }));
      expect(ws.start).toHaveBeenCalledTimes(1);
      expect([...ws.handlers.keys()].sort()).toEqual([
        "card.action.trigger",
        "drive.notice.comment_add_v1",
        "im.message.receive_v1",
      ]);

      await ws.handlers.get("im.message.receive_v1")?.({
        sender: {
          sender_id: { open_id: "ou_alice" },
          sender_type: "user",
        },
        message: {
          message_id: "om_sdk_msg",
          chat_id: "oc_sdk",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "SDK WS hello" }),
          create_time: "1700000000000",
        },
      });

      await expect(rawPromise).resolves.toEqual({
        messageId: "om_sdk_msg",
        groupId: "oc_sdk",
        userId: "ou_alice",
        text: "SDK WS hello",
        mentionedBot: false,
        attachments: [],
        timestampMs: 1_700_000_000_000,
        chatType: "group",
      });
      const calls = await readFile(callsPath, "utf8").catch(() => "");
      expect(calls).not.toContain('"+subscribe"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dedupes repeated SDK message events by message_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-message-dedupe-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({ ok: true, data: {} }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        botOpenId: "ou_bot",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const messages: LarkRawMessage[] = [];
      const unsubscribe = client.subscribeInbound((message) => {
        messages.push(requireRawMessage(message));
      });

      const event = {
        sender: {
          sender_id: { open_id: "ou_alice" },
          sender_type: "user",
        },
        message: {
          message_id: "om_sdk_duplicate",
          chat_id: "oc_sdk",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "same event" }),
          create_time: "1700000000000",
        },
      };
      await ws.handlers.get("im.message.receive_v1")?.(event);
      await ws.handlers.get("im.message.receive_v1")?.(event);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        messageId: "om_sdk_duplicate",
        groupId: "oc_sdk",
        text: "same event",
      });
      unsubscribe();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves SDK WS mention keys when bot info omits open_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-mention-detail-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          "if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
          "  process.stdout.write(JSON.stringify({ ok: true, identity: 'bot', data: {} }));",
          "  process.exit(0);",
          "}",
          "if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/im/v1/messages/om_sdk_mention') {",
          "  process.stdout.write(JSON.stringify({ ok: true, identity: 'bot', data: { items: [{ message_id: 'om_sdk_mention', body: { content: JSON.stringify({ text: '@_user_1 在吗' }) }, mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: 'SuperMatrix' }] }] } }));",
          "  process.exit(0);",
          "}",
          "if (process.argv[2] === 'im' && process.argv[3] === '+messages-mget') {",
          "  process.stdout.write(JSON.stringify({ ok: true, identity: 'bot', data: { messages: [{ message_id: 'om_sdk_mention', content: '@SuperMatrix 在吗', mentions: [{ key: '@_user_1', id: 'cli_REDACTEDAPPID', name: 'SuperMatrix' }] }], total: 1 } }));",
          "  process.exit(0);",
          "}",
          "process.stdout.write(JSON.stringify({ ok: true, data: {} }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });

      const rawPromise = new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      await ws.handlers.get("im.message.receive_v1")?.({
        sender: {
          sender_id: { open_id: "ou_alice" },
          sender_type: "user",
        },
        message: {
          message_id: "om_sdk_mention",
          chat_id: "oc_sdk",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 在吗" }),
          create_time: "1700000000000",
        },
      });

      await expect(rawPromise).resolves.toMatchObject({
        messageId: "om_sdk_mention",
        text: "@_user_1 在吗",
        mentionedBot: true,
      });
      const calls = await readFile(callsPath, "utf8");
      expect(calls).toContain("/open-apis/bot/v3/info");
      expect(calls).toContain("/open-apis/im/v1/messages/om_sdk_mention");
      expect(calls).toContain("+messages-mget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acks ask_user card callbacks and forwards the click to broker /click", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-ask-click-"));
    const previousBrokerPort = process.env["BROKER_PORT"];
    try {
      process.env["BROKER_PORT"] = "8789";
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, "#!/bin/sh\nexit 0\n");
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const emitted: LarkRawInbound[] = [];
      const unsubscribe = client.subscribeInbound((message) => {
        emitted.push(message);
      });

      const ack = await ws.handlers.get("card.action.trigger")?.({
        context: {
          open_message_id: "om_card_ask_user",
          open_chat_id: "oc_carddemo",
        },
        operator: {
          open_id: "ou_picker",
        },
        action: {
          tag: "button",
          value: { __ask_user: true, token: "abc123", value: "方案 A" },
        },
      });
      unsubscribe();

      expect(ack).toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
      expect(String(calls[0]?.[0])).toBe("http://127.0.0.1:8789/click");
      expect(calls[0]?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ token: "abc123", value: "方案 A" }),
      });
      expect(emitted).toEqual([]);
      expect(ws.close).toHaveBeenCalledWith({ force: true });
    } finally {
      if (previousBrokerPort === undefined) {
        delete process.env["BROKER_PORT"];
      } else {
        process.env["BROKER_PORT"] = previousBrokerPort;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acks notify-action card callbacks and forwards the frozen payload without CARD_ACTION fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-notify-action-"));
    const previousForwardUrl = process.env["NOTIFY_ACTION_FORWARD_URL"];
    try {
      process.env["NOTIFY_ACTION_FORWARD_URL"] = "http://127.0.0.1:3510/webhooks/notify-card";
      const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
      vi.stubGlobal("fetch", fetchMock);
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, "#!/bin/sh\nexit 0\n");
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const emitted: LarkRawInbound[] = [];
      const unsubscribe = client.subscribeInbound((message) => {
        emitted.push(message);
      });

      const ack = await ws.handlers.get("card.action.trigger")?.({
        header: { create_time: "1700000000000" },
        context: {
          open_message_id: "om_notify_action",
          open_chat_id: "oc_notify_action",
        },
        operator: {
          open_id: "ou_picker",
        },
        action: {
          tag: "button",
          value: {
            __notify_action: true,
            card_type: "gongying_replenish_confirm",
            value: "confirm",
            token: "na_9f2c1d8e",
            context: { batch_id: "B123" },
          },
        },
      });
      unsubscribe();

      expect(ack).toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
      expect(String(calls[0]?.[0])).toBe("http://127.0.0.1:3510/webhooks/notify-card");
      expect(calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          card_type: "gongying_replenish_confirm",
          value: "confirm",
          token: "na_9f2c1d8e",
          context: { batch_id: "B123" },
          operator_open_id: "ou_picker",
          chat_id: "oc_notify_action",
          open_message_id: "om_notify_action",
          event_time: "1700000000000",
        }),
      });
      expect(emitted).toEqual([]);
      expect(ws.close).toHaveBeenCalledWith({ force: true });
    } finally {
      if (previousForwardUrl === undefined) {
        delete process.env["NOTIFY_ACTION_FORWARD_URL"];
      } else {
        process.env["NOTIFY_ACTION_FORWARD_URL"] = previousForwardUrl;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acks non-ask card callbacks while preserving generic CARD_ACTION routing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-card-action-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, "#!/bin/sh\nexit 0\n");
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const rawPromise = new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });
      const actionPayload = {
        target_session: "table-session",
        card_action_id: "approve_row_1",
        action: "approve",
        record_id: "rec_1",
      };

      const ack = await ws.handlers.get("card.action.trigger")?.({
        context: {
          open_message_id: "om_card_generic",
          open_chat_id: "oc_table",
        },
        operator: {
          open_id: "ou_picker",
        },
        action: {
          tag: "button",
          value: actionPayload,
        },
        create_time: "1700000000000",
      });

      expect(ack).toEqual({});
      await expect(rawPromise).resolves.toEqual({
        messageId: "om_card_generic",
        groupId: "oc_table",
        userId: "ou_picker",
        text: "CARD_ACTION:" + JSON.stringify(actionPayload),
        attachments: [],
        timestampMs: 1_700_000_000_000,
        chatType: "card_action",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acks ordinary card collapsible panel callbacks without routing a CARD_ACTION", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-card-panel-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, "#!/bin/sh\nexit 0\n");
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const emitted: LarkRawInbound[] = [];
      const unsubscribe = client.subscribeInbound((message) => {
        emitted.push(message);
      });

      const ack = await ws.handlers.get("card.action.trigger")?.({
        context: {
          open_message_id: "om_completed_card",
          open_chat_id: "oc_table",
        },
        operator: {
          open_id: "ou_picker",
        },
        action: {
          tag: "collapsible_panel",
        },
      });
      unsubscribe();

      expect(ack).toEqual({});
      expect(emitted).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses generic card actions into CARD_ACTION user messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-generic-card-action-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const actionPayload = {
        target_session: "table-session",
        card_action_id: "approve_row_1",
        action: "approve",
        record_id: "rec_1",
      };
      const subscribePayload = JSON.stringify({
        header: {
          event_id: "evt_card_generic",
          event_type: "card.action.trigger",
          create_time: "1700000000000",
        },
        event: {
          context: {
            open_message_id: "om_card_generic",
            open_chat_id: "oc_table",
          },
          operator: {
            open_id: "ou_picker",
          },
          action: {
            tag: "button",
            value: actionPayload,
          },
        },
      });
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
          `  process.stdout.write(${JSON.stringify(subscribePayload)} + "\\n");`,
          "  setTimeout(() => process.exit(0), 1000);",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw).toEqual({
        messageId: "om_card_generic",
        groupId: "oc_table",
        userId: "ou_picker",
        text: "CARD_ACTION:" + JSON.stringify(actionPayload),
        attachments: [],
        timestampMs: 1_700_000_000_000,
        chatType: "card_action",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("forwards ask_user token clicks to broker /click without emitting CARD_ACTION", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-ask-user-click-"));
    const previousBrokerPort = process.env["BROKER_PORT"];
    try {
      process.env["BROKER_PORT"] = "8789";
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);

      const fakeLarkCli = join(dir, "lark-cli");
      const clickValue = { __ask_user: true, token: "abc123", value: "方案 A" };
      const forwardedPayload = { token: "abc123", value: "方案 A" };
      const subscribePayload = JSON.stringify({
        header: {
          event_id: "evt_card_ask_user",
          event_type: "card.action.trigger",
          create_time: "1700000000000",
        },
        event: {
          context: {
            open_message_id: "om_card_ask_user",
            open_chat_id: "oc_carddemo",
          },
          operator: {
            open_id: "ou_picker",
          },
          action: {
            tag: "button",
            value: clickValue,
          },
        },
      });
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
          `  process.stdout.write(${JSON.stringify(subscribePayload)} + "\\n");`,
          "  setTimeout(() => process.exit(0), 1000);",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const emitted: LarkRawInbound[] = [];
      const unsubscribe = client.subscribeInbound((message) => {
        emitted.push(message);
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      unsubscribe();

      const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>;
      expect(String(calls[0]?.[0])).toBe("http://127.0.0.1:8789/click");
      expect(calls[0]?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify(forwardedPayload),
      });
      expect(emitted).toEqual([]);
    } finally {
      if (previousBrokerPort === undefined) {
        delete process.env["BROKER_PORT"];
      } else {
        process.env["BROKER_PORT"] = previousBrokerPort;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores stale AskUserQuestion select form_value callbacks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-disabled-ask-user-card-action-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const selectedPayload = {
        action: "ask_user_answer",
        target_session: "amzdata",
        origin_run_id: "mr_6fef35af",
        question_id: "plan_choice",
        header: "选择方案",
        question: "这次 mr_6fef35af 要按哪个方案继续？",
        selected_label: "方案 B",
        selected_value: "方案 B",
      };
      const subscribePayload = JSON.stringify({
        header: {
          event_id: "evt_card_form_only",
          event_type: "card.action.trigger",
          create_time: "1700000000123",
        },
        event: {
          context: {
            open_message_id: "om_card_form_only",
            open_chat_id: "oc_ask_user",
          },
          operator: {
            open_id: "ou_picker",
          },
          action: {
            tag: "select_static",
            name: "ask_user_option",
            form_value: {
              ask_user_option: JSON.stringify(selectedPayload),
            },
          },
        },
      });
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
          `  process.stdout.write(${JSON.stringify(subscribePayload)} + "\\n");`,
          "  setTimeout(() => process.exit(0), 1000);",
          "}",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      let unsubscribe: (() => void | Promise<void>) | undefined;
      const raw = await new Promise<LarkRawMessage | "missing">((resolve) => {
        const timer = setTimeout(() => resolve("missing"), 300);
        unsubscribe = client.subscribeInbound((message) => {
          clearTimeout(timer);
          unsubscribe?.();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw).toBe("missing");
      await unsubscribe?.();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractAttachments", () => {
  test("extracts inline image placeholders from mixed text messages", () => {
    expect(extractAttachments("请看这张图[Image: img_v3_abc123]")).toEqual([
      { kind: "image", fileKey: "img_v3_abc123", name: "img_v3_abc123.png" },
    ]);
  });

  test("extracts multiple image placeholders in arrival order", () => {
    expect(extractAttachments("[Image: img_a] 对比 [Image: img_b]")).toEqual([
      { kind: "image", fileKey: "img_a", name: "img_a.png" },
      { kind: "image", fileKey: "img_b", name: "img_b.png" },
    ]);
  });

  test("extracts images from post (rich text) content JSON", () => {
    // Real shape of a Feishu post message mixing image + text, as delivered in
    // the compact inbound event `content` field.
    const post = JSON.stringify({
      title: "",
      content: [
        [{ tag: "img", image_key: "img_v3_post_a", width: 3552, height: 1328 }],
        [{ tag: "text", text: "好不到哪去，你看下图片", style: [] }],
      ],
      content_v2: [
        [{ tag: "img", image_key: "img_v3_post_a", width: 3552, height: 1328 }],
        [{ tag: "text", text: "好不到哪去，你看下图片", style: [] }],
      ],
    });
    expect(extractAttachments(post)).toEqual([
      { kind: "image", fileKey: "img_v3_post_a", name: "img_v3_post_a.png" },
    ]);
  });

  test("extracts multiple post images in document order across paragraphs", () => {
    const post = JSON.stringify({
      title: "",
      content: [
        [{ tag: "text", text: "对比这两张" }],
        [{ tag: "img", image_key: "img_v3_first" }],
        [
          { tag: "img", image_key: "img_v3_second" },
          { tag: "text", text: "哪个好" },
        ],
      ],
    });
    expect(extractAttachments(post)).toEqual([
      { kind: "image", fileKey: "img_v3_first", name: "img_v3_first.png" },
      { kind: "image", fileKey: "img_v3_second", name: "img_v3_second.png" },
    ]);
  });

  test("extracts images from elements-style post content (forwarded/cards)", () => {
    const post = JSON.stringify({
      title: "wendangwang@main | done",
      elements: [
        [{ tag: "img", image_key: "img_v3_elem_a" }],
      ],
    });
    expect(extractAttachments(post)).toEqual([
      { kind: "image", fileKey: "img_v3_elem_a", name: "img_v3_elem_a.png" },
    ]);
  });

  test("ignores post JSON without img tags", () => {
    const post = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "纯文字 post" }]],
    });
    expect(extractAttachments(post)).toEqual([]);
  });
});

describe("eventMentionsBot", () => {
  test("matches Feishu mention id.open_id against bot open_id", () => {
    expect(eventMentionsBot({
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot", union_id: "onion" },
          name: "SuperMatrix",
        },
      ],
    }, { botOpenId: "ou_bot", botAppId: "cli_app" })).toBe(true);
  });

  test("does not match mentions for other users", () => {
    expect(eventMentionsBot({
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_someone_else" },
          name: "Alice",
        },
      ],
    }, { botOpenId: "ou_bot", botAppId: "cli_app" })).toBe(false);
  });

  test("matches inline at tag ids from compact content", () => {
    expect(eventMentionsBot({
      content: '<at user_id="ou_bot">SuperMatrix</at> hello',
    }, { botOpenId: "ou_bot" })).toBe(true);
  });

  test("accepts explicit compact at-bot booleans", () => {
    expect(eventMentionsBot({ is_at_bot: true }, {})).toBe(true);
  });
});

describe("WS drive comment ingress", () => {
  test("logs drive.notice.comment_add_v1 receipt before parsing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-ws-drive-comment-log-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "process.stdout.write(JSON.stringify({ ok: true, data: {} }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const ws = createWsHarness();
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_REDACTEDAPPID",
        botAppSecret: "secret",
        botOpenId: "ou_bot",
        ownerUserId: "",
        wsClientFactory: ws.wsClientFactory,
        eventDispatcherFactory: ws.eventDispatcherFactory,
      });
      const callback = vi.fn();
      const unsubscribe = client.subscribeInbound(callback);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await ws.handlers.get("drive.notice.comment_add_v1")?.({
        header: {
          event_id: "evt_ws_log",
          event_type: "drive.notice.comment_add_v1",
        },
        event: {
          file_token: "doc_token",
          file_type: "docx",
          comment_id: "comment_ws",
          comment: { content: "普通评论" },
        },
      });

      const logCall = log.mock.calls.find((call) =>
        String(call[0]).includes("drive.notice.comment_add_v1 received"));
      expect(logCall).toBeDefined();
      expect(logCall?.[1]).toMatchObject({
        eventId: "evt_ws_log",
        fileToken: "doc_token",
        commentId: "comment_ws",
      });
      expect(callback).not.toHaveBeenCalled();
      log.mockRestore();
      unsubscribe();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseDriveCommentEvent", () => {
  test("extracts a mentioned Drive comment event into a raw drive comment", () => {
    const raw = parseDriveCommentEvent({
      header: {
        event_id: "evt_1",
        event_type: "drive.notice.comment_add_v1",
      },
      event: {
        file_token: "doc_token",
        file_type: "docx",
        comment_id: "comment_1",
        operator_id: { open_id: "ou_user" },
        comment: {
          content: '<at user_id="ou_bot">SuperMatrix</at> 帮我记一下',
        },
      },
    }, { botAppId: "cli_app", botOpenId: "ou_bot" });

    expect(raw).toEqual({
      kind: "drive_comment",
      source: {
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
      },
    });
  });

  test("extracts compact Drive comment notice metadata into a raw drive comment", () => {
    const raw = parseDriveCommentEvent({
      type: "drive.notice.comment_add_v1",
      event_id: "evt_notice_1",
      comment_id: "comment_notice_1",
      reply_id: "reply_notice_1",
      is_mentioned: true,
      notice_meta: {
        file_token: "base_token",
        file_type: "bitable",
        notice_type: "add_reply",
        from_user_id: { open_id: "ou_user" },
        to_user_id: { open_id: "ou_bot" },
      },
    }, { botAppId: "cli_app", botOpenId: "ou_bot" });

    expect(raw).toEqual({
      kind: "drive_comment",
      source: {
        kind: "drive_comment",
        eventId: "evt_notice_1",
        fileToken: "base_token",
        fileType: "bitable",
        commentId: "comment_notice_1",
        replyId: "reply_notice_1",
        fromUserId: "ou_user",
      },
    });
  });

  test("preserves the target record URL when Drive comment notices include one", () => {
    const raw = parseDriveCommentEvent({
      type: "drive.notice.comment_add_v1",
      event_id: "evt_record_url_1",
      comment_id: "comment_record_url_1",
      reply_id: "reply_record_url_1",
      record_url: "https://jxs9pwkdvwn.feishu.cn/record/SMh9rOMSuewguhcVbtrcSjFknlf",
      is_mentioned: true,
      notice_meta: {
        file_token: "base_token",
        file_type: "bitable",
        from_user_id: { open_id: "ou_user" },
        to_user_id: { open_id: "ou_bot" },
      },
    }, { botAppId: "cli_app", botOpenId: "ou_bot" });

    expect(raw).toEqual({
      kind: "drive_comment",
      source: {
        kind: "drive_comment",
        eventId: "evt_record_url_1",
        fileToken: "base_token",
        fileType: "bitable",
        recordId: "SMh9rOMSuewguhcVbtrcSjFknlf",
        commentId: "comment_record_url_1",
        replyId: "reply_record_url_1",
        fromUserId: "ou_user",
        url: "https://jxs9pwkdvwn.feishu.cn/record/SMh9rOMSuewguhcVbtrcSjFknlf",
      },
    });
  });

  test("preserves Bitable table and record identity from target/resource event shapes", () => {
    const raw = parseDriveCommentEvent({
      type: "drive.notice.comment_add_v1",
      event_id: "evt_bitable_identity_1",
      event: {
        file_token: "NFRabnLOJaldfVsWKbjcuR07nKe",
        file_type: "bitable",
        comment_id: "7673408506963233765",
        operator_id: { open_id: "ou_REDACTEDOPENID" },
        comment: { content: "<at user_id=\"ou_bot\">SuperMatrix</at> 经营表 fba可售 0可售asin" },
        target: {
          table_id: "tblREDACTEDTABLEID",
          record_id: "recvrSCvk4eUxc",
          url: "https://jxs9pwkdvwn.feishu.cn/record/recvrSCvk4eUxc",
        },
      },
    }, { botAppId: "cli_app", botOpenId: "ou_bot" });

    expect(raw).toMatchObject({
      source: {
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSCvk4eUxc",
        commentId: "7673408506963233765",
        fromUserId: "ou_REDACTEDOPENID",
        url: "https://jxs9pwkdvwn.feishu.cn/record/recvrSCvk4eUxc",
      },
    });
  });

  test("reads the current Bitable record through public lark-cli record-get", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-bitable-record-get-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { items: [{ comment_id: '7673408506963233765', content: { elements: [{ type: 'text_run', text_run: { text: '经营表 fba可售 0可售asin' } }] } }] } }));",
        "} else if (process.argv[2] === 'base' && process.argv[3] === '+record-get') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { records: [{ record_id: 'recvrSCvk4eUxc', fields: { '序号': 419, 'Todo owner alias': 'product-tracker', '内容': '父ASIN日表/汇总表', '交付/进展': '待处理' } }] } }));",
        "} else { process.exit(12); }",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const context = await client.getDriveCommentContext({
        kind: "drive_comment",
        eventId: "evt_bitable_identity_1",
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSCvk4eUxc",
        commentId: "7673408506963233765",
        replyId: "7673408506980043721",
      });

      expect(context).toMatchObject({
        text: "经营表 fba可售 0可售asin",
        bitableRecord: {
          recordId: "recvrSCvk4eUxc",
          fields: {
            "序号": 419,
            "Todo owner alias": "product-tracker",
            "内容": "父ASIN日表/汇总表",
            "交付/进展": "待处理",
          },
        },
      });
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls[1]).toEqual([
        "base", "+record-get",
        "--as", "user",
        "--base-token", "NFRabnLOJaldfVsWKbjcuR07nKe",
        "--table-id", "tblREDACTEDTABLEID",
        "--record-id", "recvrSCvk4eUxc",
        "--format", "json",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("maps the full record-get row projection without depending on renamed fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-bitable-row-projection-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, [
        "#!/usr/bin/env node",
        "if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { items: [{ comment_id: 'comment_416', content: { elements: [{ type: 'text_run', text_run: { text: '@SuperMatrix 请继续' } }] } }] } }));",
        "} else if (process.argv[2] === 'base' && process.argv[3] === '+record-get') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { data: [[416, '任务内容', '盘点中', 'tobedone', '已有结论等待审批', true]], fields: ['序号', '内容', 'for 人-进展状态', 'Todo owner alias', 'for-agent进展状态', '超级高优'], record_id_list: ['recvrSqY2qbks1'] } }));",
        "} else { process.exit(12); }",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const context = await client.getDriveCommentContext({
        kind: "drive_comment",
        eventId: "evt_record_row_projection",
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSqY2qbks1",
        commentId: "comment_416",
      });

      expect(context.bitableRecord).toEqual({
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSqY2qbks1",
        fields: {
          "序号": 416,
          "内容": "任务内容",
          "for 人-进展状态": "盘点中",
          "Todo owner alias": "tobedone",
          "for-agent进展状态": "已有结论等待审批",
          "超级高优": true,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a Bitable anchor from reply notify_extra when the event omits it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-bitable-anchor-recovery-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(fakeLarkCli, [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
        "if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { items: [{ comment_id: '7673460608817253339', reply_list: { replies: [{ reply_id: '7673460608838208480', content: { elements: [{ type: 'text_run', text_run: { text: '调研优惠券使用情况' } }] }, extra: { notify_extra: { record: 'recvrSqY2qbks1', table: 'tblREDACTEDTABLEID', view: 'vewHxC6aOZ' } } }] } }] } }));",
        "} else if (process.argv[2] === 'base' && process.argv[3] === '+record-get') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { records: [{ record_id: 'recvrSqY2qbks1', fields: { '序号': 416, 'Todo owner alias': 'product-tracker' } }] } }));",
        "} else { process.exit(12); }",
        "",
      ].join("\n"), { mode: 0o755 });
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const context = await client.getDriveCommentContext({
        kind: "drive_comment",
        eventId: "evt_missing_anchor",
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        commentId: "7673460608817253339",
        replyId: "7673460608838208480",
      });

      expect(context).toMatchObject({
        text: "调研优惠券使用情况",
        bitableRecord: {
          tableId: "tblREDACTEDTABLEID",
          recordId: "recvrSqY2qbks1",
          fields: { "序号": 416, "Todo owner alias": "product-tracker" },
        },
      });
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(calls[1]).toEqual([
        "base", "+record-get",
        "--as", "user",
        "--base-token", "NFRabnLOJaldfVsWKbjcuR07nKe",
        "--table-id", "tblREDACTEDTABLEID",
        "--record-id", "recvrSqY2qbks1",
        "--format", "json",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores Drive comment events that do not mention the bot", () => {
    const raw = parseDriveCommentEvent({
      header: {
        event_id: "evt_2",
        event_type: "drive.notice.comment_add_v1",
      },
      event: {
        file_token: "doc_token",
        file_type: "docx",
        comment_id: "comment_2",
        comment: {
          content: "普通评论",
        },
      },
    }, { botAppId: "cli_app", botOpenId: "ou_bot" });

    expect(raw).toBeUndefined();
  });
});

describe("extractForwardedTranscript", () => {
  test("returns undefined when wrapper is absent", () => {
    expect(extractForwardedTranscript("plain text")).toBeUndefined();
    expect(extractForwardedTranscript('{"title":"x"}')).toBeUndefined();
    expect(extractForwardedTranscript("")).toBeUndefined();
  });

  test("strips wrapper and surrounding newlines, preserves inner formatting", () => {
    const inner = "[2026-05-06T10:20:58+08:00] Alice:\n    hello\n[2026-05-06T10:21:00+08:00] Bob:\n    hi";
    const wrapped = `<forwarded_messages>\n${inner}\n</forwarded_messages>`;
    expect(extractForwardedTranscript(wrapped)).toBe(inner);
  });

  test("returns empty string for an empty wrapper", () => {
    expect(extractForwardedTranscript("<forwarded_messages></forwarded_messages>")).toBe("");
    expect(extractForwardedTranscript("<forwarded_messages>\n</forwarded_messages>")).toBe("");
  });
});

describe("renderForwardedTranscript", () => {
  // Real fixture from a production merge_forward (om_x100b509b...) — exactly
  // the shape lark-cli's +messages-mget returns: [ISO8601] sender: line,
  // 4-space-indented body lines beneath. Anything else means we drifted from
  // Feishu's actual response.
  const realTranscript = [
    "[2026-05-06T10:20:58+08:00] ou_REDACTEDOPENID:",
    "    加州旧金山——Anthropic 等公司宣布成立企业服务公司。",
    "[2026-05-06T10:24:41+08:00] PERSON_REDACTED:",
    "    所以 要不 快点趁这个时候 快速去搞一下？",
    "[2026-05-06T10:25:02+08:00] PERSON_REDACTED:",
    "    感觉又是心态问题了。。",
  ].join("\n");

  test("renders header with msg count, body lines, parent_message_id trailer", () => {
    const out = renderForwardedTranscript({
      parentMessageId: "om_REDACTEDMESSAGEID",
      transcript: realTranscript,
    });
    expect(out.startsWith("[Merged forward · 3条消息]")).toBe(true);
    expect(out).toContain("[2026-05-06T10:20:58+08:00]");
    expect(out).toContain("PERSON_REDACTED");
    expect(out).toContain("    感觉又是心态问题了。。");
    expect(out.endsWith("parent_message_id: om_REDACTEDMESSAGEID")).toBe(true);
  });

  test("falls back to header without count when transcript has no [ISO] lines", () => {
    const out = renderForwardedTranscript({
      parentMessageId: "om_p",
      transcript: "anything without iso headers",
    });
    expect(out.startsWith("[Merged forward]\n")).toBe(true);
    expect(out).toContain("parent_message_id: om_p");
  });

  test("truncates past MERGE_FORWARD_MAX_LINES with re-fetch hint", () => {
    const lines: string[] = [];
    for (let i = 0; i < MERGE_FORWARD_MAX_LINES + 10; i++) {
      lines.push(`[2026-05-06T10:${String(20 + i).padStart(2, "0")}:00+08:00] u${i}:`);
      lines.push(`    msg-${i}`);
    }
    const out = renderForwardedTranscript({
      parentMessageId: "om_p",
      transcript: lines.join("\n"),
    });
    expect(out).toContain("truncated");
    expect(out).toContain("more messages — re-fetch via parent_message_id");
    expect(out).toContain("parent_message_id: om_p");
  });

  test("respects MERGE_FORWARD_MAX_CHARS soft cap", () => {
    // One huge body line per "message" so the char cap is what kicks in
    // before the line cap.
    const big = "x".repeat(800);
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`[2026-05-06T10:${String(20 + i).padStart(2, "0")}:00+08:00] u${i}:`);
      lines.push(`    ${big}`);
    }
    const out = renderForwardedTranscript({
      parentMessageId: "om_p",
      transcript: lines.join("\n"),
    });
    expect(out.length).toBeLessThan(MERGE_FORWARD_MAX_CHARS + 500);
    expect(out).toContain("truncated");
    expect(out).toContain("parent_message_id: om_p");
  });
});

describe("subscribeInbound attachments", () => {
  test("subscribes to Drive comment events and emits mentioned comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        header: {
          event_id: "evt_drive_1",
          event_type: "drive.notice.comment_add_v1",
        },
        event: {
          file_token: "doc_token",
          file_type: "docx",
          comment_id: "comment_1",
          operator_id: { open_id: "ou_user" },
          comment: {
            content: '<at user_id="ou_bot">SuperMatrix</at> 帮我记一下',
          },
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        `  process.stdout.write(${JSON.stringify(subscribePayload)} + "\\n");`,
        "  setTimeout(() => process.exit(0), 1000);",
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawInbound>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(message);
        });
      });

      expect(raw).toEqual({
        kind: "drive_comment",
        source: {
          kind: "drive_comment",
          eventId: "evt_drive_1",
          fileToken: "doc_token",
          fileType: "docx",
          commentId: "comment_1",
          fromUserId: "ou_user",
        },
      });
      const calls = await readFile(callsPath, "utf8");
      const call = JSON.parse(calls.trim().split("\n")[0] ?? "[]") as string[];
      expect(call).not.toContain("--event-types");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("polls watched Drive comments and emits each mentioned reply once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-poll-positive-"));
    try {
      const watchPath = join(dir, "watch.json");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(watchPath, JSON.stringify({
        watches: [{ fileToken: "doc_token", fileType: "docx", since: 1_000 }],
      }));
      const commentsPayload = JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              comment_id: "comment_poll",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_poll",
                    create_time: 2_000,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " pinglunmaster poll probe" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        "  setInterval(() => {}, 1000);",
        "} else if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
        "  process.stdout.write(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments' && process.argv[4] === 'list') {",
        `  process.stdout.write(${JSON.stringify(commentsPayload)});`,
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
        driveCommentPollPath: watchPath,
        driveCommentPollIntervalMs: 20,
      });
      const callback = vi.fn();
      const unsubscribe = client.subscribeInbound(callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await unsubscribe();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        kind: "drive_comment",
        source: {
          kind: "drive_comment",
          eventId: "poll:docx:doc_token:comment_poll:reply_poll:2000",
          fileToken: "doc_token",
          fileType: "docx",
          commentId: "comment_poll",
          replyId: "reply_poll",
          fromUserId: "ou_user",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("polls every page of Drive comments instead of dropping beyond 100", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-poll-pages-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const watchPath = join(dir, "watch.json");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(watchPath, JSON.stringify({
        watches: [{ fileToken: "doc_token", fileType: "docx", since: 1_000 }],
      }));
      const page1Payload = JSON.stringify({
        code: 0,
        data: {
          has_more: true,
          page_token: "p2",
          items: [
            {
              comment_id: "comment_p1",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_p1",
                    create_time: 2_000,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " pinglunmaster page 1" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const page2Payload = JSON.stringify({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              comment_id: "comment_p2",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_p2",
                    create_time: 2_001,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " pinglunmaster page 2" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        "  setInterval(() => {}, 1000);",
        "} else if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
        "  process.stdout.write(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments' && process.argv[4] === 'list') {",
        "  const params = JSON.parse(args[args.indexOf('--params') + 1]);",
        "  if (params.page_token === 'p2') {",
        `    process.stdout.write(${JSON.stringify(page2Payload)});`,
        "  } else {",
        `    process.stdout.write(${JSON.stringify(page1Payload)});`,
        "  }",
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
        driveCommentPollPath: watchPath,
        driveCommentPollIntervalMs: 20,
      });
      const callback = vi.fn();
      const unsubscribe = client.subscribeInbound(callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      await vi.waitFor(async () => {
        expect(await readFile(callsPath, "utf8")).toContain("page_token");
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await unsubscribe();

      expect(callback.mock.calls.map((call) => call[0].source.replyId)).toEqual(["reply_p1", "reply_p2"]);
      const calls = await readFile(callsPath, "utf8");
      const listCalls = calls.trim().split("\n").map((line) => JSON.parse(line))
        .filter((call) => call[0] === "drive" && call[1] === "file.comments");
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
      expect(listCalls[0]?.join(" ")).not.toContain("page_token");
      expect(listCalls[1]?.join(" ")).toContain('"page_token":"p2"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("polls every reply page for comments with more replies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-poll-replies-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const watchPath = join(dir, "watch.json");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(watchPath, JSON.stringify({
        watches: [{ fileToken: "doc_token", fileType: "docx", since: 1_000 }],
      }));
      const commentsPayload = JSON.stringify({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              comment_id: "comment_multi",
              has_more: true,
              page_token: "rp2",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_emb",
                    create_time: 2_000,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " pinglunmaster embedded" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const repliesPayload = JSON.stringify({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              reply_id: "reply_page2",
              create_time: 2_001,
              user_id: "ou_user",
              content: {
                elements: [
                  { type: "person", person: { user_id: "ou_bot" } },
                  { type: "text_run", text_run: { text: " pinglunmaster page 2" } },
                ],
              },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        "  setInterval(() => {}, 1000);",
        "} else if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
        "  process.stdout.write(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments' && process.argv[4] === 'list') {",
        `  process.stdout.write(${JSON.stringify(commentsPayload)});`,
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comment.replys' && process.argv[4] === 'list') {",
        "  const params = JSON.parse(args[args.indexOf('--params') + 1]);",
        "  if (params.comment_id !== 'comment_multi' || params.page_token !== 'rp2') process.exit(14);",
        `  process.stdout.write(${JSON.stringify(repliesPayload)});`,
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
        driveCommentPollPath: watchPath,
        driveCommentPollIntervalMs: 20,
      });
      const callback = vi.fn();
      const unsubscribe = client.subscribeInbound(callback);
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await unsubscribe();

      expect(callback.mock.calls.map((call) => call[0].source.replyId)).toEqual(["reply_emb", "reply_page2"]);
      const calls = await readFile(callsPath, "utf8");
      const replyCalls = calls.trim().split("\n").map((line) => JSON.parse(line))
        .filter((call) => call[0] === "drive" && call[1] === "file.comment.replys");
      expect(replyCalls.length).toBeGreaterThanOrEqual(1);
      expect(replyCalls[0]?.join(" ")).toContain('"comment_id":"comment_multi"');
      expect(replyCalls[0]?.join(" ")).toContain('"page_token":"rp2"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unsubscribe cancels an in-flight Drive poll before callbacks, retries, or follow-up CLI spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-poll-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const watchPath = join(dir, "watch.json");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(watchPath, JSON.stringify({
        watches: [{ fileToken: "doc_token", fileType: "docx", since: 1_000 }],
      }));
      const commentsPayload = JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              comment_id: "comment_poll",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_poll",
                    create_time: 2_000,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " pinglunmaster poll probe" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        "  setInterval(() => {}, 1000);",
        "} else if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
        "  process.stdout.write(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === '+search') {",
        "  process.stdout.write(JSON.stringify({ ok: true, data: { has_more: false, results: [] } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments' && process.argv[4] === 'list') {",
        `  setTimeout(() => process.stdout.write(${JSON.stringify(commentsPayload)}), 150);`,
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
        driveCommentPollPath: watchPath,
        driveCommentPollIntervalMs: 20,
      });
      const callback = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const unsubscribe = client.subscribeInbound(callback);
      await waitForCondition(async () => (await readFile(callsPath, "utf8").catch(() => ""))
        .includes('"drive","file.comments","list"'));
      warn.mockClear();
      error.mockClear();
      await unsubscribe();
      await rm(fakeLarkCli, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const calls = await readFile(callsPath, "utf8");
      const pollCalls = calls.split("\n").filter((line) => line.includes('"drive","file.comments","list"'));
      expect(callback).not.toHaveBeenCalled();
      expect(pollCalls).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join(" ")).not.toContain("ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not search Drive comments when no files are explicitly watched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-drive-comment-no-search-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const watchPath = join(dir, "watch.json");
      const fakeLarkCli = join(dir, "lark-cli");
      const createTime = Math.floor(Date.now() / 1000);
      await writeFile(watchPath, JSON.stringify({ watches: [] }));
      const searchPayload = JSON.stringify({
        ok: true,
        identity: "user",
        data: {
          has_more: false,
          results: [
            {
              entity_type: "WIKI",
              result_meta: {
                doc_types: "DOCX",
                token: "wiki_node_token",
                icon_info: JSON.stringify({ token: "doc_token" }),
              },
            },
          ],
        },
      });
      const commentsPayload = JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              comment_id: "comment_search",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_search",
                    create_time: createTime,
                    user_id: "ou_user",
                    content: {
                      elements: [
                        { type: "person", person: { user_id: "ou_bot" } },
                        { type: "text_run", text_run: { text: " search discovery probe" } },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        "  setInterval(() => {}, 1000);",
        "} else if (process.argv[2] === 'api' && process.argv[3] === 'GET' && process.argv[4] === '/open-apis/bot/v3/info') {",
          "  process.stdout.write(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }));",
        "} else if (process.argv[2] === 'drive' && process.argv[3] === '+search') {",
        `  process.stdout.write(${JSON.stringify(searchPayload)});`,
        "} else if (process.argv[2] === 'drive' && process.argv[3] === 'file.comments' && process.argv[4] === 'list') {",
        `  process.stdout.write(${JSON.stringify(commentsPayload)});`,
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
        driveCommentPollPath: watchPath,
        driveCommentPollIntervalMs: 20,
      });
      const callback = vi.fn();
      const unsubscribe = client.subscribeInbound(callback);
      await waitForCondition(async () => (await readFile(callsPath, "utf8").catch(() => ""))
        .includes('"event","+subscribe"'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      unsubscribe();

      expect(callback).not.toHaveBeenCalled();
      const calls = await readFile(callsPath, "utf8");
      expect(calls).not.toContain('"drive","+search"');
      expect(calls).not.toContain('"drive","file.comments","list"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fetches referenced message metadata from compact parent_id events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-ref-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_current",
        chat_id: "oc_team",
        sender_id: "ou_bob",
        chat_type: "group",
        msg_type: "text",
        content: "这个怎么处理？",
        parent_id: "om_referenced",
        root_id: "om_thread_root",
        timestamp: "1700000000000",
      });
      const mgetResponse = JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_referenced",
              msg_type: "text",
              content: JSON.stringify({ text: "quoted message body" }),
              create_time: "1700000001000",
              sender: { id: "ou_alice", name: "Alice" },
            },
          ],
        },
      });
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then`,
        `  cat <<'JSON'`,
        mgetResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(message as LarkRawMessage);
        });
      });

      expect(raw.text).toBe("这个怎么处理？");
      expect(raw.referencedMessage).toMatchObject({
        messageId: "om_referenced",
        text: "quoted message body",
        senderId: "ou_alice",
        senderName: "Alice",
        timestampMs: 1_700_000_001_000,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fetches referenced message metadata from compact reply_to events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-reply-to-ref-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const callsPath = join(dir, "calls.jsonl");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_current",
        chat_id: "oc_team",
        sender_id: "ou_bob",
        chat_type: "group",
        msg_type: "text",
        content: "我引用的这条消息内容是什么",
        reply_to: "om_referenced_reply_to",
        timestamp: "1700000000000",
      });
      const mgetResponse = JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_referenced_reply_to",
              msg_type: "text",
              content: JSON.stringify({ text: "reply_to quoted body" }),
              create_time: "1700000001000",
              sender: { id: "ou_alice", name: "Alice" },
            },
          ],
        },
      });
      const script = [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        "if (process.argv[2] === 'event' && process.argv[3] === '+subscribe') {",
        `  process.stdout.write(${JSON.stringify(subscribePayload)} + "\\n");`,
        "  setTimeout(() => process.exit(0), 1000);",
        "} else if (process.argv[2] === 'im' && process.argv[3] === '+messages-mget') {",
        `  process.stdout.write(${JSON.stringify(mgetResponse)});`,
        "}",
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.text).toBe("我引用的这条消息内容是什么");
      expect(raw.referencedMessage).toMatchObject({
        messageId: "om_referenced_reply_to",
        text: "reply_to quoted body",
        senderId: "ou_alice",
        senderName: "Alice",
        timestampMs: 1_700_000_001_000,
      });
      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toContainEqual([
        "im",
        "+messages-mget",
        "--as",
        "bot",
        "--message-ids",
        "om_referenced_reply_to",
        "--no-reactions",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("emits current message with referenced id when referenced fetch fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-ref-fail-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_current",
        chat_id: "oc_team",
        sender_id: "ou_bob",
        chat_type: "group",
        msg_type: "text",
        content: "看这个",
        parent_message_id: "om_missing",
        timestamp: "1700000000000",
      });
      const mgetResponse = JSON.stringify({
        ok: false,
        error: { type: "Forbidden", message: "no message permission" },
      });
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then`,
        `  cat <<'JSON'`,
        mgetResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.text).toBe("看这个");
      expect(raw.referencedMessage?.messageId).toBe("om_missing");
      expect(raw.referencedMessage?.fetchError).toContain("Forbidden");
      expect(raw.referencedMessage?.fetchError).toContain("no message permission");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves compact @_user placeholders via message detail mentions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-mention-detail-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "m_compact_mention",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "group",
        msg_type: "text",
        content: "@_user_1 在吗",
        timestamp: "1700000000000",
      });
      const detailResponse = JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              message_id: "m_compact_mention",
              body: { content: JSON.stringify({ text: "@_user_1 在吗" }) },
              mentions: [
                {
                  key: "@_user_1",
                  id: "ou_bot",
                  id_type: "open_id",
                  name: "SuperMatrix",
                },
              ],
            },
          ],
        },
        msg: "success",
      });
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "api" ] && [ "$2" = "GET" ]; then`,
        `  cat <<'JSON'`,
        detailResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.mentionedBot).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves compact display-name mentions via message detail mentions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-display-mention-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "m_display_mention",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "group",
        msg_type: "text",
        content: "@SuperMatrix 在吗",
        timestamp: "1700000000000",
      });
      const detailResponse = JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              message_id: "m_display_mention",
              body: { content: JSON.stringify({ text: "@_user_1 在吗" }) },
              mentions: [
                {
                  key: "@_user_1",
                  id: "ou_bot",
                  id_type: "open_id",
                  name: "SuperMatrix",
                },
              ],
            },
          ],
        },
        msg: "success",
      });
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "api" ] && [ "$2" = "GET" ]; then`,
        `  cat <<'JSON'`,
        detailResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.mentionedBot).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks messages that explicitly mention the bot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-mention-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const payload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "m_mention",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "group",
        msg_type: "text",
        content: "hello @_user_1",
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "SuperMatrix",
          },
        ],
        timestamp: "1700000000000",
      });
      await writeFile(fakeLarkCli, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\nsleep 0.1\n`);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        botOpenId: "ou_bot",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.mentionedBot).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts inline image placeholders from text events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const payload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "m1",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "group",
        msg_type: "text",
        content: "请看这张图[Image: img_v3_abc123]",
        timestamp: "1700000000000",
      });
      await writeFile(fakeLarkCli, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\nsleep 0.1\n`);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.text).toBe("请看这张图[Image: img_v3_abc123]");
      expect(raw.attachments).toEqual([
        {
          kind: "image",
          remoteKey: "img_v3_abc123",
          originalName: "img_v3_abc123.png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts image attachments from post (rich text) message events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-post-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      // Mirrors the real mr_e093451b regression: a post message mixing an
      // inline image with text previously produced zero attachments.
      const payload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "m_post_1",
        chat_id: "oc_1",
        sender_id: "ou_1",
        chat_type: "group",
        msg_type: "post",
        content: JSON.stringify({
          title: "",
          content: [
            [{ tag: "img", image_key: "img_v3_post_evt", width: 3552, height: 1328 }],
            [{ tag: "text", text: "你看下图片", style: [] }],
          ],
          content_v2: [
            [{ tag: "img", image_key: "img_v3_post_evt", width: 3552, height: 1328 }],
            [{ tag: "text", text: "你看下图片", style: [] }],
          ],
        }),
        timestamp: "1700000000000",
      });
      await writeFile(fakeLarkCli, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\nsleep 0.1\n`);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      // Deduped across content + content_v2.
      expect(raw.attachments).toEqual([
        {
          kind: "image",
          remoteKey: "img_v3_post_evt",
          originalName: "img_v3_post_evt.png",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merge_forward msg_type triggers mget expansion and emits readable transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-mf-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      // Subscribe stream emits one merge_forward event then sleeps so the
      // child stays alive long enough for the mget call to complete.
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_parent",
        chat_id: "oc_team",
        sender_id: "ou_alice",
        chat_type: "group",
        msg_type: "merge_forward",
        content: "[Merged forward]",
        timestamp: "1700000000000",
      });
      // mget response shape captured live from lark-cli 1.0.13:
      //   data.messages[].content is a string wrapped in
      //   <forwarded_messages>...</forwarded_messages> with one
      //   "[ISO8601] sender:" header line + indented body per sub-message.
      // No body.content, no childIds, no JSON inside content.
      const forwardedContent = [
        "<forwarded_messages>",
        "[2026-05-06T10:20:58+08:00] Alice:",
        "    早上好",
        "[2026-05-06T10:24:41+08:00] Bob:",
        "    要不要快点搞一下",
        "</forwarded_messages>",
      ].join("\n");
      const mgetResponse = JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_parent",
              msg_type: "merge_forward",
              content: forwardedContent,
              create_time: "2026-05-06 10:20",
              sender: { name: "Alice", id_type: "open_id" },
            },
          ],
          total: 1,
        },
      });

      // Single fake binary that branches on the first two args. NDJSON line
      // for subscribe; single JSON for mget.
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then`,
        `  cat <<'JSON'`,
        mgetResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.messageId).toBe("om_parent");
      expect(raw.text).toContain("[Merged forward · 2条消息]");
      expect(raw.text).toContain("[2026-05-06T10:20:58+08:00] Alice:");
      expect(raw.text).toContain("    早上好");
      expect(raw.text).toContain("[2026-05-06T10:24:41+08:00] Bob:");
      expect(raw.text).toContain("    要不要快点搞一下");
      expect(raw.text).toContain("parent_message_id: om_parent");
      // Sanity: not the bare 16-char placeholder, and not the
      // "内容不可解析" fallback that fired when we assumed JSON.
      expect(raw.text).not.toContain("内容不可解析");
      expect(raw.text.length).toBeGreaterThan(50);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merge_forward content without <forwarded_messages> wrapper falls back to 内容不可解析", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-mf-noop-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_no_wrapper",
        chat_id: "oc_team",
        sender_id: "ou_alice",
        msg_type: "merge_forward",
        content: "[Merged forward]",
        timestamp: "1700000000000",
      });
      // mget returns content with no wrapper — defensive path.
      const mgetResponse = JSON.stringify({
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_no_wrapper",
              msg_type: "merge_forward",
              content: "(some shape we don't recognise)",
            },
          ],
          total: 1,
        },
      });
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then`,
        `  cat <<'JSON'`,
        mgetResponse,
        `JSON`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });
      expect(raw.text).toContain("内容不可解析");
      expect(raw.text).toContain("parent_message_id: om_no_wrapper");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merge_forward mget failure emits fallback placeholder including parent_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-mf-fail-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const subscribePayload = JSON.stringify({
        event_type: "im.message.receive_v1",
        message_id: "om_parent_fail",
        chat_id: "oc_team",
        sender_id: "ou_alice",
        msg_type: "merge_forward",
        content: "[Merged forward]",
        timestamp: "1700000000000",
      });
      // mget branch exits non-zero with no stdout to force the error path.
      const script = [
        "#!/bin/sh",
        `if [ "$1" = "event" ] && [ "$2" = "+subscribe" ]; then`,
        `  cat <<'JSON'`,
        subscribePayload,
        `JSON`,
        `  sleep 1`,
        `elif [ "$1" = "im" ] && [ "$2" = "+messages-mget" ]; then`,
        `  echo "boom" 1>&2`,
        `  exit 2`,
        `fi`,
        "",
      ].join("\n");
      await writeFile(fakeLarkCli, script);
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "",
        ownerUserId: "",
      });
      const raw = await new Promise<LarkRawMessage>((resolve) => {
        const unsubscribe = client.subscribeInbound((message) => {
          unsubscribe();
          resolve(requireRawMessage(message));
        });
      });

      expect(raw.messageId).toBe("om_parent_fail");
      expect(raw.text).toContain("Merged forward");
      expect(raw.text).toContain("fetch failed");
      expect(raw.text).toContain("om_parent_fail");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("card lifecycle", () => {
  test("postCard retries transient interactive send failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-postcard-retry-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const statePath = join(dir, "state.json");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const argv = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");`,
          `const statePath = ${JSON.stringify(statePath)};`,
          "const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { interactive: 0 };",
          "if (argv.includes('--msg-type') && argv.includes('interactive')) {",
          "  state.interactive += 1;",
          "  fs.writeFileSync(statePath, JSON.stringify(state));",
          "  if (state.interactive === 1) {",
          "    process.stdout.write(JSON.stringify({ ok: false, identity: 'bot', error: { type: 'internal', subtype: 'invalid_response', message: \"SDK returned an invalid JSON response: failed to parse TAT response (HTTP 429): invalid character 'r' looking for beginning of value\" } }));",
          "    process.exit(0);",
          "  }",
          "  process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: 'oc_1', message_id: 'om_card_retry', create_time: '1' } }));",
          "  process.exit(0);",
          "}",
          "process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: 'oc_1', message_id: 'om_text_unexpected', create_time: '1' } }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const cardId = await client.postCard(asLarkGroupId("oc_1"), "running", "session · running");

      expect(cardId).toBe("om_card_retry");
      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((call) => call.includes("--msg-type") && call.includes("interactive"))).toHaveLength(2);
      expect(calls.filter((call) => call.includes("--text"))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("postCard falls back to text when interactive send keeps failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-postcard-text-fallback-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const argv = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");`,
          "if (argv.includes('--msg-type') && argv.includes('interactive')) {",
          "  process.stdout.write(JSON.stringify({ ok: false, identity: 'bot', error: { type: 'internal', subtype: 'invalid_response', message: \"SDK returned an invalid JSON response: failed to parse TAT response (HTTP 429): invalid character 'r' looking for beginning of value\" } }));",
          "  process.exit(0);",
          "}",
          "process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: 'oc_1', message_id: 'om_text_fallback', create_time: '1' } }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const cardId = await client.postCard(asLarkGroupId("oc_1"), "running", "session · running");

      expect(cardId).toBe("om_text_fallback");
      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((call) => call.includes("--msg-type") && call.includes("interactive"))).toHaveLength(2);
      const textSends = calls.filter((call) => call.includes("--text"));
      expect(textSends).toHaveLength(1);
      expect(textSends[0]).toContain("session · running\nrunning");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("postCard normalizes lark-cli stderr error envelopes before fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-postcard-stderr-error-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const argv = process.argv.slice(2);",
          "if (argv.includes('--msg-type') && argv.includes('interactive')) {",
          "  process.stderr.write(JSON.stringify({ ok: false, identity: 'bot', error: { type: 'internal', subtype: 'invalid_response', message: \"SDK returned an invalid JSON response: failed to parse TAT response (HTTP 429): invalid character 'r' looking for beginning of value\" }, _notice: { update: { message: 'lark-cli update available' } } }));",
          "  process.exit(1);",
          "}",
          "process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: 'oc_1', message_id: 'om_text_stderr_fallback', create_time: '1' } }));",
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const cardId = await client.postCard(asLarkGroupId("oc_1"), "running", "session · running");

      expect(cardId).toBe("om_text_stderr_fallback");
      const warnings = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnings).toContain("HTTP 429");
      expect(warnings).not.toContain("_notice");
      expect(warnings).not.toContain("lark-cli update available");
    } finally {
      warnSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finalizeCard passes processLog into ordinary completed card PATCH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-finalize-process-log-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          'process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: "oc_1", message_id: "om_card", create_time: "1" } }));',
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const cardId = await client.postCard(asLarkGroupId("oc_1"), "running", "session · running");
      await client.finalizeCard(
        cardId,
        "final answer",
        "session · done",
        "💭 thinking\n🔧 tool\n✅ result",
        "completed",
      );

      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const patchCall = calls.find((call) => call[0] === "api" && call[1] === "PATCH");
      expect(patchCall).toBeDefined();
      const data = JSON.parse(patchCall?.[patchCall.indexOf("--data") + 1] ?? "{}") as {
        content?: string;
      };
      const card = parse(data.content ?? "{}");
      const body = card.body as { elements: Array<Record<string, unknown>> };
      expect(body.elements[0]).toEqual({ tag: "markdown", content: "final answer" });
      const panel = body.elements[1] as Record<string, unknown>;
      expect(panel.tag).toBe("collapsible_panel");
      // Short trace → auto-expanded (PROCESS_LOG_AUTO_EXPAND_MAX_CHARS).
      expect(panel.expanded).toBe(true);
      const inner = panel.elements as Array<Record<string, unknown>>;
      expect((inner[0] as { content: string }).content).toContain("💭 thinking");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("finalizeCard completedTemplate override recolors a completed card to violet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-finalize-template-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          'process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: "oc_1", message_id: "om_card", create_time: "1" } }));',
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });

      // Completed run with the autonomous-turn override → violet header.
      const doneCard = await client.postCard(asLarkGroupId("oc_1"), "running", "s · running");
      await client.finalizeCard(doneCard, "final answer", "s · done", undefined, "completed", "violet");

      // Failed run with the same override → header must stay red.
      const failedCard = await client.postCard(asLarkGroupId("oc_1"), "running", "s · running");
      await client.finalizeCard(failedCard, "❌ boom", "s · failed", undefined, "failed", "violet");

      // Completed run without override → header stays green.
      const plainCard = await client.postCard(asLarkGroupId("oc_1"), "running", "s · running");
      await client.finalizeCard(plainCard, "final answer", "s · done", undefined, "completed");

      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const templates = calls
        .filter((call) => call[0] === "api" && call[1] === "PATCH")
        .map((call) => {
          const data = JSON.parse(call[call.indexOf("--data") + 1] ?? "{}") as { content?: string };
          const card = parse(data.content ?? "{}") as { header?: { template?: string } };
          return card.header?.template;
        });
      expect(templates).toEqual(["violet", "red", "green"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ErrCode 11310 table-over-limit: card-safe PATCH keeps answer in the card, NO standalone text (mr_17449198 regression)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-finalize-table-limit-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      // Fake lark-cli: an `api PATCH` whose card body still contains a bare
      // (un-fenced) markdown table is rejected the way Feishu rejects
      // code=230099 / ErrCode=11310 "card table number over limit". Once the
      // table is degraded into a code fence the same PATCH succeeds. Any other
      // call (postCard interactive send, or a text send) returns ok.
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const argv = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");`,
          "if (argv[0] === 'api' && argv[1] === 'PATCH') {",
          "  const dataIdx = argv.indexOf('--data');",
          "  const data = JSON.parse(argv[dataIdx + 1] || '{}');",
          "  const content = data.content || '';",
          "  const hasDelimiterCell = /\\|[ :]*-{2,}[ :]*\\|/.test(content);",
          "  const hasFence = content.indexOf('```') !== -1;",
          "  if (hasDelimiterCell && !hasFence) {",
          "    process.stdout.write(JSON.stringify({ ok: false, code: 230099, error: { type: 'feishu', message: 'card table number over limit (ErrCode 11310)' } }));",
          "    process.exit(0);",
          "  }",
          "  process.stdout.write(JSON.stringify({ ok: true, data: {} }));",
          "  process.exit(0);",
          "}",
          'process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: "oc_1", message_id: "om_card", create_time: "1" } }));',
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);

      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const cardId = await client.postCard(asLarkGroupId("oc_1"), "running", "amzdata · running");

      const sopBody = [
        "# SOP 草稿",
        "",
        "| 步骤 | 动作 |",
        "| --- | --- |",
        "| 1 | 第一步 |",
        "| 2 | 第二步 |",
        "",
        "结尾说明",
      ].join("\n");
      await client.finalizeCard(cardId, sopBody, "amzdata · done", "💭 thinking\n🔧 tool", "completed");

      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);

      // The final answer must NEVER leak out as a standalone text message.
      const textSends = calls.filter(
        (call) => call[0] === "im" && call[1] === "+messages-send" && call.includes("--text"),
      );
      expect(textSends).toHaveLength(0);

      // The ladder should have attempted a card-safe PATCH (with-log fail,
      // without-log fail, card-safe success): 3 PATCH calls in total.
      const patchCalls = calls.filter((call) => call[0] === "api" && call[1] === "PATCH");
      expect(patchCalls).toHaveLength(3);

      // The last (succeeding) PATCH must carry the degraded, table-safe body
      // inside the SAME card — table content preserved, but fenced as code.
      const lastPatch = patchCalls[patchCalls.length - 1];
      const data = JSON.parse(lastPatch?.[lastPatch.indexOf("--data") + 1] ?? "{}") as {
        content?: string;
      };
      const card = parse(data.content ?? "{}");
      const body = card.body as { elements: Array<Record<string, unknown>> };
      const finalMarkdown = (body.elements[0] as { content: string }).content;
      expect(finalMarkdown).toContain("```");
      expect(finalMarkdown).toContain("| 步骤 | 动作 |");
      expect(finalMarkdown).toContain("结尾说明");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Drive comment client operations", () => {
  test("reads comment context with batch_query and extracts text, quote, and replies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-drive-comment-context-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      const response = {
        ok: true,
        data: {
          items: [
            {
              comment_id: "comment_1",
              quote: "被评论正文",
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_root",
                    content: { elements: [{ type: "text_run", text_run: { text: "@SuperMatrix 帮我记一下" } }] },
                  },
                  {
                    reply_id: "reply_2",
                    content: { elements: [{ type: "text_run", text_run: { text: "补充信息" } }] },
                  },
                ],
              },
            },
          ],
        },
      };
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });

      await expect(client.getDriveCommentContext({
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
      })).resolves.toEqual({
        text: "@SuperMatrix 帮我记一下",
        quote: "被评论正文",
        threadReplies: ["补充信息"],
      });

      const calls = await readFile(callsPath, "utf8");
      const call = JSON.parse(calls.trim()) as string[];
      expect(call.slice(0, 3)).toEqual(["drive", "file.comments", "batch_query"]);
      expect(call).toContain("--as");
      expect(call[call.indexOf("--as") + 1]).toBe("bot");
      expect(JSON.parse(call[call.indexOf("--params") + 1] ?? "{}")).toEqual({
        file_token: "doc_token",
        file_type: "docx",
        user_id_type: "open_id",
      });
      expect(JSON.parse(call[call.indexOf("--data") + 1] ?? "{}")).toEqual({
        comment_ids: ["comment_1"],
        need_reaction: false,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the root comment and prior replies as thread context for reply mentions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-drive-comment-reply-context-"));
    try {
      const fakeLarkCli = join(dir, "lark-cli");
      const response = {
        ok: true,
        data: {
          items: [
            {
              comment_id: "comment_1",
              quote: "记录 1",
              content: { elements: [{ type: "text_run", text_run: { text: "根评论内容" } }] },
              reply_list: {
                replies: [
                  {
                    reply_id: "reply_prior",
                    content: { elements: [{ type: "text_run", text_run: { text: "前一条补充" } }] },
                  },
                  {
                    reply_id: "reply_current",
                    content: { elements: [{ type: "text_run", text_run: { text: "@SuperMatrix 查这条" } }] },
                  },
                ],
              },
            },
          ],
        },
      };
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });

      await expect(client.getDriveCommentContext({
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "base_token",
        fileType: "bitable",
        commentId: "comment_1",
        replyId: "reply_current",
      })).resolves.toEqual({
        text: "@SuperMatrix 查这条",
        quote: "记录 1",
        threadReplies: ["根评论内容", "前一条补充"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("posts replies and fallback comments through Drive comment APIs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-drive-comment-reply-"));
    try {
      const callsPath = join(dir, "calls.jsonl");
      const fakeLarkCli = join(dir, "lark-cli");
      await writeFile(
        fakeLarkCli,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
          'process.stdout.write(JSON.stringify({ ok: true, data: { reply_id: "reply_new", comment_id: "comment_new" } }));',
          "",
        ].join("\n"),
      );
      await chmod(fakeLarkCli, 0o755);
      const client = createRealLarkClient({
        larkCliPath: fakeLarkCli,
        botAppId: "cli_app",
        ownerUserId: "",
      });
      const source = {
        kind: "drive_comment" as const,
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx" as const,
        commentId: "comment_1",
      };

      await client.replyToDriveComment({ source, text: "已记录" });
      await client.createDriveComment({ source, text: "已新建回复", mentionUserId: "ou_user" });

      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls[0]?.slice(0, 4)).toEqual(["drive", "file.comment.replys", "create", "--as"]);
      expect(JSON.parse(calls[0]?.[calls[0].indexOf("--params") + 1] ?? "{}")).toEqual({
        file_token: "doc_token",
        file_type: "docx",
        comment_id: "comment_1",
        user_id_type: "open_id",
      });
      expect(JSON.parse(calls[0]?.[calls[0].indexOf("--data") + 1] ?? "{}")).toEqual({
        content: {
          elements: [{ type: "text_run", text_run: { text: "已记录" } }],
        },
      });

      expect(calls[1]?.slice(0, 3)).toEqual(["drive", "file.comments", "create_v2"]);
      expect(JSON.parse(calls[1]?.[calls[1].indexOf("--params") + 1] ?? "{}")).toEqual({
        file_token: "doc_token",
      });
      expect(JSON.parse(calls[1]?.[calls[1].indexOf("--data") + 1] ?? "{}")).toEqual({
        file_type: "docx",
        reply_elements: [
          { type: "mention_user", mention_user: "ou_user" },
          { type: "text", text: " 已新建回复" },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("finalizeCardWithFallback", () => {
  test("first patch succeeds → no retry, no card-safe, no fallback text", async () => {
    const patchWithLog = vi.fn(async () => {});
    const patchWithoutLog = vi.fn(async () => {});
    const patchCardSafe = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card1",
      patchWithLog,
      patchWithoutLog,
      patchCardSafe,
      fallbackText,
      true,
    );

    expect(result).toBe("patched");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).not.toHaveBeenCalled();
    expect(patchCardSafe).not.toHaveBeenCalled();
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("first patch fails, retry without processLog succeeds → no card-safe, no fallback text", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("payload too large"); });
    const patchWithoutLog = vi.fn(async () => {});
    const patchCardSafe = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card2",
      patchWithLog,
      patchWithoutLog,
      patchCardSafe,
      fallbackText,
      true,
    );

    expect(result).toBe("patched-without-log");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).toHaveBeenCalledTimes(1);
    expect(patchCardSafe).not.toHaveBeenCalled();
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("table-over-limit: with-log + without-log fail, card-safe PATCH succeeds → NO standalone text", async () => {
    // Simulates ErrCode 11310 "card table number over limit": the body itself
    // overflows, so both table-bearing PATCH attempts fail. The card-safe
    // degrade must keep the answer inside the card — fallbackText must NOT run.
    const patchWithLog = vi.fn(async () => { throw new Error("card table number over limit"); });
    const patchWithoutLog = vi.fn(async () => { throw new Error("card table number over limit"); });
    const patchCardSafe = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card3",
      patchWithLog,
      patchWithoutLog,
      patchCardSafe,
      fallbackText,
      true,
    );

    expect(result).toBe("patched-card-safe");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).toHaveBeenCalledTimes(1);
    expect(patchCardSafe).toHaveBeenCalledTimes(1);
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("no processLog + table-over-limit: card-safe PATCH attempted before any text fallback", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("card table number over limit"); });
    const patchWithoutLog = vi.fn(async () => {});
    const patchCardSafe = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card4",
      patchWithLog,
      patchWithoutLog,
      patchCardSafe,
      fallbackText,
      false,
    );

    expect(result).toBe("patched-card-safe");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).not.toHaveBeenCalled();
    expect(patchCardSafe).toHaveBeenCalledTimes(1);
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("every card PATCH fails (incl. card-safe) → standalone text only as last resort", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("payload too large"); });
    const patchWithoutLog = vi.fn(async () => { throw new Error("still too large"); });
    const patchCardSafe = vi.fn(async () => { throw new Error("network down"); });
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card5",
      patchWithLog,
      patchWithoutLog,
      patchCardSafe,
      fallbackText,
      true,
    );

    expect(result).toBe("fallback");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).toHaveBeenCalledTimes(1);
    expect(patchCardSafe).toHaveBeenCalledTimes(1);
    expect(fallbackText).toHaveBeenCalledTimes(1);
  });
});

describe("degradeMarkdownTables", () => {
  test("wraps a GFM table in a fenced code block, leaving no bare delimiter row", () => {
    const md = [
      "## SOP draft",
      "",
      "| Step | Action |",
      "| --- | --- |",
      "| 1 | do thing |",
      "| 2 | do other |",
      "",
      "trailing prose",
    ].join("\n");

    const out = degradeMarkdownTables(md);

    // The table content survives, readable, but no longer renders as a table.
    expect(out).toContain("```");
    expect(out).toContain("| Step | Action |");
    expect(out).toContain("trailing prose");
    // No delimiter row sits outside a code fence anymore.
    const fenceBlocks = out.split("```");
    // fenceBlocks: [before, insideFence, after] — the delimiter must be inside.
    expect(fenceBlocks[0]).not.toMatch(/\|\s*-{2,}/u);
    expect(fenceBlocks[2] ?? "").not.toMatch(/\|\s*-{2,}/u);
    expect(fenceBlocks[1]).toMatch(/\|\s*-{2,}/u);
  });

  test("markdown without tables is returned unchanged", () => {
    const md = "# Title\n\nJust prose with a | pipe in a sentence.\n\n- bullet\n";
    expect(degradeMarkdownTables(md)).toBe(md);
  });

  test("tables already inside a code fence are left untouched (no double-wrap)", () => {
    const md = [
      "```",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "```",
    ].join("\n");
    expect(degradeMarkdownTables(md)).toBe(md);
  });

  test("degrades multiple tables independently", () => {
    const md = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "between",
      "",
      "| c | d |",
      "| :-- | --: |",
      "| 3 | 4 |",
    ].join("\n");
    const out = degradeMarkdownTables(md);
    expect((out.match(/```/gu) ?? []).length).toBe(4); // two open+close pairs
    expect(out).toContain("between");
  });
});
