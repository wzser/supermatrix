import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildCodexAppServerRunPlan,
  buildCodexArgs,
  resolveCodexExecutionModel,
  resolveCodexRunModel,
} from "../../../src/adapters/backend-codex/commandBuilder.ts";
import { buildCodexForkBootstrapArgs } from "../../../src/adapters/backend-codex/forkBootstrap.ts";
import { asMessageRunId, asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import {
  normalizeCodexReasoningEffortForCli,
  resetCodexModelCatalogForTests,
  setCodexEffectiveDefaultModel,
  setCodexModelCatalog,
  setCodexModelCatalogEntries,
} from "../../../src/ports/CodexModelCatalog.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../../src/ports/BackendRuntimeDefaults.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

const ORIGINAL_ENV_DEFAULT = process.env["SM_CODEX_DEFAULT_MODEL"];
const ORIGINAL_BROKER_URL = process.env["BROKER_URL"];
const MCP_ASK_SERVER_PATH =
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/larkc/card-callback/src/mcpAskServer.js";

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
    resetConfiguredBackendRuntimeDefaultsForTests();
    delete process.env["SM_CODEX_DEFAULT_MODEL"];
    delete process.env["BROKER_URL"];
    resetCodexModelCatalogForTests([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
    ]);
  });

  test("uses configured global defaults when session overrides are null", () => {
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.5", effort: "high" });
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).toContain("gpt-5.5");
    expect(args).toContain("model_reasoning_effort=high");
  });

  test("uses the frozen execution config after mutable global defaults change", () => {
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.6-sol", effort: "ultra" });
    const input = {
      session: mkSession(),
      prompt: "hi",
      execution: { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
    } as Parameters<typeof buildCodexArgs>[0] & {
      execution: { backend: "codex"; model: string; effort: "ultra" };
    };
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.5", effort: "high" });

    const args = buildCodexArgs(input);

    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(args).toContain("model_reasoning_effort=ultra");
  });

  afterEach(() => {
    if (ORIGINAL_ENV_DEFAULT === undefined) {
      delete process.env["SM_CODEX_DEFAULT_MODEL"];
    } else {
      process.env["SM_CODEX_DEFAULT_MODEL"] = ORIGINAL_ENV_DEFAULT;
    }
    if (ORIGINAL_BROKER_URL === undefined) {
      delete process.env["BROKER_URL"];
    } else {
      process.env["BROKER_URL"] = ORIGINAL_BROKER_URL;
    }
    resetCodexModelCatalogForTests();
  });

  test("first run omits resume subcommand", () => {
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).toContain("--json");
    expect(args).toContain("--cd");
    expect(args).toContain("/tmp/ws/foo");
    expect(args).toContain("hi");
  });

  test("resume run includes resume <id> subcommand", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "bks-1" }),
      prompt: "continue",
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("bks-1");
    expect(args).toContain("--json");
    expect(args).toContain("continue");
  });

  test("fork mode fails closed until a JSON-capable fork path exists", () => {
    expect(() =>
      buildCodexArgs({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ backendSessionId: null }),
        prompt: "branch prompt",
        conversationFork: { sourceBackendSessionId: "bks-source" },
      }),
    ).toThrow(/Codex fork is not available in non-interactive JSON mode/u);
  });

  test("effort is passed via -c model_reasoning_effort config override", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ effort: "high" }),
      prompt: "hi",
    });
    const idx = args.indexOf("-c");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("model_reasoning_effort=high");
  });

  test("ultracode never reaches the Codex argv", () => {
    const effort: Session["effort"] = "ultracode";
    expect(() => buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.6-sol", effort }),
      prompt: "hi",
    })).toThrow(/Codex.*ultracode/);
  });

  test("effort max is passed through without legacy xhigh mapping", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ effort: "max" }),
      prompt: "hi",
    });
    expect(args).toContain("model_reasoning_effort=max");
    expect(args).not.toContain("model_reasoning_effort=xhigh");
  });

  test("reports structured evidence when legacy effort normalization changes persisted input", () => {
    const evidence: unknown[] = [];
    const args = buildCodexArgs(
      { messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ model: "gpt-5.4", effort: "ultra" }), prompt: "hi" },
      { onEffortNormalized: (entry) => evidence.push(entry) },
    );
    expect(args).toContain("model_reasoning_effort=xhigh");
    expect(evidence).toEqual([{
      kind: "codex_effort_normalized",
      model: "gpt-5.4",
      persistedEffort: "ultra",
      cliEffort: "xhigh",
    }]);
  });

  test("effort is omitted when null", () => {
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).not.toContain("-c");
  });

  test("sandbox bypass flag is present for normal sessions", () => {
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  describe("answerOnly mode (外部 non-owner)", () => {
    test("omits --dangerously-bypass-approvals-and-sandbox", () => {
      const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi", answerOnly: true });
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    test("adds --sandbox read-only --ephemeral instead", () => {
      const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi", answerOnly: true });
      const sandboxIdx = args.indexOf("--sandbox");
      expect(sandboxIdx).toBeGreaterThanOrEqual(0);
      expect(args[sandboxIdx + 1]).toBe("read-only");
      expect(args).toContain("--ephemeral");
    });

    test("forces no-resume even when backendSessionId is set", () => {
      const args = buildCodexArgs({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ backendSessionId: "bks-existing" }),
        prompt: "hi",
        answerOnly: true,
      });
      expect(args).not.toContain("resume");
      expect(args).not.toContain("bks-existing");
    });

    test("includes --cd for workdir (first-run shape, no persistent session)", () => {
      const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi", answerOnly: true });
      expect(args).toContain("--cd");
      expect(args).toContain("/tmp/ws/foo");
    });

    test("normal session with backendSessionId still resumes", () => {
      const args = buildCodexArgs({
        messageRunId: TEST_MESSAGE_RUN_ID,
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
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5-codex" }),
      prompt: "hi",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5-codex");
  });

  test("model is passed via --model flag on resume run", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.4", backendSessionId: "bks-1" }),
      prompt: "continue",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("gpt-5.4");
  });

  test("pins session.model=null to the verified effective default for first run", () => {
    setCodexModelCatalog(["first", "verified"], "test");
    setCodexEffectiveDefaultModel("verified");
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("verified");
  });

  test("pins session.model=null to the verified effective default for resume run", () => {
    setCodexModelCatalog(["first", "verified"], "test");
    setCodexEffectiveDefaultModel("verified");
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ backendSessionId: "bks-1" }),
      prompt: "continue",
    });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("verified");
  });

  test("pins session.model=null to the verified effective default for answer-only run", () => {
    setCodexModelCatalog(["first", "verified"], "test");
    setCodexEffectiveDefaultModel("verified");
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession(), prompt: "hi", answerOnly: true });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("verified");
  });

  test("resolves a whitespace-only session.model as the verified default", () => {
    setCodexModelCatalog(["first", "verified"], "test");
    setCodexEffectiveDefaultModel("verified");
    const args = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ model: "   " }), prompt: "hi" });
    expect(args[args.indexOf("--model") + 1]).toBe("verified");
  });

  test("resolveCodexRunModel keeps persisted null as null for storage semantics", () => {
    expect(resolveCodexRunModel(null)).toBeNull();
    expect(resolveCodexRunModel(undefined)).toBeNull();
    expect(resolveCodexRunModel("   ")).toBeNull();
    expect(resolveCodexRunModel("gpt-5.4")).toBe("gpt-5.4");
  });

  test("image attachments become --image flags and stay out of prompt hints", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
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
      messageRunId: TEST_MESSAGE_RUN_ID,
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
      messageRunId: TEST_MESSAGE_RUN_ID,
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

  test("cardAskEnabled injects askserver MCP server with CHAT_ID and 360s tool timeout", () => {
    process.env["BROKER_URL"] = "http://127.0.0.1:9999";
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "ask before acting",
      systemHint: "Use ask_user before taking irreversible action.",
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    });

    expect(args).toContain(`mcp_servers.askserver.command="node"`);
    expect(args).toContain(`mcp_servers.askserver.args=["${MCP_ASK_SERVER_PATH}"]`);
    expect(args).toContain(
      `mcp_servers.askserver.env={BROKER_URL="http://127.0.0.1:9999",CHAT_ID="oc_card_ask"}`,
    );
    expect(args).toContain("mcp_servers.askserver.tool_timeout_sec=360");
    expect(args.at(-1)).toContain("Use ask_user before taking irreversible action.");
    expect(args.at(-1)).toContain("ask before acting");
  });

  test("cardAskEnabled without CHAT_ID does not inject ask_user MCP server", () => {
    const args = buildCodexArgs({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "no chat",
      cardAskEnabled: true,
    });

    expect(args.some((arg) => arg.includes("mcp_servers.askserver"))).toBe(false);
  });

  test("regression: promoted verified default is the actual execution model and effort clamps against it", () => {
    // Simulate boot reconciliation promoting the catalog head from "first" to
    // the verified available default "verified".
    setCodexModelCatalogEntries([
      { slug: "first", supportedEfforts: ["low", "medium", "high"] },
      { slug: "verified", supportedEfforts: ["low", "medium"] },
    ], "test");
    setCodexEffectiveDefaultModel("verified");

    expect(resolveCodexRunModel(null)).toBeNull();
    expect(resolveCodexExecutionModel(null)).toBe("verified");
    // "high" is unsupported by "verified" (only low/medium), so it clamps to "medium".
    expect(normalizeCodexReasoningEffortForCli("high", "verified")).toBe("medium");

    const normalArgs = buildCodexArgs({ messageRunId: TEST_MESSAGE_RUN_ID, session: mkSession({ effort: "high" }), prompt: "hi" });
    const forkArgs = buildCodexForkBootstrapArgs({
      sourceBackendSessionId: "source-1",
      sessionName: "test4",
      branchName: "plan-a",
      workdir: asAbsolutePath("/tmp/ws/test4"),
      model: null,
      effort: "high",
    });

    expect(normalArgs[normalArgs.indexOf("--model") + 1]).toBe("verified");
    expect(forkArgs[forkArgs.indexOf("--model") + 1]).toBe("verified");

    // The clamp must reach the actual CLI argv (both paths), not just the helper.
    expect(normalArgs).toContain("model_reasoning_effort=medium");
    expect(normalArgs).not.toContain("model_reasoning_effort=high");
    expect(forkArgs).toContain("model_reasoning_effort=medium");
    expect(forkArgs).not.toContain("model_reasoning_effort=high");
  });
});

