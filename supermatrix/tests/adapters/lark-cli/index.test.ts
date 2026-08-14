import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LarkCliGateway } from "../../../src/adapters/lark-cli/index.ts";
import type { LarkSdkClient } from "../../../src/adapters/lark-cli/client.ts";
import type { LarkRawInbound, LarkRawMessage } from "../../../src/adapters/lark-cli/client.ts";
import type { Logger } from "../../../src/ports/Logger.ts";
import {
  asAbsolutePath,
  asCardId,
  asLarkGroupId,
} from "../../../src/domain/ids.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "supermatrix-lark-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function silentLogger(): Logger {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLogger(),
  };
  return l;
}

function makeFake(): LarkSdkClient & {
  sent: Array<{ groupId: string; text: string; identity?: "bot" | "user" }>;
  cards: Map<string, string>;
  created: string[];
  invited: Array<{ groupId: string; userId: string }>;
  dissolved: string[];
  driveContextRequests: unknown[];
  driveReplies: unknown[];
  driveComments: unknown[];
  emit: (raw: LarkRawMessage) => void;
} {
  const sent: Array<{ groupId: string; text: string; identity?: "bot" | "user" }> = [];
  const cards = new Map<string, string>();
  const created: string[] = [];
  const invited: Array<{ groupId: string; userId: string }> = [];
  const dissolved: string[] = [];
  const driveContextRequests: unknown[] = [];
  const driveReplies: unknown[] = [];
  const driveComments: unknown[] = [];
  const subscribers: Array<(raw: LarkRawInbound) => void> = [];
  let cardSeq = 0;

  return {
    sent,
    cards,
    created,
    invited,
    dissolved,
    driveContextRequests,
    driveReplies,
    driveComments,
    emit(raw) {
      for (const fn of subscribers) fn(raw);
    },
    async sendText(groupId, text, identity) {
      sent.push(identity !== undefined ? { groupId, text, identity } : { groupId, text });
    },
    async createGroup(name, _owner) {
      const id = `oc_${name}`;
      created.push(id);
      return asLarkGroupId(id);
    },
    async inviteUser(groupId, userId) {
      invited.push({ groupId, userId });
    },
    async dissolveGroup(groupId) {
      dissolved.push(groupId);
    },
    async postCard(_groupId, initialText, _title) {
      cardSeq += 1;
      const id = `c${cardSeq}`;
      cards.set(id, initialText);
      return asCardId(id);
    },
    async updateCard(cardId, text, _title) {
      cards.set(cardId, text);
    },
    async finalizeCard(cardId, text, _title) {
      cards.set(cardId, text);
    },
    async downloadAttachment(_opts) {},
    async getDriveCommentContext(source) {
      driveContextRequests.push(source);
      return {
        text: "帮我记一下这个风险",
        quote: "被评论的正文",
        threadReplies: ["已有回复"],
      };
    },
    async replyToDriveComment(input) {
      driveReplies.push(input);
    },
    async createDriveComment(input) {
      driveComments.push(input);
    },
    async renameGroup(_groupId, _name) {},
    async getGroupName(_groupId) { return ""; },
    subscribeInbound(cb) {
      subscribers.push(cb);
      return () => {
        const idx = subscribers.indexOf(cb);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
  };
}

describe("LarkCliGateway", () => {
  test("sendMessage forwards to client", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    await gw.sendMessage(asLarkGroupId("oc_1"), "hi");
    expect(fake.sent).toEqual([{ groupId: "oc_1", text: "hi" }]);
  });

  test("sendMessage passes identity through to client", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    await gw.sendMessage(asLarkGroupId("oc_2"), "speaking as user", "user");
    expect(fake.sent).toEqual([{ groupId: "oc_2", text: "speaking as user", identity: "user" }]);
  });

  test("start() forwards inbound events to handler", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const received: Array<{ text: string; origin?: string }> = [];
    await gw.start(async (msg) => {
      const origin = (msg as { origin?: string }).origin;
      received.push(origin === undefined ? { text: msg.text } : { text: msg.text, origin });
    });
    fake.emit({
      messageId: "m1",
      groupId: "oc_1",
      userId: "u1",
      text: "hello",
      attachments: [],
      timestampMs: 1_700_000_000_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([{ text: "hello", origin: "lark_user" }]);
  });

  test("carries referenced message metadata into inbound messages", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const received: unknown[] = [];
    await gw.start(async (msg) => {
      received.push(msg.referencedMessage);
    });
    fake.emit({
      messageId: "m1",
      groupId: "oc_1",
      userId: "u1",
      text: "current",
      attachments: [],
      timestampMs: 1_700_000_000_000,
      referencedMessage: {
        messageId: "m0",
        text: "quoted",
        senderId: "u0",
        senderName: "Alice",
        timestampMs: 1_699_999_999_000,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([
      {
        messageId: "m0",
        text: "quoted",
        senderId: "u0",
        senderName: "Alice",
        timestampMs: 1_699_999_999_000,
      },
    ]);
  });

  test("createGroup / invite / dissolve round-trip", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const groupId = await gw.createGroup({ name: "foo", ownerUserId: "u1" });
    await gw.inviteUser(groupId, "u2");
    await gw.dissolveGroup(groupId);
    expect(fake.created).toEqual(["oc_foo"]);
    expect(fake.invited).toEqual([{ groupId: "oc_foo", userId: "u2" }]);
    expect(fake.dissolved).toEqual(["oc_foo"]);
  });

  test("rejects p2p messages with warning reply", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const received: string[] = [];
    await gw.start(async (msg) => {
      received.push(msg.text);
    });
    fake.emit({
      messageId: "m2",
      groupId: "oc_p2p_123",
      userId: "u1",
      text: "/help",
      attachments: [],
      timestampMs: 1_700_000_000_000,
      chatType: "p2p",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([]);
    expect(fake.sent).toEqual([
      { groupId: "oc_p2p_123", text: "⚠️ 私聊不可用，请在对应的群组中使用命令" },
    ]);
  });

  test("allows group messages through", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const received: string[] = [];
    await gw.start(async (msg) => {
      received.push(msg.text);
    });
    fake.emit({
      messageId: "m3",
      groupId: "oc_1",
      userId: "u1",
      text: "hello",
      attachments: [],
      timestampMs: 1_700_000_000_000,
      chatType: "group",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual(["hello"]);
    expect(fake.sent).toEqual([]);
  });

  test("routes drive comment raw events to the dedicated handler", async () => {
    const fake = makeFake();
    const driveComments: unknown[] = [];
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
      driveCommentHandler: async (source) => {
        driveComments.push(source);
      },
    });
    const inbound: string[] = [];
    await gw.start(async (msg) => {
      inbound.push(msg.text);
    });
    fake.emit({
      kind: "drive_comment",
      source: {
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
      },
    } as any);
    await new Promise((r) => setTimeout(r, 10));
    expect(inbound).toEqual([]);
    expect(driveComments).toEqual([
      {
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
      },
    ]);
  });

  test("delegates drive comment context and reply operations to the client", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const source = {
      kind: "drive_comment" as const,
      eventId: "evt_2",
      fileToken: "doc_token",
      fileType: "docx" as const,
      commentId: "comment_2",
    };

    await expect(gw.getDriveCommentContext(source)).resolves.toEqual({
      text: "帮我记一下这个风险",
      quote: "被评论的正文",
      threadReplies: ["已有回复"],
    });
    await gw.replyToDriveComment({ source, text: "已记录" });
    await gw.createDriveComment({ source, text: "已新建回复", mentionUserId: "ou_user" });

    expect(fake.driveContextRequests).toEqual([source]);
    expect(fake.driveReplies).toEqual([{ source, text: "已记录" }]);
    expect(fake.driveComments).toEqual([{ source, text: "已新建回复", mentionUserId: "ou_user" }]);
  });

  test("card lifecycle", async () => {
    const fake = makeFake();
    const gw = new LarkCliGateway({
      client: fake,
      attachmentDir: () => asAbsolutePath(dir),
      logger: silentLogger(),
    });
    const cid = await gw.postCard(asLarkGroupId("oc_1"), "start", "test · running");
    await gw.updateCard(cid, "middle", "test · running");
    await gw.finalizeCard(cid, "done", "test · done");
    expect(fake.cards.get(cid)).toBe("done");
  });
});
