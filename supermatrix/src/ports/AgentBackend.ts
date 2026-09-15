import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type {
  AbsolutePath,
  MessageRunId,
  SessionId,
  Timestamp,
} from "../domain/ids.ts";
import type { BackendKind, Session } from "../domain/session.ts";
import type { RunExecutionConfig } from "./RunExecutionConfig.ts";

export type AttachmentRef = {
  kind: "image" | "file";
  localPath: AbsolutePath;
  originalName: string;
  mimeType?: string | undefined;
  uploadedAt: Timestamp;
};

export type SteerInput = {
  sessionId: SessionId;
  expectedMessageRunId: MessageRunId;
  text: string;
};

export type SteerResult = {
  accepted: true;
  backendTurnId?: string;
};

/**
 * steer() refused because the turn's injection window is already closed —
 * the terminal result was seen, or the run was cancelled / timed out / exited.
 *
 * This is structurally distinct from a transport or protocol failure: the text
 * definitively did NOT enter the turn, and it never will for this run. The
 * window can close well before the run row flips away from `running` (claude
 * closes stdin on the terminal result while the child keeps working), so
 * callers cannot infer this state from the persisted run status and must not
 * render it as a generic "注入失败" that invites a blind retry.
 */
export class SteerWindowClosedError extends Error {
  readonly backend: BackendKind;

  constructor(backend: BackendKind, message: string) {
    super(message);
    this.name = "SteerWindowClosedError";
    this.backend = backend;
  }
}

export type RunInput = {
  messageRunId: MessageRunId;
  session: Session;
  /** Immutable execution tuple selected by the dispatcher for this invocation. */
  execution?: RunExecutionConfig | undefined;
  prompt: string;
  attachments?: AttachmentRef[] | undefined;
  systemHint?: string | undefined;
  /** Enforce answer-only execution: no tool use, no writes. Set for 外部 non-owner prompts. */
  answerOnly?: boolean | undefined;
  /** Gate for per-run ask_user MCP injection. Only set when this run has an explicit Lark chat context. */
  cardAskEnabled?: boolean | undefined;
  /** Lark open_chat_id used by ask_user cards when cardAskEnabled is true. */
  cardAskChatId?: string | undefined;
  /** One-run fork mode: resume source id and let the backend create a new conversation id. */
  conversationFork?: {
    sourceBackendSessionId: string;
  } | undefined;
};

export type AgentBackend = {
  readonly kind: BackendKind;
  run(input: RunInput): AsyncIterable<AgentEvent>;
  cancel(sessionId: SessionId): Promise<void>;
  steer?: (input: SteerInput) => Promise<SteerResult>;
};

export type BackendRegistry = {
  get(kind: BackendKind): AgentBackend;
  cancel(sessionId: SessionId): Promise<void>;
};