describe("buildCodexAppServerRunPlan", () => {
  beforeEach(() => {
    resetConfiguredBackendRuntimeDefaultsForTests();
    delete process.env["SM_CODEX_DEFAULT_MODEL"];
    delete process.env["BROKER_URL"];
    resetCodexModelCatalogForTests([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-5.4",
    ]);
  });

  afterEach(() => {
    if (ORIGINAL_ENV_DEFAULT === undefined) delete process.env["SM_CODEX_DEFAULT_MODEL"];
    else process.env["SM_CODEX_DEFAULT_MODEL"] = ORIGINAL_ENV_DEFAULT;
    if (ORIGINAL_BROKER_URL === undefined) delete process.env["BROKER_URL"];
    else process.env["BROKER_URL"] = ORIGINAL_BROKER_URL;
    resetCodexModelCatalogForTests();
  });

  test("fresh owner run: stdio app-server argv, cwd+model thread params, full-access sandbox", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5", effort: "high" }),
      prompt: "hi",
    });
    expect(plan.appServerArgs).toEqual(["app-server", "--listen", "stdio://"]);
    expect(plan.resumeThreadId).toBeNull();
    expect(plan.threadParams).toEqual({
      cwd: "/tmp/ws/foo",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(plan.turnEffort).toBe("high");
    expect(plan.model).toBe("gpt-5.5");
    expect(plan.turnInput).toEqual([{ type: "text", text: "hi" }]);
  });

  test("resume run: thread/resume params keep the persisted id and omit cwd", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5", backendSessionId: "thread-42" }),
      prompt: "hi",
    });
    expect(plan.resumeThreadId).toBe("thread-42");
    expect(plan.threadParams).toEqual({
      threadId: "thread-42",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  test("answer-only run: read-only ephemeral thread and no resume continuity", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5", backendSessionId: "thread-42" }),
      prompt: "hi",
      answerOnly: true,
    });
    expect(plan.resumeThreadId).toBeNull();
    expect(plan.threadParams).toEqual({
      cwd: "/tmp/ws/foo",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
  });

  test("normalizes effort against the execution model and reports the evidence", () => {
    const observed: unknown[] = [];
    const plan = buildCodexAppServerRunPlan(
      {
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.4", effort: "ultra" }),
        prompt: "hi",
      },
      { onEffortNormalized: (evidence) => observed.push(evidence) },
    );
    expect(plan.turnEffort).toBe("xhigh");
    expect(observed).toEqual([{
      kind: "codex_effort_normalized",
      model: "gpt-5.4",
      persistedEffort: "ultra",
      cliEffort: "xhigh",
    }]);
  });

  test("falls back to the verified default model when the session model is null", () => {
    setCodexEffectiveDefaultModel("gpt-5.4");
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession(),
      prompt: "hi",
    });
    expect(plan.model).toBe("gpt-5.4");
    expect(plan.threadParams["model"]).toBe("gpt-5.4");
    expect(plan.turnEffort).toBeNull();
  });

  test("card-ask config rides the app-server argv with the same -c overrides as exec", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5" }),
      prompt: "hi",
      cardAskEnabled: true,
      cardAskChatId: "oc_chat_1",
    });
    expect(plan.appServerArgs.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(plan.appServerArgs).toContain("mcp_servers.askserver.command=\"node\"");
    expect(plan.appServerArgs.join(" ")).toContain("CHAT_ID=\"oc_chat_1\"");
  });

  test("image attachments become localImage inputs; file attachments stay in the prompt", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5" }),
      prompt: "hi",
      attachments: [
        {
          kind: "image",
          localPath: asAbsolutePath("/tmp/ws/foo/pic.png"),
          originalName: "pic.png",
          uploadedAt: asTimestamp(1),
        },
        {
          kind: "file",
          localPath: asAbsolutePath("/tmp/ws/foo/data.csv"),
          originalName: "data.csv",
          uploadedAt: asTimestamp(1),
        },
      ],
    });
    expect(plan.turnInput).toHaveLength(2);
    expect(plan.turnInput[0]?.type).toBe("text");
    expect(plan.turnInput[0]?.type === "text" ? plan.turnInput[0].text : "").toContain("data.csv");
    expect(plan.turnInput[1]).toEqual({ type: "localImage", path: "/tmp/ws/foo/pic.png" });
  });

  test("system hint is prepended to the turn text like the exec prompt path", () => {
    const plan = buildCodexAppServerRunPlan({
      messageRunId: TEST_MESSAGE_RUN_ID,
      session: mkSession({ model: "gpt-5.5" }),
      prompt: "hi",
      systemHint: "be brief",
    });
    expect(plan.turnInput[0]?.type === "text" ? plan.turnInput[0].text : "").toContain("be brief");
  });

  test("conversation fork is rejected: fork stays on its dedicated bootstrap path", () => {
    expect(() =>
      buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.5" }),
        prompt: "hi",
        conversationFork: { sourceBackendSessionId: "src-1" },
      }),
    ).toThrow(/fork/u);
  });

  describe("sm-switch route-state resolution", () => {
    const ORIGINAL_ROUTE_STATE_PATH = process.env["SM_CODEX_ROUTE_STATE_PATH"];
    let routeDir: string;

    beforeEach(() => {
      routeDir = mkdtempSync(join(tmpdir(), "sm-route-plan-"));
    });

    afterEach(() => {
      rmSync(routeDir, { recursive: true, force: true });
      if (ORIGINAL_ROUTE_STATE_PATH === undefined) {
        delete process.env["SM_CODEX_ROUTE_STATE_PATH"];
      } else {
        process.env["SM_CODEX_ROUTE_STATE_PATH"] = ORIGINAL_ROUTE_STATE_PATH;
      }
    });

    function activateDeepseekRoute(overrides: Record<string, unknown> = {}): void {
      const path = join(routeDir, "route-state.json");
      writeFileSync(path, JSON.stringify({
        contractVersion: "sm-switch.route-state/v1",
        backend: "codex",
        route: "deepseek",
        defaultModel: "deepseek-v4-flash",
        servedModels: ["deepseek-v4-flash"],
        activatedAt: "2026-08-06T12:00:00+08:00",
        proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
        ...overrides,
      }));
      process.env["SM_CODEX_ROUTE_STATE_PATH"] = path;
    }

    function activateOpenAiRoute(overrides: Record<string, unknown> = {}): void {
      const path = join(routeDir, "route-state.json");
      writeFileSync(path, JSON.stringify({
        contractVersion: "sm-switch.route-state/v1",
        backend: "codex",
        route: "openai",
        defaultModel: "gpt-5.6-sol",
        servedModels: [],
        activatedAt: "2026-08-06T12:00:00.000Z",
        proxy: null,
        ...overrides,
      }));
      process.env["SM_CODEX_ROUTE_STATE_PATH"] = path;
    }

    test("resumes a persisted thread regardless of the route activation boundary", () => {
      const activatedAt = "2026-08-06T12:00:00.000Z";
      activateOpenAiRoute({ activatedAt });

      const plan = buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({
          backendSessionId: "thread-from-deepseek",
          updatedAt: asTimestamp(Date.parse(activatedAt) - 1),
        }),
        prompt: "continue",
      });

      expect(plan.resumeThreadId).toBe("thread-from-deepseek");
      expect(plan.threadParams).toMatchObject({ threadId: "thread-from-deepseek" });
    });

    test("deepseek route pins plan.model and thread params to defaultModel, effort passes through", () => {
      activateDeepseekRoute();
      const plan = buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.6-sol", effort: "high" }),
        prompt: "hi",
      });
      expect(plan.model).toBe("deepseek-v4-flash");
      expect(plan.threadParams["model"]).toBe("deepseek-v4-flash");
      expect(plan.turnEffort).toBe("high");
    });

    test("deepseek route keeps an explicitly requested served model", () => {
      activateDeepseekRoute({ servedModels: ["deepseek-v4-flash", "deepseek-v4"] });
      const plan = buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.5" }),
        prompt: "hi",
        execution: { backend: "codex", model: "deepseek-v4", effort: null },
      } as Parameters<typeof buildCodexAppServerRunPlan>[0]);
      expect(plan.model).toBe("deepseek-v4");
    });

    test("missing route-state file fails open to the requested model", () => {
      process.env["SM_CODEX_ROUTE_STATE_PATH"] = join(routeDir, "absent.json");
      const plan = buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.6-sol" }),
        prompt: "hi",
      });
      expect(plan.model).toBe("gpt-5.6-sol");
    });

    test("unknown contract version fails open to the requested model", () => {
      activateDeepseekRoute({ contractVersion: "sm-switch.route-state/v9" });
      const plan = buildCodexAppServerRunPlan({
        messageRunId: TEST_MESSAGE_RUN_ID,
        session: mkSession({ model: "gpt-5.6-sol" }),
        prompt: "hi",
      });
      expect(plan.model).toBe("gpt-5.6-sol");
    });

    test("effort-normalization evidence reports the requested model, not the routed one", () => {
      activateDeepseekRoute();
      const observed: unknown[] = [];
      buildCodexAppServerRunPlan(
        {
          messageRunId: TEST_MESSAGE_RUN_ID,
          session: mkSession({ model: "gpt-5.4", effort: "ultra" }),
          prompt: "hi",
        },
        { onEffortNormalized: (evidence) => observed.push(evidence) },
      );
      expect(observed).toEqual([{
        kind: "codex_effort_normalized",
        model: "gpt-5.4",
        persistedEffort: "ultra",
        cliEffort: "xhigh",
      }]);
    });
  });
});
