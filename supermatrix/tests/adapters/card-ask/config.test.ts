import { describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildClaudeCardAskMcpConfig,
  buildCodexCardAskConfigArgs,
  buildCardAskRuntimeConfig,
  resolveMcpAskServerPath,
  probeCardAskBrokerHealth,
  resolveBrokerUrl,
} from "../../../src/adapters/card-ask/config.ts";

describe("card ask adapter config", () => {
  test("resolveBrokerUrl uses BROKER_URL before BROKER_PORT", () => {
    expect(resolveBrokerUrl({
      BROKER_URL: "http://127.0.0.1:9999",
      BROKER_PORT: "8888",
    })).toBe("http://127.0.0.1:9999");
  });

  test("resolveBrokerUrl uses BROKER_PORT when BROKER_URL is absent", () => {
    expect(resolveBrokerUrl({ BROKER_PORT: "8888" })).toBe("http://127.0.0.1:8888");
  });

  test("resolveBrokerUrl defaults to localhost 8787", () => {
    expect(resolveBrokerUrl({})).toBe("http://127.0.0.1:8787");
  });

  test("buildCardAskRuntimeConfig requires both cardAskEnabled and cardAskChatId", () => {
    expect(buildCardAskRuntimeConfig({
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    })).toMatchObject({
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_card_ask",
      toolTimeoutSec: 360,
    });
    expect(buildCardAskRuntimeConfig({ cardAskEnabled: true })).toBeNull();
    expect(buildCardAskRuntimeConfig({ cardAskChatId: "oc_card_ask" })).toBeNull();
  });

  test("buildCardAskRuntimeConfig keeps answerOnly runs tool-free", () => {
    expect(buildCardAskRuntimeConfig({
      answerOnly: true,
      cardAskEnabled: true,
      cardAskChatId: "oc_card_ask",
    })).toBeNull();
  });

  test("uses a non-default runtime MCP path for Codex and keeps the HTTP broker route", async () => {
    const runtime = await mkdtemp("/tmp/card-ask-runtime-");
    const mcpPath = join(runtime, "onboarding-v1", "modules", "larkc", "card-callback", "src", "mcpAskServer.js");
    try {
      await mkdir(join(runtime, "onboarding-v1", "modules", "larkc", "card-callback", "src"), { recursive: true });
      await writeFile(mcpPath, "// fixture\n");
      const config = buildCardAskRuntimeConfig({
        cardAskEnabled: true,
        cardAskChatId: "oc_card_ask",
      }, { SM_CARD_ASK_MCP_SERVER_PATH: mcpPath });
      expect(config?.mcpAskServerPath).toBe(mcpPath);
      expect(buildCodexCardAskConfigArgs(config!)).toContain(`mcp_servers.askserver.args=[${JSON.stringify(mcpPath)}]`);
      expect(buildClaudeCardAskMcpConfig(config!)).toContain(mcpPath);
      expect(config?.brokerUrl).toBe("http://127.0.0.1:8787");
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });

  test("fails closed for an explicit missing or invalid MCP path", () => {
    expect(resolveMcpAskServerPath({ SM_CARD_ASK_MCP_SERVER_PATH: "/tmp/does-not-exist/mcpAskServer.js" })).toBeNull();
    expect(resolveMcpAskServerPath({ SM_CARD_ASK_MCP_SERVER_PATH: "relative/mcpAskServer.js" })).toBeNull();
    expect(buildCardAskRuntimeConfig({ cardAskEnabled: true, cardAskChatId: "oc_card_ask" }, {
      SM_CARD_ASK_MCP_SERVER_PATH: "",
    })).toBeNull();
  });

  test("backend MCP registration uses askserver as the server key", () => {
    const config = {
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_card_ask",
      mcpAskServerPath: "/tmp/mcpAskServer.js",
      toolTimeoutSec: 360,
    };

    const claudeConfig = JSON.parse(buildClaudeCardAskMcpConfig(config)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(claudeConfig.mcpServers)).toEqual(["askserver"]);
    expect(claudeConfig.mcpServers).not.toHaveProperty("ask_user");

    const codexArgs = buildCodexCardAskConfigArgs(config);
    expect(codexArgs).toContain('mcp_servers.askserver.command="node"');
    expect(codexArgs).toContain("mcp_servers.askserver.tool_timeout_sec=360");
    expect(codexArgs.some((arg) => arg.includes("mcp_servers.ask_user"))).toBe(false);
  });

  test("probeCardAskBrokerHealth returns true only for 200 ok", async () => {
    const okFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const badBodyFetch = vi.fn(async () => new Response("nope", { status: 200 }));
    const downFetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(probeCardAskBrokerHealth({
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_card_ask",
      mcpAskServerPath: "/tmp/mcpAskServer.js",
      toolTimeoutSec: 360,
    }, okFetch)).resolves.toBe(true);
    await expect(probeCardAskBrokerHealth({
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_card_ask",
      mcpAskServerPath: "/tmp/mcpAskServer.js",
      toolTimeoutSec: 360,
    }, badBodyFetch)).resolves.toBe(false);
    await expect(probeCardAskBrokerHealth({
      brokerUrl: "http://127.0.0.1:8787",
      chatId: "oc_card_ask",
      mcpAskServerPath: "/tmp/mcpAskServer.js",
      toolTimeoutSec: 360,
    }, downFetch)).resolves.toBe(false);
  });
});
