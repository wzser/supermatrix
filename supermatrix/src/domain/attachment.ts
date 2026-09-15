import type { AbsolutePath, SessionId, Timestamp } from "./ids.ts";

export type AttachmentKind = "image" | "file";

export type AttachmentRef = {
  id: string;
  sessionId: SessionId;
  kind: AttachmentKind;
  localPath: AbsolutePath;
  originalName: string;
  mimeType?: string | undefined;
  uploadedAt: Timestamp;
};
