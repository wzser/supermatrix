import type { RunInput } from "../../ports/AgentBackend.ts";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:8787";
export const MCP_ASK_SERVER_PATH =
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/larkc/card-callback/src/mcpAskServer.js";
export const CARD_ASK_TOOL_TIMEOUT_SEC = 360;
const HEALTH_TIMEOUT_MS = 1_000;

export type CardAskRuntimeConfig = {
  brokerUrl: string;
  chatId: string;
  mcpAskServerPath: string;
  toolTimeoutSec: number;
};

type CardAskInput = Pick<RunInput, "answerOnly" | "cardAskEnabled" | "cardAskChatId">;
type BrokerEnv = {
  BROKER_URL?: string | undefined;
  BROKER_PORT?: string | undefined;
};

export function resolveBrokerUrl(
  env: BrokerEnv = process.env,
): string {
  const brokerUrl = env.BROKER_URL?.trim();
  if (brokerUrl) return brokerUrl;

  const brokerPort = env.BROKER_PORT?.trim();
  if (brokerPort) return `http://127.0.0.1:${brokerPort}`;

  return DEFAULT_BROKER_URL;
}

export function buildCardAskRuntimeConfig(
  input: CardAskInput,
  env: BrokerEnv = process.env,
): CardAskRuntimeConfig | null {
  if (input.answerOnly === true) return null;
  if (input.cardAskEnabled !== true) return null;
  const chatId = input.cardAskChatId?.trim();
  if (!chatId) return null;

  return {
    brokerUrl: resolveBrokerUrl(env),
    chatId,
    mcpAskServerPath: MCP_ASK_SERVER_PATH,
    toolTimeoutSec: CARD_ASK_TOOL_TIMEOUT_SEC,
  };
}

export type CardAskHealthCheck = (config: CardAskRuntimeConfig) => Promise<boolean>;

export async function probeCardAskBrokerHealth(
  config: CardAskRuntimeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL("/health", config.brokerUrl), {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    return (await response.text()).trim() === "ok";
  } catch {
    return false;
  }
}

export async function disableCardAskWhenBrokerUnhealthy(
  input: RunInput,
  healthCheck: CardAskHealthCheck = probeCardAskBrokerHealth,
): Promise<RunInput> {
  const config = buildCardAskRuntimeConfig(input);
  if (!config) return input;
  if (await healthCheck(config)) return input;
  return { ...input, cardAskEnabled: undefined, cardAskChatId: undefined };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexCardAskConfigArgs(config: CardAskRuntimeConfig): string[] {
  return [
    "-c",
    "mcp_servers.askserver.command=\"node\"",
    "-c",
    `mcp_servers.askserver.args=[${tomlString(config.mcpAskServerPath)}]`,
    "-c",
    `mcp_servers.askserver.env={BROKER_URL=${tomlString(config.brokerUrl)},CHAT_ID=${tomlString(config.chatId)}}`,
    "-c",
    `mcp_servers.askserver.tool_timeout_sec=${config.toolTimeoutSec}`,
  ];
}

export function buildClaudeCardAskMcpConfig(config: CardAskRuntimeConfig): string {
  return JSON.stringify({
    mcpServers: {
      askserver: {
        command: "node",
        args: [config.mcpAskServerPath],
        env: {
          BROKER_URL: config.brokerUrl,
          CHAT_ID: config.chatId,
        },
      },
    },
  });
}

export type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

export function buildKimiCardAskMcpServers(
  config: CardAskRuntimeConfig,
): AcpStdioMcpServer[] {
  return [
    {
      name: "askserver",
      command: "node",
      args: [config.mcpAskServerPath],
      env: [
        { name: "BROKER_URL", value: config.brokerUrl },
        { name: "CHAT_ID", value: config.chatId },
      ],
    },
  ];
}
