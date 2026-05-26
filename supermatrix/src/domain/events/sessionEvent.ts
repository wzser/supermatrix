import type { SessionId } from "../ids.ts";
import type { Session, SessionStatus } from "../session.ts";

export type SessionEvent =
  | { kind: "session_created"; session: Session }
  | { kind: "session_deleted"; sessionId: SessionId }
  | {
      kind: "session_status_changed";
      sessionId: SessionId;
      from: SessionStatus;
      to: SessionStatus;
    }
  | {
      // The global session-catalog.json was regenerated. There is one
      // catalog for the whole fleet, so this event carries no sessionId —
      // it fires once per regeneration, not once per session.
      kind: "catalog_updated";
      reason: string;
    }
  | {
      kind: "message_to_session";
      from: SessionId;
      to: SessionId;
      payload: unknown;
    };
