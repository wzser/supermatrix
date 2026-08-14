import { describe, expect, test, vi } from "vitest";
import {
  buildClaudeCardAskMcpConfig,
  buildCodexCardAskConfigArgs,
  buildCardAskRuntimeConfig,
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
