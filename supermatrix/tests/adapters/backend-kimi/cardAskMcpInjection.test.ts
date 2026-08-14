import { describe, it, expect, vi } from "vitest";
import { KimiBackend } from "../../../src/adapters/backend-kimi/index.ts";
import type { RunInput } from "../../../src/ports/AgentBackend.ts";
import type { SessionId, AbsolutePath } from "../../../src/domain/ids.ts";

function fakeAcpClient(overrides: Partial<{
  newSessionSpy: (p: { cwd: string; mcpServers?: unknown[] }) => Promise<string>;
}> = {}) {
  return {
    ensureReady: vi.fn(async () => {}),
    newSession: vi.fn(async (p: { cwd: string; mcpServers?: unknown[] }) => {
      if (overrides.newSessionSpy) return overrides.newSessionSpy(p);
      return "acp-sess-1";
    }),
    loadSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    getPid: vi.fn(() => 12345),
    getSessionModel: vi.fn(() => undefined),
    setCardAskRoute: vi.fn(),
  };
}

function baseInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    session: {
      id: "sess-1" as SessionId,
      backendSessionId: null,
      workdir: "/tmp/wd" as AbsolutePath,
      model: null,
      effort: null,
      maxRuntimeS: null,
      inactivityTimeoutS: null,
    } as RunInput["session"],
    prompt: "hello",
    attachments: [],
    systemHint: undefined,
    answerOnly: undefined,
    cardAskEnabled: undefined,
    cardAskChatId: undefined,
    conversationFork: undefined,
    ...overrides,
  } as RunInput;
}

async function drain(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("KimiBackend card-ask route registration", () => {
  it("registers the broker route for built-in AskUserQuestion when card-ask is on", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput({
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));
    expect(acp.setCardAskRoute).toHaveBeenCalledWith("acp-sess-1", {
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_test",
    });
  });

  it("clears the route when card-ask is off, so no phantom auto-approve can recur", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput()));
    expect(acp.setCardAskRoute).toHaveBeenCalledWith("acp-sess-1", null);
  });
});

describe("KimiBackend card-ask MCP injection", () => {
  it("passes empty mcpServers when cardAskEnabled is undefined", async () => {
    const acp = fakeAcpClient();
    // Inject a stub health check that would normally enable card-ask; should not be called.
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput()));
    expect(acp.newSession).toHaveBeenCalledTimes(1);
    expect(acp.newSession.mock.calls[0][0].mcpServers).toEqual([]);
  });

  it("passes askserver mcpServer when cardAskEnabled=true and broker healthy", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput({
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));
    const passed = acp.newSession.mock.calls[0][0].mcpServers as Array<{ name: string }>;
    expect(passed).toHaveLength(1);
    expect(passed[0].name).toBe("askserver");
  });

  it("disables card-ask when broker health check fails", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => false),
    });
    await drain(backend.run(baseInput({
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));
    expect(acp.newSession.mock.calls[0][0].mcpServers).toEqual([]);
  });

  it("skips card-ask when answerOnly=true even if cardAskEnabled set", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput({
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
      answerOnly: true,
    })));
    expect(acp.newSession.mock.calls[0][0].mcpServers).toEqual([]);
  });

  it("passes askserver mcpServer to loadSession when resuming an existing session", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    await drain(backend.run(baseInput({
      session: {
        ...(baseInput().session as any),
        backendSessionId: "existing-acp-id",
      } as any,
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));
    expect(acp.newSession).not.toHaveBeenCalled();
    expect(acp.loadSession).toHaveBeenCalledTimes(1);
    const passed = ((acp.loadSession.mock.calls as any)[0][0] as unknown as { mcpServers: Array<{ name: string }> }).mcpServers;
    expect(passed).toHaveLength(1);
    expect(passed[0].name).toBe("askserver");
  });

  it("reloads an already-loaded ACP session when card ask becomes enabled", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });

    await drain(backend.run(baseInput()));
    await drain(backend.run(baseInput({
      session: {
        ...baseInput().session,
        backendSessionId: "acp-sess-1",
      },
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));

    expect(acp.loadSession).toHaveBeenCalledTimes(1);
    const loaded = (acp.loadSession.mock.calls as unknown as Array<[
      { sessionId: string; mcpServers: Array<{ name: string }> },
    ]>)[0][0];
    expect(loaded.sessionId).toBe("acp-sess-1");
    expect(loaded.mcpServers.map((server) => server.name)).toEqual(["askserver"]);
  });

  it("reloads an already-loaded ACP session with no MCP servers when card ask becomes disabled", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });

    await drain(backend.run(baseInput({
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    })));
    await drain(backend.run(baseInput({
      session: {
        ...baseInput().session,
        backendSessionId: "acp-sess-1",
      },
    })));

    expect(acp.loadSession).toHaveBeenCalledTimes(1);
    expect(acp.loadSession).toHaveBeenCalledWith({
      sessionId: "acp-sess-1",
      cwd: "/tmp/wd",
      mcpServers: [],
    });
  });

  it("does not reload an ACP session every turn when the effective MCP config is unchanged", async () => {
    const acp = fakeAcpClient();
    const backend = new KimiBackend({
      acpClient: acp as any,
      cardAskHealthCheck: vi.fn(async () => true),
    });
    const input = baseInput({
      session: {
        ...baseInput().session,
        backendSessionId: "existing-acp-id",
      },
      cardAskEnabled: true,
      cardAskChatId: "oc_test",
    });

    await drain(backend.run(input));
    await drain(backend.run(input));

    expect(acp.loadSession).toHaveBeenCalledTimes(1);
  });

  it("reloads an ACP session when card-ask chat or broker environment changes", async () => {
    vi.stubEnv("BROKER_URL", "http://127.0.0.1:8787");
    try {
      const acp = fakeAcpClient();
      const backend = new KimiBackend({
        acpClient: acp as any,
        cardAskHealthCheck: vi.fn(async () => true),
      });

      await drain(backend.run(baseInput({
        cardAskEnabled: true,
        cardAskChatId: "oc_first",
      })));
      await drain(backend.run(baseInput({
        session: {
          ...baseInput().session,
          backendSessionId: "acp-sess-1",
        },
        cardAskEnabled: true,
        cardAskChatId: "oc_second",
      })));

      vi.stubEnv("BROKER_URL", "http://127.0.0.1:9797");
      await drain(backend.run(baseInput({
        session: {
          ...baseInput().session,
          backendSessionId: "acp-sess-1",
        },
        cardAskEnabled: true,
        cardAskChatId: "oc_second",
      })));

      expect(acp.loadSession).toHaveBeenCalledTimes(2);
      const loads = acp.loadSession.mock.calls as unknown as Array<[
        { mcpServers: Array<{ env: Array<{ name: string; value: string }> }> },
      ]>;
      expect(loads[0][0].mcpServers[0].env).toContainEqual({
        name: "CHAT_ID",
        value: "oc_second",
      });
      expect(loads[1][0].mcpServers[0].env).toContainEqual({
        name: "BROKER_URL",
        value: "http://127.0.0.1:9797",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
