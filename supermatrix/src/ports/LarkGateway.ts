import type { AbsolutePath, CardId, LarkGroupId } from "../domain/ids.ts";
import type { RunStatus } from "./BindingStore.ts";

export type InboundMessage = {
  groupId: LarkGroupId;
  messageId: string;
  userId: string;
  text: string;
  mentionedBot?: boolean;
  attachments: InboundAttachment[];
  receivedAtMs: number;
};

export type InboundAttachment = {
  kind: "image" | "file";
  originalName: string;
  mimeType?: string | undefined;
  fetch(): Promise<{ localPath: AbsolutePath }>;
};

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

export type CreateGroupInput = {
  name: string;
  ownerUserId: string;
};

/** Whose identity Lark should attribute the outbound message to. */
export type LarkPostIdentity = "bot" | "user";

export type LarkGateway = {
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  /**
   * Post a plain text message to `groupId`. When `identity` is omitted the
   * message is sent as the bot (historical behavior). `user` identity routes
   * through the user-scoped lark-cli path and makes the message appear as
   * if the human operator posted it — used by the `user_voice_reporter`
   * child type to drive follow-up actions from a human perspective.
   */
  sendMessage(groupId: LarkGroupId, text: string, identity?: LarkPostIdentity): Promise<void>;
  postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<CardId>;
  updateCard(cardId: CardId, text: string, title: string): Promise<void>;
  /**
   * `processLog`, when provided, is rendered inside a collapsed panel below
   * the main text so the streaming trace stays accessible after the card
   * turns green/red. Pass `undefined` to finalize without the panel.
   *
   * `runStatus` — when provided — is the authoritative signal for card
   * header template (completed → green, timeout/failed → red, cancelled →
   * grey). Without it, the adapter falls back to sniffing the text for a
   * leading ❌, which misreports a run whose final body *starts with* a
   * non-error character but whose terminal status is timeout/cancelled.
   */
  finalizeCard(
    cardId: CardId,
    text: string,
    title: string,
    processLog?: string,
    runStatus?: RunStatus,
  ): Promise<void>;
  createGroup(input: CreateGroupInput): Promise<LarkGroupId>;
  inviteUser(groupId: LarkGroupId, userId: string): Promise<void>;
  dissolveGroup(groupId: LarkGroupId): Promise<void>;
  renameGroup(groupId: LarkGroupId, name: string): Promise<void>;
  getGroupName(groupId: LarkGroupId): Promise<string>;
};
