import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { AbsolutePath, SessionId, Timestamp } from "../domain/ids.ts";
import type { BackendKind, Session } from "../domain/session.ts";

export type AttachmentRef = {
  kind: "image" | "file";
  localPath: AbsolutePath;
  originalName: string;
  mimeType?: string | undefined;
  uploadedAt: Timestamp;
};

export type RunInput = {
  session: Session;
  prompt: string;
  attachments?: AttachmentRef[] | undefined;
  systemHint?: string | undefined;
  /** Enforce answer-only execution: no tool use, no writes. Set for 外部 non-owner prompts. */
  answerOnly?: boolean | undefined;
};

export type AgentBackend = {
  readonly kind: BackendKind;
  run(input: RunInput): AsyncIterable<AgentEvent>;
  cancel(sessionId: SessionId): Promise<void>;
};

export type BackendRegistry = {
  get(kind: BackendKind): AgentBackend;
  cancel(sessionId: SessionId): Promise<void>;
};
