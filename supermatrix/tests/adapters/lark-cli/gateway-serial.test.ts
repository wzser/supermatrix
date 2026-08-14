import { describe, it, expect } from "vitest";
import { LarkCliGateway } from "../../../src/adapters/lark-cli/index.ts";
import type { LarkSdkClient } from "../../../src/adapters/lark-cli/client.ts";
import type { LarkRawMessage } from "../../../src/adapters/lark-cli/client.ts";
import type { Logger } from "../../../src/ports/Logger.ts";
import { asAbsolutePath } from "../../../src/domain/ids.ts";

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

describe("LarkCliGateway message concurrency", () => {
  it("processes messages for different groups concurrently, not serially", async () => {
    const order: string[] = [];
    const subscribers: Array<(raw: LarkRawMessage) => void> = [];

    const client: Pick<LarkSdkClient, "sendText" | "subscribeInbound" | "downloadAttachment"> & Record<string, any> = {
      subscribeInbound(cb: (raw: LarkRawMessage) => void) {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
      async sendText() {},
      async createGroup() { return "" as any; },
      async inviteUser() {},
      async dissolveGroup() {},
      async postCard() { return "" as any; },
      async updateCard() {},
      async finalizeCard() {},
      async downloadAttachment() {},
    };

    const gw = new LarkCliGateway({
      client: client as any,
      logger: silentLogger(),
      attachmentDir: () => asAbsolutePath("/tmp"),
    });

    const handler = async (msg: any) => {
      order.push(`start:${msg.text}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${msg.text}`);
    };

    await gw.start(handler);

    for (const sub of subscribers) {
      sub({
        groupId: "oc_g1",
        userId: "u1",
        text: "first",
        messageId: "m1",
        timestampMs: 1,
        attachments: [],
        chatType: "group",
      });
    }
    for (const sub of subscribers) {
      sub({
        groupId: "oc_g2",
        userId: "u2",
        text: "second",
        messageId: "m2",
        timestampMs: 2,
        attachments: [],
        chatType: "group",
      });
    }

    await new Promise((r) => setTimeout(r, 100));

    // Concurrent: both start before either ends
    expect(order).toEqual([
      "start:first",
      "start:second",
      "end:first",
      "end:second",
    ]);
  });

  it("stop() waits for in-flight handlers to complete", async () => {
    const completed: string[] = [];
    const subscribers: Array<(raw: LarkRawMessage) => void> = [];

    const client: Pick<LarkSdkClient, "sendText" | "subscribeInbound" | "downloadAttachment"> & Record<string, any> = {
      subscribeInbound(cb: (raw: LarkRawMessage) => void) {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
      async sendText() {},
      async downloadAttachment() {},
    };

    const gw = new LarkCliGateway({
      client: client as any,
      logger: silentLogger(),
      attachmentDir: () => asAbsolutePath("/tmp"),
    });

    await gw.start(async (msg) => {
      await new Promise((r) => setTimeout(r, 30));
      completed.push(msg.text);
    });

    for (const sub of subscribers) {
      sub({
        groupId: "oc_g1",
        userId: "u1",
        text: "inflight",
        messageId: "m1",
        timestampMs: 1,
        attachments: [],
        chatType: "group",
      });
    }

    // stop() should wait for in-flight handler
    await gw.stop();
    expect(completed).toEqual(["inflight"]);
  });
});
