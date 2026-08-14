import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createSetModelHandler,
  resolveAndValidateModel,
  resolveModelAlias,
} from "../../../src/app/commands/setModel.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

beforeEach(() => resetCodexModelCatalogForTests());

function makeMsg(groupId: string, text: string) {
  return { groupId: asLarkGroupId(groupId), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
}

function seed(store: ReturnType<typeof createFakeBindingStore>, id: string, name: string, backend: "claude" | "codex" | "kimi", extra: Partial<Session> = {}) {
  store.seedSession({
    id: asSessionId(id), name, alias: "", avatar: "", category: "", fpManaged: null,
    scope: "user", backend, model: "gpt-5.4", effort: "high", thinking: false, modelLocked: false,
    workdir: asAbsolutePath(`/ws/${name}`), backendSessionId: "resume-a", chatName: null, purpose: "",
    status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null,
    childType: null, triggerKind: null, postIdentity: null, callerInvocation: null,
    continuationHook: null, capabilityPayload: null, createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...extra,
  });
}

describe("resolveModelAlias — Codex short aliases", () => {
  test("sol/terra/luna and numeric aliases resolve to catalog ids", () => {
    expect(resolveAndValidateModel("sol", "codex")).toBe("gpt-5.6-sol");
    expect(resolveAndValidateModel("terra", "codex")).toBe("gpt-5.6-terra");
    expect(resolveAndValidateModel("luna", "codex")).toBe("gpt-5.6-luna");
    expect(resolveAndValidateModel("5.6-sol", "codex")).toBe("gpt-5.6-sol");
    expect(resolveAndValidateModel("5.5", "codex")).toBe("gpt-5.5");
  });
});

describe("resolveAndValidateModel — canonical ids fold case (NFKC), then catalog-validate", () => {
  test("mixed-case canonical ids resolve via the catalog (canonicalized key, not raw input)", () => {
    expect(resolveAndValidateModel("GPT-5.5", "codex")).toBe("gpt-5.5");
    expect(resolveAndValidateModel("GPT-5.6-TERRA", "codex")).toBe("gpt-5.6-terra");
    expect(resolveAndValidateModel("CLAUDE-OPUS-5", "claude")).toBe("claude-opus-5");
    expect(resolveAndValidateModel("CLAUDE-SONNET-5", "claude")).toBe("claude-sonnet-5");
    expect(resolveAndValidateModel("CLAUDE-OPUS-4-8", "claude")).toBe("claude-opus-4-8");
  });

  test("a genuine unknown still fails catalog validation", () => {
    expect(() => resolveAndValidateModel("gpt-9.9-nope", "codex")).toThrow(UserError);
    expect(() => resolveAndValidateModel("claude-imaginary", "claude")).toThrow(
      /opus=claude-opus-5，sonnet=claude-sonnet-5/u,
    );
  });
});

describe("resolveModelAlias — Codex 5.4 deprecation", () => {
  const terraTokens = ["gpt5.4", "5.4", "gpt-5.4"];
  const lunaTokens = ["gpt5.4-mini", "5.4-mini", "mini", "gpt-5.4-mini"];

  for (const token of terraTokens) {
    test(`${token} rejects without rewriting and points to Terra`, () => {
      expect(() => resolveAndValidateModel(token, "codex")).toThrow(
        /successor: Terra \(gpt-5\.6-terra\)/u,
      );
      expect(() => resolveAndValidateModel(token, "codex")).toThrow(
        /hidden\/deprecated.*不代表当前账号必然无法直接执行原模型/u,
      );
    });
  }

  for (const token of lunaTokens) {
    test(`${token} rejects without rewriting and points to Luna`, () => {
      expect(() => resolveAndValidateModel(token, "codex")).toThrow(
        /successor: Luna \(gpt-5\.6-luna\)/u,
      );
      expect(() => resolveAndValidateModel(token, "codex")).toThrow(
        /hidden\/deprecated.*不代表当前账号必然无法直接执行原模型/u,
      );
    });
  }

  test("mixed-case deprecated canonical id is still rejected", () => {
    expect(() => resolveAndValidateModel("Gpt-5.4-Mini", "codex")).toThrow(
      /successor: Luna/u,
    );
  });
});

describe("resolveModelAlias — 5.6 ambiguity (fail closed)", () => {
  for (const token of ["5.6", "gpt5.6", "gpt-5.6"]) {
    test(`${token} throws and lists sol/terra/luna`, () => {
      expect(() => resolveModelAlias(token, "codex")).toThrow(/sol \/ terra \/ luna/);
    });
  }
});

describe("resolveModelAlias — cross-backend rejection", () => {
  test("codex tokens on a claude session are rejected as codex models", () => {
    expect(() => resolveModelAlias("sol", "claude")).toThrow(/codex 模型/);
    expect(() => resolveModelAlias("5.6", "claude")).toThrow(/codex 模型/);
  });

  for (const token of [
    "gpt5.4",
    "5.4",
    "gpt-5.4",
    "gpt5.4-mini",
    "5.4-mini",
    "mini",
    "gpt-5.4-mini",
  ]) {
    test(`deprecated ${token} remains owned by codex across backends`, () => {
      expect(() => resolveModelAlias(token, "claude")).toThrow(/codex 模型/u);
      expect(() => resolveModelAlias(token, "kimi")).toThrow(/codex 模型/u);
    });
  }
});

describe("/model retired main fixed aliases", () => {
  for (const t of ["Fixed", "fixed", "FIX", "lock", "锁定"]) {
    test(`${t} is rejected without changing the legacy lock flag`, async () => {
      const store = createFakeBindingStore();
      seed(store, "s1", "mysess", "claude", { model: "claude-opus-4-8" });
      const handler = createSetModelHandler({ store });
      await expect(handler({ scope: "root", args: { name: "mysess", model: t }, msg: makeMsg("oc_root", `/model mysess ${t}`) })).rejects.toThrow(/Fixed\/Unfixed 已退役/u);
      expect((await store.findSessionByName("mysess"))?.modelLocked).toBe(false);
    });
  }

  for (const t of ["Unfixed", "unfix", "UNLOCK", "解锁"]) {
    test(`${t} is rejected without changing the legacy lock flag`, async () => {
      const store = createFakeBindingStore();
      seed(store, "s1", "mysess", "claude", { modelLocked: true });
      const handler = createSetModelHandler({ store });
      await expect(handler({ scope: "root", args: { name: "mysess", model: t }, msg: makeMsg("oc_root", `/model mysess ${t}`) })).rejects.toThrow(/Fixed\/Unfixed 已退役/u);
      expect((await store.findSessionByName("mysess"))?.modelLocked).toBe(true);
    });
  }
});

describe("/model default aliases", () => {
  for (const t of ["default", "DEFAULT", "默认"]) {
    test(`${t} stores null`, async () => {
      const store = createFakeBindingStore();
      seed(store, "s1", "codex-a", "codex", { model: "gpt-5.4" });
      const handler = createSetModelHandler({ store });
      const r = await handler({ scope: "root", args: { name: "codex-a", model: t }, msg: makeMsg("oc_root", `/model codex-a ${t}`) });
      if (!("replyText" in r)) throw new Error("expected replyText");
      expect(r.replyText).toContain("已恢复默认模型");
      expect((await store.findSessionByName("codex-a"))?.model).toBeNull();
    });
  }
});

describe("/model ambiguity → zero writes", () => {
  test("/model <codex> 5.6 raises UserError and writes nothing", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "codex-a", "codex", { model: "gpt-5.4" });
    const apply = vi.spyOn(store, "applySessionRuntimeConfigMutations");
    const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
    const handler = createSetModelHandler({ store, availability: { probe } });

    await expect(
      handler({ scope: "root", args: { name: "codex-a", model: "5.6" }, msg: makeMsg("oc_root", "/model codex-a 5.6") }),
    ).rejects.toBeInstanceOf(UserError);

    expect(apply).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect((await store.findSessionByName("codex-a"))?.model).toBe("gpt-5.4");
  });
});
