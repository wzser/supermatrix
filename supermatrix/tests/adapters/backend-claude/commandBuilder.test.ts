import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeCommand,
} from "../../../src/adapters/backend-claude/commandBuilder.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../../src/ports/BackendRuntimeDefaults.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

const MCP_ASK_SERVER_PATH =
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/larkc/card-callback/src/mcpAskServer.js";

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/ws/foo"),
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

type UserEnvelope = {
  type: string;
  message: { role: string; content: Array<Record<string, unknown>> };
};

function parseStdinEnvelope(stdin: string | undefined): UserEnvelope {
  expect(stdin).toBeTruthy();
  expect(stdin!.endsWith("\n")).toBe(true);
  return JSON.parse(stdin!.trim()) as UserEnvelope;
}

function stdinText(stdin: string | undefined): string {
  const envelope = parseStdinEnvelope(stdin);
  return envelope.message.content
    .filter((block) => block["type"] === "text")
    .map((block) => block["text"] as string)
    .join("");
}

describe("buildClaudeArgs", () => {
  const ORIGINAL_ENV_DEFAULT = process.env["SM_CLAUDE_DEFAULT_MODEL"];
  const ORIGINAL_NATIVE_IMAGE = process.env["SM_CLAUDE_NATIVE_IMAGE"];
  const ORIGINAL_BROKER_URL = process.env["BROKER_URL"];
  let tempDir: string | undefined;

  beforeEach(() => {
    resetConfiguredBackendRuntimeDefaultsForTests();
    delete process.env["SM_CLAUDE_DEFAULT_MODEL"];
    delete process.env["SM_CLAUDE_NATIVE_IMAGE"];
    delete process.env["BROKER_URL"];
  });

  test("uses configured global defaults when session overrides are null", () => {
    setConfiguredBackendRuntimeDefaults("claude", { model: "claude-sonnet-4-6", effort: "high" });
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    const modelIdx = args.indexOf("--model");
    const effortIdx = args.indexOf("--effort");
    expect(args[modelIdx + 1]).toBe("claude-sonnet-4-6");
    expect(args[effortIdx + 1]).toBe("high");
  });

  test.each(["claude-opus-5", "claude-sonnet-5"])(
    "passes the verified canonical model %s to Claude Code",
    (model) => {
      const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ model }), prompt: "hi" });
      const modelIdx = args.indexOf("--model");
      expect(args[modelIdx + 1]).toBe(model);
    },
  );
  afterEach(async () => {
    if (ORIGINAL_ENV_DEFAULT === undefined) {
      delete process.env["SM_CLAUDE_DEFAULT_MODEL"];
    } else {
      process.env["SM_CLAUDE_DEFAULT_MODEL"] = ORIGINAL_ENV_DEFAULT;
    }
    if (ORIGINAL_NATIVE_IMAGE === undefined) {
      delete process.env["SM_CLAUDE_NATIVE_IMAGE"];
    } else {
      process.env["SM_CLAUDE_NATIVE_IMAGE"] = ORIGINAL_NATIVE_IMAGE;
    }
    if (ORIGINAL_BROKER_URL === undefined) {
      delete process.env["BROKER_URL"];
    } else {
      process.env["BROKER_URL"] = ORIGINAL_BROKER_URL;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("first run includes -p and stream-json but omits --resume", () => {
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).not.toContain("--resume");
    // prompt travels via stream-json stdin, never as a positional
    expect(args).not.toContain("hi");
  });

  test("every run uses stream-json input, requests user-message replay, and sends the prompt as the first user envelope", () => {
    const command = buildClaudeCommand({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    const inputIdx = command.args.indexOf("--input-format");
    expect(inputIdx).toBeGreaterThanOrEqual(0);
    expect(command.args[inputIdx + 1]).toBe("stream-json");
    expect(command.args).toContain("--replay-user-messages");
    const envelope = parseStdinEnvelope(command.stdin);
    expect(envelope.type).toBe("user");
    expect(envelope.message.role).toBe("user");
    expect(envelope.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("first run does not include --cwd (claude has no such flag)", () => {
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("--cwd");
  });

  test("resume run includes --resume <id> and keeps the prompt in stdin", () => {
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "bks-1" }),
      prompt: "hi",
    });
    const resumeIdx = command.args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(command.args[resumeIdx + 1]).toBe("bks-1");
    expect(stdinText(command.stdin)).toBe("hi");
  });

  test("fork run resumes source id and adds --fork-session", () => {
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: null }),
      prompt: "branch prompt",
      conversationFork: { sourceBackendSessionId: "bks-source" },
    });
    const resumeIdx = command.args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(command.args[resumeIdx + 1]).toBe("bks-source");
    expect(command.args).toContain("--fork-session");
    expect(stdinText(command.stdin)).toBe("branch prompt");
  });

  test("image attachments become stream-json stdin image content blocks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "supermatrix-claude-image-"));
    const imagePath = join(tempDir, "a.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ workdir: asAbsolutePath(tempDir) }),
      prompt: "describe it",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath(imagePath),
          originalName: "a.png",
          mimeType: "image/png",
          uploadedAt: asTimestamp(1),
        },
      ],
    });

    expect(command.args).toContain("--input-format");
    expect(command.args).toContain("stream-json");
    expect(command.args).not.toContain("describe it");
    expect(command.stdin).toBeTruthy();
    const envelope = JSON.parse(command.stdin!.trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(envelope.message.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AQID" },
    });
    expect(envelope.message.content.at(-1)).toEqual({
      type: "text",
      text: "describe it",
    });
  });

  test("SM_CLAUDE_NATIVE_IMAGE=0 keeps image attachments as prompt hints", () => {
    process.env["SM_CLAUDE_NATIVE_IMAGE"] = "0";
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.png"),
          originalName: "a.png",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    const prompt = stdinText(command.stdin);
    expect(prompt).toContain("hi");
    expect(prompt).toContain(".attachments/a.png");
    expect(prompt).toContain("图片");
  });

  test("mixed native images and files keep file hints in the stream-json text block", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "supermatrix-claude-mixed-"));
    const imagePath = join(tempDir, "a.jpg");
    await writeFile(imagePath, Buffer.from([4, 5, 6]));
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ workdir: asAbsolutePath(tempDir) }),
      prompt: "review both",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath(imagePath),
          originalName: "a.jpg",
          uploadedAt: asTimestamp(1),
        },
        {
          kind: "file",
          localPath: asAbsolutePath(join(tempDir, "doc.pdf")),
          originalName: "doc.pdf",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    expect(command.stdin).toBeTruthy();
    const envelope = JSON.parse(command.stdin!.trim()) as {
      message: { content: Array<Record<string, unknown>> };
    };
    expect(envelope.message.content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "BAUG" },
    });
    const textBlock = envelope.message.content.at(-1) as { text: string };
    expect(textBlock.text).toContain("review both");
    expect(textBlock.text).toContain("用户附加了文件");
    expect(textBlock.text).toContain("doc.pdf");
    expect(textBlock.text).not.toContain("用户附加了图片");
  });

  describe("answerOnly mode (外部 non-owner)", () => {
    test("uses --permission-mode default instead of bypassPermissions", () => {
      const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi", answerOnly: true });
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("default");
      expect(args).not.toContain("bypassPermissions");
    });

    test("forces no-resume even when backendSessionId is set", () => {
      const args = buildClaudeArgs({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ backendSessionId: "bks-1" }),
        prompt: "hi",
        answerOnly: true,
      });
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("bks-1");
    });

    test("normal session still uses bypassPermissions", () => {
      const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("bypassPermissions");
    });

    test("normal session with backendSessionId still resumes", () => {
      const args = buildClaudeArgs({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ backendSessionId: "bks-2" }),
        prompt: "hi",
      });
      const resumeIdx = args.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(args[resumeIdx + 1]).toBe("bks-2");
    });

    test("answerOnly still includes model, output-format, replay flag, and stdin prompt", () => {
      const command = buildClaudeCommand({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "claude-sonnet-4-6" }),
        prompt: "hello world",
        answerOnly: true,
      });
      expect(command.args).toContain("-p");
      expect(command.args).toContain("stream-json");
      expect(command.args).toContain("--replay-user-messages");
      expect(command.args).toContain("--model");
      const modelIdx = command.args.indexOf("--model");
      expect(command.args[modelIdx + 1]).toBe("claude-sonnet-4-6");
      expect(stdinText(command.stdin)).toBe("hello world");
    });
  });

  test("effort is passed via --effort flag", () => {
    const args = buildClaudeArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ effort: "high" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--effort");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("high");
  });

  test("Claude Fable ultracode is passed via --effort", () => {
    const effort: Session["effort"] = "ultracode";
    const args = buildClaudeArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "claude-fable-5", effort }),
      prompt: "hi",
    });
    const idx = args.indexOf("--effort");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("ultracode");
  });

  test("ultracode is not passed to a non-Fable Claude model", () => {
    const effort: Session["effort"] = "ultracode";
    expect(() => buildClaudeArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "claude-opus-4-8", effort }),
      prompt: "hi",
    })).toThrow(/ultracode.*Fable/);
  });

  test("effort is omitted when null", () => {
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("--effort");
  });

  test("falls back to claude-opus-4-8 when session.model is null and env unset", () => {
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-opus-4-8");
  });

  test("uses SM_CLAUDE_DEFAULT_MODEL env when session.model is null", () => {
    process.env["SM_CLAUDE_DEFAULT_MODEL"] = "claude-sonnet-4-6";
    const args = buildClaudeArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-sonnet-4-6");
  });

  test("explicit session.model overrides env default", () => {
    process.env["SM_CLAUDE_DEFAULT_MODEL"] = "claude-sonnet-4-6";
    const args = buildClaudeArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "claude-haiku-4-5-20251001" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("file attachments are embedded in the stdin prompt text", () => {
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
      attachments: [
        {
          kind: "file",
          localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.pdf"),
          originalName: "a.pdf",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    const prompt = stdinText(command.stdin);
    expect(prompt).toContain("hi");
    expect(prompt).toContain(".attachments/a.pdf");
    expect(prompt).toContain("文件");
  });

  test("cardAskEnabled injects askserver MCP server with CHAT_ID", () => {
    process.env["BROKER_URL"] = "http://127.0.0.1:9999";
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "ask before acting",
      systemHint: "Use ask_user before taking irreversible action.",
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    });

    const mcpIdx = command.args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    const config = JSON.parse(command.args[mcpIdx + 1]) as {
      mcpServers: {
        askserver: { command: string; args: string[]; env: Record<string, string> };
      };
    };
    expect(config.mcpServers.askserver).toEqual({
      command: "node",
      args: [MCP_ASK_SERVER_PATH],
      env: {
        BROKER_URL: "http://127.0.0.1:9999",
        CHAT_ID: "oc_card_ask",
      },
    });
    const prompt = stdinText(command.stdin);
    expect(prompt).toContain("Use ask_user before taking irreversible action.");
    expect(prompt).toContain("ask before acting");
  });

  test("cardAskEnabled keeps the prompt out of argv so variadic --mcp-config needs no -- separator", () => {
    const command = buildClaudeCommand({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: null }),
      prompt: "ask before acting",
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    });

    expect(command.args.indexOf("--mcp-config")).toBeGreaterThanOrEqual(0);
    expect(command.args).not.toContain("--");
    expect(command.args).not.toContain("ask before acting");
    expect(stdinText(command.stdin)).toBe("ask before acting");
  });

  test("cardAskEnabled without CHAT_ID does not inject ask_user MCP server", () => {
    const args = buildClaudeArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "no chat",
      cardAskEnabled: true,
    });

    expect(args).not.toContain("--mcp-config");
  });
});
