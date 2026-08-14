import { describe, it, expect } from "vitest";
import {
  buildKimiCardAskMcpServers,
  type CardAskRuntimeConfig,
} from "../../../src/adapters/card-ask/config.ts";

const cfg: CardAskRuntimeConfig = {
  brokerUrl: "http://127.0.0.1:8787",
  chatId: "oc_test_chat",
  mcpAskServerPath: "/opt/larkc/card-callback/src/mcpAskServer.js",
  toolTimeoutSec: 360,
};

describe("buildKimiCardAskMcpServers", () => {
  it("returns a single ACP Stdio McpServer named 'askserver'", () => {
    const result = buildKimiCardAskMcpServers(cfg);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("askserver");
  });

  it("uses node to launch the MCP ask server", () => {
    const result = buildKimiCardAskMcpServers(cfg);
    expect(result[0].command).toBe("node");
    expect(result[0].args).toEqual([cfg.mcpAskServerPath]);
  });

  it("converts env to ACP EnvVariable[] form (array of {name,value}), not object", () => {
    const result = buildKimiCardAskMcpServers(cfg);
    expect(result[0].env).toEqual([
      { name: "BROKER_URL", value: cfg.brokerUrl },
      { name: "CHAT_ID", value: cfg.chatId },
    ]);
    expect(Array.isArray(result[0].env)).toBe(true);
  });
});
