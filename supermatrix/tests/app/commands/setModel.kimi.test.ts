import { describe, it, expect } from "vitest";
import { UserError } from "../../../src/domain/errors.ts";
import {
  createSetModelHandler,
  resolveModelAlias,
  resolveAndValidateModel,
  assertKimiModelAliasesInCatalog,
} from "../../../src/app/commands/setModel.ts";
import {
  KIMI_DEFAULT_MODEL,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
  isKnownKimiModel,
  kimiModelUnknownMessage,
} from "../../../src/ports/KimiModelCatalog.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

describe("KimiModelCatalog port", () => {
  it("knows the three kimi-code 0.33.0 models the managed provider serves", () => {
    expect(isKnownKimiModel("kimi-code/kimi-for-coding")).toBe(true);
    expect(isKnownKimiModel("kimi-code/kimi-for-coding-highspeed")).toBe(true);
    expect(isKnownKimiModel("kimi-code/k3")).toBe(true);
  });

  it("no longer knows the legacy kimi-cli id kimi-k2-thinking", () => {
    expect(isKnownKimiModel("kimi-k2-thinking")).toBe(false);
    expect(isKnownKimiModel("gpt-5.5")).toBe(false);
    expect(isKnownKimiModel("nonsense-model")).toBe(false);
    // Not served by the managed provider: session/set_model fails ACP -32603.
    expect(isKnownKimiModel("kimi-code/k3-256k")).toBe(false);
  });

  it("lists all verified models in the unknown-model message", () => {
    const msg = kimiModelUnknownMessage("nonsense-model");
    expect(msg).toContain('未知 kimi 模型 "nonsense-model"');
    expect(msg).toContain("kimi-code/kimi-for-coding");
    expect(msg).toContain("kimi-code/kimi-for-coding-highspeed");
    expect(msg).toContain("kimi-code/k3");
    expect(msg).not.toContain("kimi-code/k3-256k");
  });

  it("KIMI_DEFAULT_MODEL equals kimi-code/kimi-for-coding", () => {
    expect(KIMI_DEFAULT_MODEL).toBe("kimi-code/kimi-for-coding");
  });
});

describe("resolveModelAlias — kimi backend", () => {
  it.each([
    ["kimi", KIMI_DEFAULT_MODEL],
    ["k2", KIMI_DEFAULT_MODEL],
    ["k2.7", KIMI_DEFAULT_MODEL],
    ["k27", KIMI_DEFAULT_MODEL],
    ["coding", KIMI_DEFAULT_MODEL],
    ["kimi-for-coding", KIMI_DEFAULT_MODEL],
    ["highspeed", KIMI_HIGHSPEED_MODEL],
    ["fast", KIMI_HIGHSPEED_MODEL],
    ["kimi-for-coding-highspeed", KIMI_HIGHSPEED_MODEL],
    ["k3", KIMI_K3_MODEL],
  ])("resolves %s -> %s", (alias, target) => {
    expect(resolveModelAlias(alias, "kimi")).toBe(target);
  });

  it("passes through canonical model ids unchanged", () => {
    expect(resolveModelAlias("kimi-code/kimi-for-coding", "kimi")).toBe(KIMI_DEFAULT_MODEL);
    expect(resolveModelAlias("kimi-code/k3", "kimi")).toBe(KIMI_K3_MODEL);
  });

  it("case-folds aliases", () => {
    expect(resolveModelAlias("K3", "kimi")).toBe(KIMI_K3_MODEL);
    expect(resolveModelAlias("Highspeed", "kimi")).toBe(KIMI_HIGHSPEED_MODEL);
  });

  it("rejects claude aliases on kimi backend", () => {
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
      expect(() => resolveModelAlias(alias, "kimi")).toThrow(UserError);
      expect(() => resolveModelAlias(alias, "kimi")).toThrow(/claude.*session/);
    }
  });

  it("rejects codex aliases and canonical ids on kimi backend", () => {
    expect(() => resolveModelAlias("gpt5.5", "kimi")).toThrow(/codex.*session/);
    expect(() => resolveModelAlias("gpt-5.5", "kimi")).toThrow(/codex.*session/);
  });

  it("rejects canonical claude id on kimi backend", () => {
    expect(() => resolveModelAlias("claude-opus-4-8", "kimi")).toThrow(/claude.*session/);
  });
});

describe("resolveModelAlias — cross-backend kimi alias rejection", () => {
  it("claude backend rejects kimi aliases", () => {
    for (const alias of ["k2", "k3", "highspeed", "kimi"]) {
      expect(() => resolveModelAlias(alias, "claude")).toThrow(UserError);
      expect(() => resolveModelAlias(alias, "claude")).toThrow(/kimi.*session/);
    }
  });

  it("codex backend rejects kimi aliases", () => {
    for (const alias of ["k2", "k3", "kimi", "coding"]) {
      expect(() => resolveModelAlias(alias, "codex")).toThrow(UserError);
      expect(() => resolveModelAlias(alias, "codex")).toThrow(/kimi.*session/);
    }
  });

  it("claude backend rejects canonical kimi id", () => {
    expect(() => resolveModelAlias("kimi-code/k3", "claude")).toThrow(/kimi.*session/);
  });

  it("codex backend rejects canonical kimi id", () => {
    expect(() => resolveModelAlias("kimi-code/kimi-for-coding", "codex")).toThrow(/kimi.*session/);
  });
});

