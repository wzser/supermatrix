import { describe, expect, test } from "vitest";
import { buildSessionCatalog } from "../../src/domain/sessionCatalog.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";

function mkSession(name: string, overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_" + name),
    name,
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
    workdir: asAbsolutePath("/ws/" + name),
    backendSessionId: null,
    chatName: null,
    purpose: "p-" + name,
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

describe("buildSessionCatalog", () => {
  test("renders generated_at as ISO string", () => {
    const catalog = buildSessionCatalog([], asTimestamp(1_700_000_000_000));
    expect(catalog.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(catalog.sessions).toEqual([]);
  });

  test("maps each session to a flat catalog entry", () => {
    const codexroot = mkSession("codexroot", {
      alias: "T800",
      backend: "codex",
      category: "平台",
      status: "busy",
      fpManaged: true,
      purpose: "一句话定位。\n【做什么】\n- 维护 X",
    });
    const catalog = buildSessionCatalog([codexroot], asTimestamp(1));
    expect(catalog.sessions).toEqual([
      {
        name: "codexroot",
        alias: "T800",
        backend: "codex",
        category: "平台",
        status: "busy",
        fp_managed: true,
        capability: "一句话定位。\n【做什么】\n- 维护 X",
      },
    ]);
  });

  test("sorts entries by name for deterministic output", () => {
    const out = buildSessionCatalog(
      [mkSession("zeta"), mkSession("alpha"), mkSession("mid")],
      asTimestamp(1),
    );
    expect(out.sessions.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  test("excludes child sessions", () => {
    const out = buildSessionCatalog(
      [mkSession("real"), mkSession("child_x_123", { scope: "child" })],
      asTimestamp(1),
    );
    expect(out.sessions.map((s) => s.name)).toEqual(["real"]);
  });

  test("excludes deleted sessions", () => {
    const out = buildSessionCatalog(
      [mkSession("live"), mkSession("gone", { status: "deleted" })],
      asTimestamp(1),
    );
    expect(out.sessions.map((s) => s.name)).toEqual(["live"]);
  });

  test("excludes fpManaged=false sessions, keeps true and null", () => {
    const out = buildSessionCatalog(
      [
        mkSession("nullmgd", { fpManaged: null }),
        mkSession("truemgd", { fpManaged: true }),
        mkSession("excluded", { fpManaged: false }),
      ],
      asTimestamp(1),
    );
    expect(out.sessions.map((s) => s.name)).toEqual(["nullmgd", "truemgd"]);
    expect(out.sessions.find((s) => s.name === "nullmgd")!.fp_managed).toBeNull();
    expect(out.sessions.find((s) => s.name === "truemgd")!.fp_managed).toBe(true);
  });
});
