// src/adapters/card-ask/askViaBroker.ts
//
// HTTP client for the card-ask broker's POST /ask endpoint. Used by the kimi
// backend to route built-in AskUserQuestion permission requests onto the same
// Feishu card path as the ask_user MCP tool (mcpAskServer.js speaks the same
// protocol; the broker lives in the larkc card-callback workspace).

export type CardAskBrokerOption = {
  label: string;
  value: string;
  description: string;
};

export type CardAskBrokerRequest = {
  brokerUrl: string;
  chatId: string;
  question: string;
  options: CardAskBrokerOption[];
  context?: string | undefined;
};

export type CardAskBrokerResult =
  | { status: "answered"; value: string; label: string | null }
  | { status: "escaped"; reason: string | null };

// The broker blocks up to 300s waiting for a click; give it headroom to answer
// first, mirroring mcpAskServer.js (HTTP_TIMEOUT_MS = 310_000).
const ASK_TIMEOUT_MS = 310_000;

export async function askViaBroker(
  req: CardAskBrokerRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<CardAskBrokerResult> {
  const response = await fetchImpl(new URL("/ask", req.brokerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: req.question,
      options: req.options,
      chat_id: req.chatId,
      ...(req.context ? { context: req.context } : {}),
    }),
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`broker /ask HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    status?: unknown;
    value?: unknown;
    label?: unknown;
    reason?: unknown;
  };
  if (body.status === "answered" && typeof body.value === "string") {
    return {
      status: "answered",
      value: body.value,
      label: typeof body.label === "string" ? body.label : null,
    };
  }
  if (body.status === "escaped") {
    return {
      status: "escaped",
      reason: typeof body.reason === "string" ? body.reason : null,
    };
  }
  throw new Error(
    `broker /ask unexpected response: ${JSON.stringify(body).slice(0, 200)}`,
  );
}