describe("resolveAndValidateModel — kimi backend", () => {
  it("accepts canonical ids directly", () => {
    expect(resolveAndValidateModel("kimi-code/kimi-for-coding", "kimi")).toBe(KIMI_DEFAULT_MODEL);
    expect(resolveAndValidateModel("kimi-code/k3", "kimi")).toBe(KIMI_K3_MODEL);
  });

  it("accepts aliases and resolves them", () => {
    expect(resolveAndValidateModel("kimi", "kimi")).toBe(KIMI_DEFAULT_MODEL);
    expect(resolveAndValidateModel("k3", "kimi")).toBe(KIMI_K3_MODEL);
    expect(resolveAndValidateModel("fast", "kimi")).toBe(KIMI_HIGHSPEED_MODEL);
  });

  it("rejects the legacy id kimi-k2-thinking as unknown", () => {
    expect(() => resolveAndValidateModel("kimi-k2-thinking", "kimi")).toThrow(UserError);
    expect(() => resolveAndValidateModel("kimi-k2-thinking", "kimi")).toThrow(/kimi-k2-thinking/);
  });

  it("identifies canonical codex id gpt-5.5 as a codex model on kimi backend", () => {
    expect(() => resolveAndValidateModel("gpt-5.5", "kimi")).toThrow(/codex.*session/);
  });

  it("throws UserError for nonsense-model", () => {
    expect(() => resolveAndValidateModel("nonsense-model", "kimi")).toThrow(/nonsense-model/);
  });
});

describe("resolveAndValidateModel — cross-backend kimi alias rejection", () => {
  it("throws UserError on claude backend with kimi alias k2", () => {
    expect(() => resolveAndValidateModel("k2", "claude")).toThrow(/kimi.*session/);
  });

  it("throws UserError on codex backend with kimi alias k3", () => {
    expect(() => resolveAndValidateModel("k3", "codex")).toThrow(/kimi.*session/);
  });
});

describe("assertKimiModelAliasesInCatalog", () => {
  it("passes — every alias resolves to a model in the catalog", () => {
    expect(() => assertKimiModelAliasesInCatalog()).not.toThrow();
  });
});

describe("/model — kimi model change revalidates stored effort", () => {
  function makeMsg(text: string) {
    return { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
  }

  function seedKimi(store: ReturnType<typeof createFakeBindingStore>, extra: Partial<Session> = {}) {
    store.seedSession({
      id: asSessionId("k1"), name: "kimi-a", alias: "", avatar: "", category: "", fpManaged: null,
      scope: "user", backend: "kimi", model: "kimi-code/k3", effort: "low", thinking: false,
      modelLocked: false, effortLocked: false, workdir: asAbsolutePath("/ws/kimi-a"),
      backendSessionId: null, chatName: null, purpose: "", status: "idle", parentId: null, depth: 0,
      inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null,
      postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1), updatedAt: asTimestamp(1), ...extra,
    });
  }

  it("switching K3 -> K2.7 clears the now-invalid K3 effort instead of retaining it", async () => {
    const store = createFakeBindingStore();
    seedKimi(store);
    const handler = createSetModelHandler({ store });

    await handler({ scope: "root", args: { name: "kimi-a", model: "k2.7" }, msg: makeMsg("/model kimi-a k2.7") });

    const session = await store.findSessionByName("kimi-a");
    expect(session?.model).toBe(KIMI_DEFAULT_MODEL);
    expect(session?.effort).toBeNull();
  });

  // k3-256k is absent from the managed kimi-code provider: selecting it made
  // session/set_model fail with ACP -32603 and killed the run (2026-08-05).
  // Admission must reject it and leave the session untouched.
  it.each(["k3-256k", "k3256k", "256k", "kimi-code/k3-256k"])(
    "rejects %s without touching the session",
    async (input) => {
      const store = createFakeBindingStore();
      seedKimi(store);
      const handler = createSetModelHandler({ store });

      await expect(
        handler({ scope: "root", args: { name: "kimi-a", model: input }, msg: makeMsg(`/model kimi-a ${input}`) }),
      ).rejects.toThrow(UserError);

      const session = await store.findSessionByName("kimi-a");
      expect(session?.model).toBe(KIMI_K3_MODEL);
      expect(session?.effort).toBe("low");
    },
  );

  it("switching K3 -> default model (fixed-on K2.7) clears the K3 effort", async () => {
    const store = createFakeBindingStore();
    seedKimi(store);
    const handler = createSetModelHandler({ store });

    await handler({ scope: "root", args: { name: "kimi-a", model: "default" }, msg: makeMsg("/model kimi-a default") });

    const session = await store.findSessionByName("kimi-a");
    expect(session?.model).toBeNull();
    expect(session?.effort).toBeNull();
  });
});
