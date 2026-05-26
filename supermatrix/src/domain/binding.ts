import type { LarkGroupId, SessionId, Timestamp } from "./ids.ts";

export type Binding = {
  groupId: LarkGroupId;
  sessionId: SessionId;
  createdAt: Timestamp;
};
