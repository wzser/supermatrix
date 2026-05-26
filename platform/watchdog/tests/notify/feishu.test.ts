import { describe, it, expect, vi } from "vitest";
import { createNotifier } from "../../src/notify/feishu.js";
import type { NotifyClient } from "../../src/notify/console.js";

function mockClient(): NotifyClient & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn().mockResolvedValue({ messageId: "om_test" });
  return { notify };
}

describe("Notifier", () => {
  it("sends completion notification via /api/notify with issue details", async () => {
    const client = mockClient();
    const notifier = createNotifier({ enabled: true }, client);

    await notifier.notifyDone("Fix scheduler timeout", "Updated config parsing logic");

    expect(client.notify).toHaveBeenCalledOnce();
    const payload = client.notify.mock.calls[0][0];
    expect(payload.source).toBe("watchdog");
    expect(payload.title).toContain("Fix scheduler timeout");
    expect(payload.body).toBe("Updated config parsing logic");
    expect(payload.level).toBe("info");
    expect(payload.metadata).toMatchObject({ 问题: "Fix scheduler timeout" });
  });

  it("skips notification when disabled", async () => {
    const client = mockClient();
    const notifier = createNotifier({ enabled: false }, client);

    await notifier.notifyDone("Test", "result");

    expect(client.notify).not.toHaveBeenCalled();
  });

  it("does not throw when notification fails", async () => {
    const client: NotifyClient = {
      notify: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const notifier = createNotifier({ enabled: true }, client);

    await expect(notifier.notifyDone("Test", "result")).resolves.toBeUndefined();
  });

  it("falls back to placeholder body when result is empty", async () => {
    const client = mockClient();
    const notifier = createNotifier({ enabled: true }, client);

    await notifier.notifyDone("Issue", "");

    const payload = client.notify.mock.calls[0][0];
    expect(payload.body).toBe("(无补充说明)");
  });

  it("does not retry when response is degraded (message already sent as text)", async () => {
    const client: NotifyClient = {
      notify: vi.fn().mockResolvedValue({
        messageId: "om_degraded",
        degraded: true,
        error: "card render failed",
      }),
    };
    const notifier = createNotifier({ enabled: true }, client);

    await notifier.notifyDone("Issue", "result");

    expect(client.notify).toHaveBeenCalledTimes(1);
  });
});
