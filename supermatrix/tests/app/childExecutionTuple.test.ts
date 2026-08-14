import { describe, expect, test } from "vitest";
import {
  resolveChildRequestedTuple,
  resolveMainSession,
} from "../../src/app/childExecutionTuple.ts";
import { asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ChildSessionDefaults } from "../../src/ports/ChildSessionDefaults.ts";

function mkDefaults(
  overrides: Partial<ChildSessionDefaults> = {},
): ChildSessionDefaults {
  return {
    backend: { configured: false, value: null },
    model: { configured: false, value: null },
    effort: { configured: false, value: null },
    updatedAt: null,
    ...overrides,
  };
}

const CLAUDE_MAIN = { backend: "claude", model: "claude-opus-4-7", effort: "high" } as const;

describe("resolveChildRequestedTuple", () => {
  test("no override, no defaults → inherits the main session tuple (same backend)", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults(),
      override: undefined,
      main: CLAUDE_MAIN,
    });
    expect(tuple).toMatchObject({
      backend: "claude",
      model: "claude-opus-4-7",
      effort: "high",
      modelSource: "fallback",
      effortSource: "fallback",
    });
  });

  test("configured child defaults win over the main session fallback", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults({
        backend: { configured: true, value: "kimi" },
        model: { configured: true, value: "kimi-code/k3" },
        effort: { configured: true, value: "low" },
      }),
      override: undefined,
      main: CLAUDE_MAIN,
    });
    expect(tuple).toMatchObject({
      backend: "kimi",
      model: "kimi-code/k3",
      effort: "low",
      modelSource: "defaults",
      effortSource: "defaults",
    });
  });

  test("an override backend different from the configured one suspends the configured model/effort", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults({
        backend: { configured: true, value: "codex" },
        model: { configured: true, value: "gpt-5.5" },
        effort: { configured: true, value: "xhigh" },
      }),
      override: { backend: "kimi" },
      main: CLAUDE_MAIN,
    });
    // Cross-backend: no inheritance from the claude main session either.
    expect(tuple).toMatchObject({
      backend: "kimi",
      model: null,
      effort: null,
      modelSource: "fallback",
      effortSource: "fallback",
    });
  });

  test("an explicit override model/effort wins and is marked as override-sourced", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults({
        backend: { configured: true, value: "kimi" },
        model: { configured: true, value: "kimi-code/kimi-for-coding" },
        effort: { configured: true, value: "low" },
      }),
      override: { model: "kimi-code/k3", effort: "max" },
      main: CLAUDE_MAIN,
    });
    expect(tuple).toMatchObject({
      backend: "kimi",
      model: "kimi-code/k3",
      effort: "max",
      modelSource: "override",
      effortSource: "override",
    });
  });

  test("explicit null override clears the field (source stays override)", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults({
        backend: { configured: true, value: "kimi" },
        model: { configured: true, value: "kimi-code/k3" },
      }),
      override: { model: null },
      main: CLAUDE_MAIN,
    });
    expect(tuple).toMatchObject({ model: null, modelSource: "override" });
  });

  test("cross-backend child does not inherit the main session model/effort", () => {
    const tuple = resolveChildRequestedTuple({
      defaults: mkDefaults(),
      override: { backend: "kimi" },
      main: CLAUDE_MAIN,
    });
    expect(tuple.model).toBeNull();
    expect(tuple.effort).toBeNull();
  });
});

describe("resolveMainSession", () => {
  function mkSession(overrides: Partial<Session>): Session {
    return {
      id: asSessionId("sess_x"),
      name: "x",
      alias: "",
      avatar: "",
      category: "",
      fpManaged: null,
      scope: "user",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: "/tmp" as Session["workdir"],
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

  test("a top-level session is its own main session", async () => {
    const session = mkSession({ id: asSessionId("sess_main") });
    const store = { findSessionById: async () => null };
    expect(await resolveMainSession(store, session)).toBe(session);
  });

  test("walks child → parent → top-level main session", async () => {
    const main = mkSession({ id: asSessionId("sess_main"), name: "main" });
    const child = mkSession({
      id: asSessionId("sess_child"),
      scope: "child",
      parentId: main.id,
    });
    const store = {
      findSessionById: async (id: Session["id"]) => (id === main.id ? main : null),
    };
    expect((await resolveMainSession(store, child)).id).toBe(main.id);
  });
});
