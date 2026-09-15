import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { RunInput } from "../ports/AgentBackend.ts";
import type { Logger } from "../ports/Logger.ts";

// In-run recovery for a stale Kimi ACP resume id. Kimi ACP sessions are stored
// per account, so after an account switch every persisted backend_session_id
// fails the first resume with `Unknown sessionId: <id>`. Instead of letting
// that failure surface to the user (and self-healing only on the NEXT turn via
// shouldClearKimiResumeIdAfterFailure), clear the persisted id and replay the
// same logical run exactly once with a fresh session — but only when no work
// signal has been observed yet, so the replay cannot duplicate side effects.
//
// Unlike the codex recovery (codexRuntimeRecovery.ts), `started`/`thinking`
// are NOT work signals here: the kimi adapter yields `started` as an
// announcement before prompting, so treating it as work would disable the
// recovery exactly when it is needed.

const WORK_SIGNAL_KINDS = new Set<AgentEvent["kind"]>([
  "assistant_message",
  "tool_call",
  "tool_result",
  "usage",
]);

const RETRY_NOTICE =
  "⚠️ kimi 会话已失效（可能因账号切换），正在自动开启新会话重试…";

export type RecoverKimiResumeStreamInput = {
  /** Starts a backend run and returns its event stream (lazy). */
  run: (runInput: RunInput) => AsyncIterable<AgentEvent>;
  /** Run input for the first attempt; the replay nulls its backendSessionId. */
  runInput: RunInput;
  /** The persisted resume id whose rejection authorizes the replay. */
  persistedBackendSessionId: string;
  /** Clears the persisted id so a failed replay won't be resumed again. */
  clearPersisted: () => Promise<void>;
  logger?: Logger;
};

export function recoverKimiResumeStream(
  input: RecoverKimiResumeStreamInput,
): AsyncIterable<AgentEvent> {
  return { [Symbol.asyncIterator]: () => generate(input) };
}

async function* generate(
  input: RecoverKimiResumeStreamInput,
): AsyncGenerator<AgentEvent> {
  const staleMarker = `Unknown sessionId: ${input.persistedBackendSessionId}`;
  let workStarted = false;
  let retried = false;

  const isRecoverable = (message: string): boolean =>
    !retried && !workStarted && message.includes(staleMarker);

  try {
    for await (const event of input.run(input.runInput)) {
      if (WORK_SIGNAL_KINDS.has(event.kind)) {
        workStarted = true;
      } else if (event.kind === "error" && isRecoverable(event.message)) {
        retried = true;
        yield* replay(input);
        return;
      }
      yield event;
    }
  } catch (err) {
    // The kimi adapter's loadSession failure path throws straight out of its
    // generator instead of yielding an error event — same judgment applies.
    const message = err instanceof Error ? err.message : String(err);
    if (isRecoverable(message)) {
      retried = true;
      yield* replay(input);
      return;
    }
    throw err;
  }
}

async function* replay(
  input: RecoverKimiResumeStreamInput,
): AsyncGenerator<AgentEvent> {
  input.logger?.warn("kimi resume id rejected; cleared persisted id and replaying with a fresh session", {
    backendSessionId: input.persistedBackendSessionId,
  });
  yield { kind: "assistant_message", text: RETRY_NOTICE, final: false };
  await input.clearPersisted();
  const retryInput: RunInput = {
    ...input.runInput,
    session: { ...input.runInput.session, backendSessionId: null },
  };
  // Second attempt is a pure pass-through: one replay only.
  for await (const retryEvent of input.run(retryInput)) {
    yield retryEvent;
  }
}
