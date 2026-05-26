import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { StreamLogEntry } from "./replier.ts";
import { isTerminalErrorMessage } from "./runStatus.ts";
import {
  accumulateUsage,
  normalizeCumulativeUsageEvent,
  type CollectedUsage,
  type UsageWatermark,
} from "./usageCollector.ts";

export type StreamResult = {
  finalMessage: string;
  backendSessionId: string | null;
  error?: string;
  usage?: CollectedUsage;
  streamLog: StreamLogEntry[];
};

export type CollectStreamHooks = {
  onStarted?: (event: Extract<AgentEvent, { kind: "started" }>) => Promise<void> | void;
  normalizeCumulativeUsage?: boolean;
  usageBaseline?: UsageWatermark | null;
};

export async function collectStream(
  stream: AsyncIterable<AgentEvent>,
  hooks: CollectStreamHooks = {},
): Promise<StreamResult> {
  let finalMessage = "";
  let backendSessionId: string | null = null;
  let error: string | undefined;
  let usage: CollectedUsage | undefined;
  let usageWatermark = hooks.usageBaseline ?? null;
  // Collect every assistant_message in order. Codex commentary arrives as
  // non-final assistant_message and the wrap-up as final; the joined text
  // is the user-visible reply (mirrors replier).
  const assistantTexts: string[] = [];
  const streamLog: StreamLogEntry[] = [];

  for await (const event of stream) {
    switch (event.kind) {
      case "started":
        backendSessionId = event.backendSessionId;
        await hooks.onStarted?.(event);
        break;
      case "thinking":
        streamLog.push({ ts: Date.now(), kind: "thinking", text: event.text });
        break;
      case "tool_call":
        {
          const entry: StreamLogEntry = {
            ts: Date.now(),
            kind: "tool_call",
            name: event.name,
            args: event.args,
          };
          if (event.callId) entry.callId = event.callId;
          if (event.command) entry.command = event.command;
          streamLog.push(entry);
        }
        break;
      case "tool_result":
        {
          const entry: StreamLogEntry = {
            ts: Date.now(),
            kind: "tool_result",
            name: event.name,
            result: event.result,
          };
          if (event.callId) entry.callId = event.callId;
          if (event.command) entry.command = event.command;
          streamLog.push(entry);
        }
        break;
      case "assistant_message":
        assistantTexts.push(event.text);
        streamLog.push({
          ts: Date.now(),
          kind: "assistant_message",
          text: event.text,
          final: event.final,
        });
        if (event.final) finalMessage = assistantTexts.join("\n\n");
        break;
      case "completed":
        if (!finalMessage) {
          finalMessage =
            assistantTexts.length > 0 ? assistantTexts.join("\n\n") : event.finalMessage;
        }
        break;
      case "error":
        // Keep the FIRST error — usually the informative root cause (e.g.
        // codex API 400 "model not supported"). Subsequent errors are often
        // downstream noise (codex CLI 0.128.0 prints "Reading additional
        // input from stdin..." to stderr after a failed turn, which used
        // to clobber the real cause). Terminal kill signals ([TIMEOUT] /
        // cancelled by user) still override — they're authoritative.
        // streamLog keeps all errors for forensics.
        if (!error || isTerminalErrorMessage(event.message)) {
          error = event.message;
        }
        streamLog.push({ ts: Date.now(), kind: "error", text: event.message });
        break;
      case "usage":
        if (hooks.normalizeCumulativeUsage && hooks.usageBaseline) {
          const normalized = normalizeCumulativeUsageEvent(event, usageWatermark);
          usageWatermark = normalized.nextWatermark;
          usage = accumulateUsage(usage, normalized.event);
        } else {
          usage = accumulateUsage(usage, event);
        }
        break;
    }
  }

  return {
    finalMessage,
    backendSessionId,
    streamLog,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
  };
}
