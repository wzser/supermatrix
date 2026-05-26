import type { CardId, LarkGroupId } from "../../../src/domain/ids.ts";
import { asCardId, asLarkGroupId } from "../../../src/domain/ids.ts";
import type {
  CreateGroupInput,
  InboundHandler,
  InboundMessage,
  LarkGateway,
} from "../../../src/ports/LarkGateway.ts";

export type E2ELarkHarness = {
  gateway: LarkGateway;
  sent: Array<{ groupId: string; text: string }>;
  cards: Array<{ id: string; body: string; status: "streaming" | "final" }>;
  createdGroups: string[];
  createdGroupNames: string[];
  dissolvedGroups: string[];
  emitInbound(msg: InboundMessage): Promise<void>;
};

export function makeE2eLark(): E2ELarkHarness {
  const sent: E2ELarkHarness["sent"] = [];
  const cards: E2ELarkHarness["cards"] = [];
  const createdGroups: string[] = [];
  const createdGroupNames: string[] = [];
  const dissolvedGroups: string[] = [];
  let cardSeq = 0;
  let groupSeq = 0;
  let handler: InboundHandler | undefined;

  const gateway: LarkGateway = {
    async start(h: InboundHandler) { handler = h; },
    async stop() { handler = undefined; },
    async sendMessage(groupId: LarkGroupId, text: string) {
      sent.push({ groupId, text });
    },
    async postCard(_groupId: LarkGroupId, initialText: string, _title: string): Promise<CardId> {
      cardSeq += 1;
      const id = `card_${cardSeq}`;
      cards.push({ id, body: initialText, status: "streaming" });
      return asCardId(id);
    },
    async updateCard(cardId: CardId, text: string, _title: string) {
      const c = cards.find((c) => c.id === cardId);
      if (c) c.body = text;
    },
    async finalizeCard(cardId: CardId, text: string, _title: string) {
      const c = cards.find((c) => c.id === cardId);
      if (c) {
        c.body = text;
        c.status = "final";
      }
    },
    async createGroup(input: CreateGroupInput): Promise<LarkGroupId> {
      groupSeq += 1;
      const id = `oc_${input.name}_${groupSeq}`;
      createdGroups.push(id);
      createdGroupNames.push(input.name);
      return asLarkGroupId(id);
    },
    async inviteUser(_groupId: LarkGroupId, _userId: string) {
      void _groupId;
      void _userId;
    },
    async dissolveGroup(groupId: LarkGroupId) {
      dissolvedGroups.push(groupId);
    },
    async renameGroup(_groupId: LarkGroupId, _name: string) {},
    async getGroupName(_groupId: LarkGroupId) {
      return "";
    },
  };

  return {
    gateway,
    sent,
    cards,
    createdGroups,
    createdGroupNames,
    dissolvedGroups,
    async emitInbound(msg: InboundMessage) {
      if (!handler) throw new Error("gateway not started");
      await handler(msg);
    },
  };
}
