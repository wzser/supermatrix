import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildClaudeArgs,
  buildClaudeCommand,
} from "../../../src/adapters/backend-claude/commandBuilder.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

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

describe("buildClaudeArgs", () => {
  const ORIGINAL_ENV_DEFAULT = process.env["SM_CLAUDE_DEFAULT_MODEL"];
  const ORIGINAL_NATIVE_IMAGE = process.env["SM_CLAUDE_NATIVE_IMAGE"];
  let tempDir: string | undefined;

  beforeEach(() => {
    delete process.env["SM_CLAUDE_DEFAULT_MODEL"];
    delete process.env["SM_CLAUDE_NATIVE_IMAGE"];
  });
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
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("first run includes -p, stream-json, and the prompt but omits --resume", () => {
    const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).not.toContain("--resume");
    // prompt is the trailing positional
    expect(args[args.length - 1]).toBe("hi");
  });

  test("first run does not include --cwd (claude has no such flag)", () => {
    const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("--cwd");
  });

  test("resume run includes --resume <id> before the prompt", () => {
    const args = buildClaudeArgs({
      session: mkSession({ backendSessionId: "bks-1" }),
      prompt: "hi",
    });
    const resumeIdx = args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe("bks-1");
    expect(args[args.length - 1]).toBe("hi");
  });

  test("image attachments become stream-json stdin image content blocks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "supermatrix-claude-image-"));
    const imagePath = join(tempDir, "a.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    const command = buildClaudeCommand({
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
    const args = buildClaudeArgs({
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
    const prompt = args[args.length - 1];
    expect(prompt).toContain("hi");
    expect(prompt).toContain(".attachments/a.png");
    expect(prompt).toContain("图片");
  });

  test("mixed native images and files keep file hints in the stream-json text block", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "supermatrix-claude-mixed-"));
    const imagePath = join(tempDir, "a.jpg");
    await writeFile(imagePath, Buffer.from([4, 5, 6]));
    const command = buildClaudeCommand({
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
      const args = buildClaudeArgs({ session: mkSession(), prompt: "hi", answerOnly: true });
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("default");
      expect(args).not.toContain("bypassPermissions");
    });

    test("forces no-resume even when backendSessionId is set", () => {
      const args = buildClaudeArgs({
        session: mkSession({ backendSessionId: "bks-1" }),
        prompt: "hi",
        answerOnly: true,
      });
      expect(args).not.toContain("--resume");
      expect(args).not.toContain("bks-1");
    });

    test("normal session still uses bypassPermissions", () => {
      const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
      const idx = args.indexOf("--permission-mode");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("bypassPermissions");
    });

    test("normal session with backendSessionId still resumes", () => {
      const args = buildClaudeArgs({
        session: mkSession({ backendSessionId: "bks-2" }),
        prompt: "hi",
      });
      const resumeIdx = args.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(args[resumeIdx + 1]).toBe("bks-2");
    });

    test("answerOnly still includes model, output-format, and prompt", () => {
      const args = buildClaudeArgs({
        session: mkSession({ model: "claude-sonnet-4-6" }),
        prompt: "hello world",
        answerOnly: true,
      });
      expect(args).toContain("-p");
      expect(args).toContain("stream-json");
      expect(args).toContain("--model");
      const modelIdx = args.indexOf("--model");
      expect(args[modelIdx + 1]).toBe("claude-sonnet-4-6");
      expect(args[args.length - 1]).toBe("hello world");
    });
  });

  test("effort is passed via --effort flag", () => {
    const args = buildClaudeArgs({
      session: mkSession({ effort: "high" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--effort");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("high");
  });

  test("effort is omitted when null", () => {
    const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("--effort");
  });

  test("falls back to claude-opus-4-7 when session.model is null and env unset", () => {
    const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-opus-4-7");
  });

  test("uses SM_CLAUDE_DEFAULT_MODEL env when session.model is null", () => {
    process.env["SM_CLAUDE_DEFAULT_MODEL"] = "claude-sonnet-4-6";
    const args = buildClaudeArgs({ session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-sonnet-4-6");
  });

  test("explicit session.model overrides env default", () => {
    process.env["SM_CLAUDE_DEFAULT_MODEL"] = "claude-sonnet-4-6";
    const args = buildClaudeArgs({
      session: mkSession({ model: "claude-haiku-4-5-20251001" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("claude-haiku-4-5-20251001");
  });

  test("file attachments are embedded in the prompt text", () => {
    const args = buildClaudeArgs({
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
    const prompt = args[args.length - 1];
    expect(prompt).toContain("hi");
    expect(prompt).toContain(".attachments/a.pdf");
    expect(prompt).toContain("文件");
  });
});
