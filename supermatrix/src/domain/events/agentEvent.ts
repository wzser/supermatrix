export type AgentEvent =
  | { kind: "started"; backendSessionId: string; model?: string; thinking?: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; name: string; args: unknown; callId?: string; command?: string }
  | { kind: "tool_result"; name: string; result: unknown; callId?: string; command?: string }
  | { kind: "assistant_message"; text: string; final: boolean }
  | { kind: "error"; message: string; recoverable: boolean }
  | { kind: "completed"; finalMessage: string }
  | {
      kind: "usage";
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      contextWindowTokens?: number | null;
      rawUsage: unknown;
    };
