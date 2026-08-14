import { describe, expect, test, vi, beforeEach } from "vitest";
import { createNewHandler } from "../../../src/app/commands/newSession.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId } from "../../../src/domain/ids.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

function msg(text: string) {
  return {
    groupId: asLarkGroupId("oc_root"),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

describe("/new handler model validation", () => {
  beforeEach(() => {
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

  test("rejects unknown codex --model before creating a session", async () => {
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: async () => null,
        getSessionHeartbeatEnabled: async () => true,
      },
    });

    await expect(
      handler({
        args: { backend: "codex", name: "codex-a", model: "gpt-5.3" },
        scope: "root",
        msg: msg("/new codex codex-a --model gpt-5.3"),
      }),
    ).rejects.toThrow('未知 codex 模型 "gpt-5.3"');
    expect(create).not.toHaveBeenCalled();
  });

  test("creates explicit codex model without a model-inference availability probe", async () => {
    // Catalog-valid explicit model must be created without any generative
    // availability probe. Inject a counting probe and prove /new never calls it.
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const probe = vi.fn(async () => ({ kind: "available" as const, checkedAt: 1 }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: async () => null,
        getSessionHeartbeatEnabled: async () => true,
      },
      availability: { probe },
    });
    await handler({ args: { backend: "codex", name: "codex-a", model: "gpt-5.5" }, scope: "root", msg: msg("") });
    expect(probe).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", name: "codex-a", model: "gpt-5.5" }));
  });

  test("creates a top-level codex session without an explicit effort", async () => {
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: async () => null,
        getSessionHeartbeatEnabled: async () => true,
      },
    });

    await handler({ args: { backend: "codex", name: "codex-a" }, scope: "root", msg: msg("") });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex",
      name: "codex-a",
      effort: null,
    }));
  });

  test("creates default codex session without probing even when a transient probe is injected", async () => {
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const probe = vi.fn(async () => ({ kind: "transient_failure" as const, checkedAt: 1, reason: "timeout" }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: async () => null,
        getSessionHeartbeatEnabled: async () => true,
      },
      availability: { probe },
    });
    await handler({ args: { backend: "codex", name: "codex-a" }, scope: "root", msg: msg("") });
    expect(probe).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("creates codex session for catalog-valid model without probing even when unavailable probe injected", async () => {
    const create = vi.fn(async () => ({ session: { name: "codex-a" } }));
    const probe = vi.fn(async () => ({ kind: "unavailable" as const, checkedAt: 1, reason: "not entitled" }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: async () => null,
        getSessionHeartbeatEnabled: async () => true,
      },
      availability: { probe },
    });

    await handler({ args: { backend: "codex", name: "codex-a", model: "gpt-5.5" }, scope: "root", msg: msg("") });

    expect(probe).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ backend: "codex", model: "gpt-5.5" }));
  });
});

describe("/new clone", () => {
  test("copies backend-neutral source settings while target backend settings start from defaults", async () => {
    const create = vi.fn(async () => ({ session: { name: "kimi-reviewer" } }));
    const findSessionByName = vi.fn(async (name: string) =>
      name === "codexroot"
        ? {
            id: asSessionId("sess_source"),
            workdir: asAbsolutePath("/ws/codexroot"),
            purpose: "source purpose",
            category: "平台" as const,
            thinking: true,
            inactivityTimeoutS: 321,
            maxRuntimeS: 654,
          }
        : null,
    );
    const getSessionHeartbeatEnabled = vi.fn(async () => false);
    const handler = createNewHandler({
      lifecycle: { create },
      store: { findSessionByName, getSessionHeartbeatEnabled },
    });

    const result = await handler({
      args: {
        backend: "clone",
        name: "codexroot",
        purpose: "kimi kimi-reviewer",
      },
      scope: "root",
      msg: msg("/new clone codexroot kimi kimi-reviewer"),
    });

    expect(findSessionByName).toHaveBeenCalledWith("codexroot");
    expect(getSessionHeartbeatEnabled).toHaveBeenCalledWith("sess_source");
    expect(create).toHaveBeenCalledWith({
      backend: "kimi",
      name: "kimi-reviewer",
      purpose: "source purpose",
      effort: null,
      workdir: asAbsolutePath("/ws/codexroot"),
      category: "平台",
      thinking: true,
      inactivityTimeoutS: 321,
      maxRuntimeS: 654,
      heartbeatEnabled: false,
      affiliatedTo: "codexroot",
    });
    expect(result).toEqual({
      replyText: "✓ 已基于 session 「codexroot」的配置创建 session 「kimi-reviewer」（backend=kimi）",
    });
  });

  test("requires an explicit new session name", async () => {
    const create = vi.fn(async () => ({ session: { name: "unused" } }));
    const findSessionByName = vi.fn(async () => ({
      id: asSessionId("sess_source"),
      workdir: asAbsolutePath("/ws/codexroot"),
      purpose: "source purpose",
      category: "平台" as const,
      thinking: false,
      inactivityTimeoutS: null,
      maxRuntimeS: null,
    }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName,
        getSessionHeartbeatEnabled: async () => true,
      },
    });

    await expect(
      handler({
        args: { backend: "clone", name: "codexroot", purpose: "kimi" },
        scope: "root",
        msg: msg("/new clone codexroot kimi"),
      }),
    ).rejects.toThrow("<新session名>");
    expect(findSessionByName).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects an unknown source session before lifecycle creation", async () => {
    const create = vi.fn(async () => ({ session: { name: "kimi-reviewer" } }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: vi.fn(async () => null),
        getSessionHeartbeatEnabled: async () => true,
      },
    });

    await expect(
      handler({
        args: {
          backend: "clone",
          name: "missing-source",
          purpose: "kimi kimi-reviewer",
        },
        scope: "root",
        msg: msg("/new clone missing-source kimi kimi-reviewer"),
      }),
    ).rejects.toThrow("来源 session 不存在：missing-source");
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects --workdir because clone workdir comes from the source session", async () => {
    const create = vi.fn(async () => ({ session: { name: "kimi-reviewer" } }));
    const handler = createNewHandler({
      lifecycle: { create },
      store: {
        findSessionByName: vi.fn(async () => ({
          id: asSessionId("sess_source"),
          workdir: asAbsolutePath("/ws/codexroot"),
          purpose: "source purpose",
          category: "平台" as const,
          thinking: false,
          inactivityTimeoutS: null,
          maxRuntimeS: null,
        })),
        getSessionHeartbeatEnabled: async () => true,
      },
    });

    await expect(
      handler({
        args: {
          backend: "clone",
          name: "codexroot",
          purpose: "kimi kimi-reviewer",
          workdir: "/ws/other",
        },
        scope: "root",
        msg: msg("/new clone codexroot kimi kimi-reviewer --workdir /ws/other"),
      }),
    ).rejects.toThrow("/new clone 不能同时指定 --workdir");
    expect(create).not.toHaveBeenCalled();
  });
});
