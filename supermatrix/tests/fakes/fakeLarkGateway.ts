import type { LarkGroupId } from "../../src/domain/ids.ts";
import { asCardId, asLarkGroupId } from "../../src/domain/ids.ts";
import type { RunStatus } from "../../src/ports/BindingStore.ts";
import type {
  CreateGroupInput,
  InboundHandler,
  LarkGateway,
} from "../../src/ports/LarkGateway.ts";

export type FakeLarkOptions = {
  failCreateGroup?: boolean;
  failInvite?: boolean;
};

export function createFakeLarkGateway(opts: FakeLarkOptions = {}) {
  const sent: Array<{ groupId: string; text: string }> = [];
  const cards = new Map<string, string>();
  const finalized: Array<{
    cardId: string;
    text: string;
    title?: string;
    processLog?: string;
    runStatus?: RunStatus;
  }> = [];
  const titleHistory: Array<{ cardId: string; title: string | undefined }> = [];
  const createdGroups: string[] = [];
  const createdGroupNames: string[] = [];
  const dissolvedGroups: string[] = [];
  let cardSeq = 0;
  let groupSeq = 0;
  let inboundHandler: InboundHandler | undefined;

  const gateway: LarkGateway & {
    sent: typeof sent;
    cards: typeof cards;
    finalized: typeof finalized;
    titleHistory: typeof titleHistory;
    createdGroups: typeof createdGroups;
    createdGroupNames: typeof createdGroupNames;
    dissolvedGroups: typeof dissolvedGroups;
    emit(msg: Parameters<InboundHandler>[0]): Promise<void>;
  } = {
    sent,
    cards,
    finalized,
    titleHistory,
    createdGroups,
    createdGroupNames,
    dissolvedGroups,
    async start(handler: InboundHandler) {
      inboundHandler = handler;
    },
    async stop() {
      inboundHandler = undefined;
    },
    async emit(msg) {
      if (inboundHandler) await inboundHandler(msg);
    },
    async sendMessage(groupId, text) {
      sent.push({ groupId, text });
    },
    async postCard(_groupId, initialText, title) {
      cardSeq += 1;
      const id = `card_${cardSeq}`;
      cards.set(id, initialText);
      titleHistory.push({ cardId: id, title });
      return asCardId(id);
    },
    async updateCard(cardId, text, title) {
      cards.set(cardId, text);
      titleHistory.push({ cardId, title });
    },
    async finalizeCard(cardId, text, title, processLog, runStatus) {
      // Does not overwrite `cards` so intermediate update states stay visible;
      // record into `finalized` so tests can assert on the final payload.
      const entry: {
        cardId: string;
        text: string;
        title?: string;
        processLog?: string;
        runStatus?: RunStatus;
      } = {
        cardId,
        text,
        title,
      };
      if (processLog !== undefined) entry.processLog = processLog;
      if (runStatus !== undefined) entry.runStatus = runStatus;
      finalized.push(entry);
      titleHistory.push({ cardId, title });
    },
    async createGroup(input: CreateGroupInput) {
      if (opts.failCreateGroup) throw new Error("create group failed");
      groupSeq += 1;
      const id = `oc_${groupSeq}`;
      createdGroups.push(id);
      createdGroupNames.push(input.name);
      return asLarkGroupId(id);
    },
    async inviteUser(_groupId, _userId) {
      if (opts.failInvite) throw new Error("invite failed");
    },
    async dissolveGroup(groupId: LarkGroupId) {
      dissolvedGroups.push(groupId);
    },
    async renameGroup(_groupId: LarkGroupId, _name: string) {},
    async getGroupName(_groupId: LarkGroupId) {
      return "";
    },
  };
  return gateway;
}
