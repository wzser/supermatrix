import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildCodexArgs } from "../../../src/adapters/backend-codex/commandBuilder.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

const ORIGINAL_ENV_DEFAULT = process.env["SM_CODEX_DEFAULT_MODEL"];

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "codex",
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

describe("buildCodexArgs", () => {
  beforeEach(() => {
    delete process.env["SM_CODEX_DEFAULT_MODEL"];
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  afterEach(() => {
    if (ORIGINAL_ENV_DEFAULT === undefined) {
      delete process.env["SM_CODEX_DEFAULT_MODEL"];
    } else {
      process.env["SM_CODEX_DEFAULT_MODEL"] = ORIGINAL_ENV_DEFAULT;
    }
    resetCodexModelCatalogForTests();
  });

  test("first run omits resume subcommand", () => {
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).toContain("--json");
    expect(args).toContain("--cd");
    expect(args).toContain("/tmp/ws/foo");
    expect(args).toContain("hi");
  });

  test("resume run includes resume <id> subcommand", () => {
    const args = buildCodexArgs({
      session: mkSession({ backendSessionId: "bks-1" }),
      prompt: "continue",
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("bks-1");
    expect(args).toContain("--json");
    expect(args).toContain("continue");
  });

  test("effort is passed via -c model_reasoning_effort config override", () => {
    const args = buildCodexArgs({
      session: mkSession({ effort: "high" }),
      prompt: "hi",
    });
    const idx = args.indexOf("-c");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("model_reasoning_effort=high");
  });

  test("effort max maps to xhigh", () => {
    const args = buildCodexArgs({
      session: mkSession({ effort: "max" }),
      prompt: "hi",
    });
    expect(args).toContain("model_reasoning_effort=xhigh");
  });

  test("effort is omitted when null", () => {
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("-c");
  });

  test("sandbox bypass flag is present for normal sessions", () => {
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  describe("answerOnly mode (外部 non-owner)", () => {
    test("omits --dangerously-bypass-approvals-and-sandbox", () => {
      const args = buildCodexArgs({ session: mkSession(), prompt: "hi", answerOnly: true });
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    test("adds --sandbox read-only --ephemeral instead", () => {
      const args = buildCodexArgs({ session: mkSession(), prompt: "hi", answerOnly: true });
      const sandboxIdx = args.indexOf("--sandbox");
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(args[sandboxIdx + 1]).toBe("read-only");
      expect(args).toContain("--ephemeral");
    });

    test("forces no-resume even when backendSessionId is set", () => {
      const args = buildCodexArgs({
        session: mkSession({ backendSessionId: "bks-existing" }),
        prompt: "hi",
        answerOnly: true,
      });
      expect(args).not.toContain("resume");
      expect(args).not.toContain("bks-existing");
    });

    test("includes --cd for workdir (first-run shape, no persistent session)", () => {
      const args = buildCodexArgs({ session: mkSession(), prompt: "hi", answerOnly: true });
      expect(args).toContain("--cd");
      expect(args).toContain("/tmp/ws/foo");
    });

    test("normal session with backendSessionId still resumes", () => {
      const args = buildCodexArgs({
        session: mkSession({ backendSessionId: "bks-1" }),
        prompt: "continue",
      });
      expect(args).toContain("resume");
      expect(args).toContain("bks-1");
      expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    });
  });

  test("model is passed via --model flag on first run", () => {
    const args = buildCodexArgs({
      session: mkSession({ model: "gpt-5-codex" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5-codex");
  });

  test("model is passed via --model flag on resume run", () => {
    const args = buildCodexArgs({
      session: mkSession({ model: "gpt-5.4", backendSessionId: "bks-1" }),
      prompt: "continue",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5.4");
  });

  test("uses the first catalog model as the framework default when session.model is null", () => {
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5.5");
  });

  test("uses SM_CODEX_DEFAULT_MODEL env only when it is in the current catalog", () => {
    process.env["SM_CODEX_DEFAULT_MODEL"] = "gpt-5.3-codex";
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5.3-codex");
  });

  test("ignores SM_CODEX_DEFAULT_MODEL env when it is outside the current catalog", () => {
    process.env["SM_CODEX_DEFAULT_MODEL"] = "gpt-5.3";
    const args = buildCodexArgs({ session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5.5");
  });

  test("image attachments become --image flags and stay out of prompt hints", () => {
    const args = buildCodexArgs({
      session: mkSession(),
      prompt: "describe it",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.png"),
          originalName: "a.png",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    const imageIdx = args.indexOf("--image");
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    expect(args[imageIdx + 1]).toBe("/tmp/ws/foo/.attachments/a.png");
    expect(args.at(-2)).toBe("--");
    const prompt = args.at(-1);
    expect(prompt).toBe("describe it");
  });

  test("image attachments terminate option parsing before the prompt", () => {
    const args = buildCodexArgs({
      session: mkSession(),
      prompt: "describe it",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.png"),
          originalName: "a.png",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("describe it");
  });

  test("file attachments still append Read prompt hints", () => {
    const args = buildCodexArgs({
      session: mkSession(),
      prompt: "summarize",
      attachments: [
        {
          kind: "file",
          localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.pdf"),
          originalName: "a.pdf",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    expect(args).not.toContain("--image");
    const prompt = args.at(-1);
    expect(prompt).toContain("summarize");
    expect(prompt).toContain("用户附加了文件");
    expect(prompt).toContain("a.pdf");
  });
});
