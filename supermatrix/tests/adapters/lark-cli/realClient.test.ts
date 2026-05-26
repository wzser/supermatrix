import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildAsyncChildCompletedCardJson,
  buildCardJson,
  createRealLarkClient,
  eventMentionsBot,
  extractAttachments,
  extractForwardedTranscript,
  finalizeCardWithFallback,
  MAX_PROCESS_LOG_CHARS,
  MERGE_FORWARD_MAX_CHARS,
  MERGE_FORWARD_MAX_LINES,
  parseAsyncChildCompletedMessage,
  renderForwardedTranscript,
  templateForRunStatus,
  truncateProcessLog,
} from "../../../src/adapters/lark-cli/realClient.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";
import type { LarkRawMessage } from "../../../src/adapters/lark-cli/client.ts";

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

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

  test("finalized card with processLog appends a collapsed panel", () => {
    const card = parse(
      buildCardJson("final answer", "green", "session · done", "💭 thinking\n🔧 tool\n✅ result"),
    );
    const body = card.body as { elements: Array<Record<string, unknown>> };
    expect(body.elements).toHaveLength(2);
    expect(body.elements[0]).toEqual({ tag: "markdown", content: "final answer" });
    const panel = body.elements[1] as Record<string, unknown>;
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    const inner = panel.elements as Array<Record<string, unknown>>;
    expect(inner).toEqual([
      { tag: "markdown", content: "💭 thinking\n🔧 tool\n✅ result" },
    ]);
  });

  test("empty/whitespace processLog is dropped — no panel", () => {
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

  test("oversized processLog is truncated with marker, total length capped", () => {
    const bigLog = "x".repeat(MAX_PROCESS_LOG_CHARS * 3);
    const card = parse(buildCardJson("body", "green", "t · done", bigLog));
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const panel = body.elements[1] as Record<string, unknown>;
    const inner = panel.elements as Array<Record<string, unknown>>;
    const logContent = (inner[0] as { content: string }).content;
    expect(logContent.length).toBeLessThanOrEqual(MAX_PROCESS_LOG_CHARS);
    expect(logContent).toContain("已截断 stream log");
    expect(logContent).toContain("DB message_run");
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

test("forwards slash command messages sent by another app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-app-command-"));
  try {
    const fakeLarkCli = join(dir, "lark-cli");
    const payload = JSON.stringify({
      event_type: "im.message.receive_v1",
      message_id: "m_app_command",
      chat_id: "oc_1",
      sender_id: "cli_other_app",
      sender_type: "app",
      chat_type: "group",
      msg_type: "text",
      content: "/sta-writeback task_id=\"698debdc\"",
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
    const raw = await new Promise<LarkRawMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("timed out waiting for app command"));
      }, 1000);
      const unsubscribe = client.subscribeInbound((message) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(message);
      });
    });

    expect(raw.text).toBe('/sta-writeback task_id="698debdc"');
    expect(raw.userId).toBe("cli_other_app");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unwraps card-wrapped slash command messages sent by another app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-cli-app-card-command-"));
  try {
    const fakeLarkCli = join(dir, "lark-cli");
    const payload = JSON.stringify({
      event_type: "im.message.receive_v1",
      message_id: "m_app_card_command",
      chat_id: "oc_1",
      sender_id: "cli_other_app",
      sender_type: "app",
      chat_type: "group",
      msg_type: "interactive",
      content: "<card>\n/sta-writeback task_id=698debdc\n---\n</card>",
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
    const raw = await new Promise<LarkRawMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("timed out waiting for app card command"));
      }, 1000);
      const unsubscribe = client.subscribeInbound((message) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(message);
      });
    });

    expect(raw.text).toBe("/sta-writeback task_id=698debdc");
    expect(raw.userId).toBe("cli_other_app");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    "[2026-05-06T10:20:58+08:00] LARK_OWNER_OPEN_ID:",
    "    加州旧金山——Anthropic 等公司宣布成立企业服务公司。",
    "[2026-05-06T10:24:41+08:00] YOUR_NAME:",
    "    所以 要不 快点趁这个时候 快速去搞一下？",
    "[2026-05-06T10:25:02+08:00] YOUR_NAME:",
    "    感觉又是心态问题了。。",
  ].join("\n");

  test("renders header with msg count, body lines, parent_message_id trailer", () => {
    const out = renderForwardedTranscript({
      parentMessageId: "om_x100b509b24101ca4c3a3e0cfd2daced",
      transcript: realTranscript,
    });
    expect(out.startsWith("[Merged forward · 3条消息]")).toBe(true);
    expect(out).toContain("[2026-05-06T10:20:58+08:00]");
    expect(out).toContain("YOUR_NAME");
    expect(out).toContain("    感觉又是心态问题了。。");
    expect(out.endsWith("parent_message_id: om_x100b509b24101ca4c3a3e0cfd2daced")).toBe(true);
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
          resolve(message);
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
          resolve(message);
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
          resolve(message);
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
          resolve(message);
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
          resolve(message);
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
          resolve(message);
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
          resolve(message);
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

describe("finalizeCardWithFallback", () => {
  test("first patch succeeds → no retry, no fallback text", async () => {
    const patchWithLog = vi.fn(async () => {});
    const patchWithoutLog = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card1",
      patchWithLog,
      patchWithoutLog,
      fallbackText,
      true,
    );

    expect(result).toBe("patched");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).not.toHaveBeenCalled();
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("first patch fails, retry without processLog succeeds → no fallback text", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("payload too large"); });
    const patchWithoutLog = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card2",
      patchWithLog,
      patchWithoutLog,
      fallbackText,
      true,
    );

    expect(result).toBe("patched-without-log");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).toHaveBeenCalledTimes(1);
    expect(fallbackText).not.toHaveBeenCalled();
  });

  test("both patches fail → fallback sendText called once", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("payload too large"); });
    const patchWithoutLog = vi.fn(async () => { throw new Error("still too large"); });
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card3",
      patchWithLog,
      patchWithoutLog,
      fallbackText,
      true,
    );

    expect(result).toBe("fallback");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).toHaveBeenCalledTimes(1);
    expect(fallbackText).toHaveBeenCalledTimes(1);
  });

  test("no processLog and patch fails → fallback without retry", async () => {
    const patchWithLog = vi.fn(async () => { throw new Error("network"); });
    const patchWithoutLog = vi.fn(async () => {});
    const fallbackText = vi.fn(async () => {});

    const result = await finalizeCardWithFallback(
      "card4",
      patchWithLog,
      patchWithoutLog,
      fallbackText,
      false,
    );

    expect(result).toBe("fallback");
    expect(patchWithLog).toHaveBeenCalledTimes(1);
    expect(patchWithoutLog).not.toHaveBeenCalled();
    expect(fallbackText).toHaveBeenCalledTimes(1);
  });
});
