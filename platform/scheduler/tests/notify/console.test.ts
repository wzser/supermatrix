import { describe, it, expect, vi } from "vitest";
import { createConsoleNotifier } from "../../src/notify/console.js";

const okResponse = () => new Response("{\"messageId\":\"om_test\"}", { status: 200 });

describe("ConsoleNotifier", () => {
  it("POSTs structured payload to /api/notify with source=scheduler", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const notifier = createConsoleNotifier(
      { apiUrl: "http://localhost:3501/api/notify" },
      fetchFn,
    );

    await notifier.notify({
      title: "task done",
      body: "all good",
      level: "info",
      metadata: { duration_s: 12 },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:3501/api/notify");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      source: "scheduler",
      title: "task done",
      body: "all good",
      level: "info",
      metadata: { duration_s: 12 },
    });
  });

  it("notifyFailure maps to level=error with taskName in metadata", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const notifier = createConsoleNotifier(
      { apiUrl: "http://localhost:3501/api/notify" },
      fetchFn,
    );

    await notifier.notifyFailure("fetch-mail", "connection refused", { taskId: "t-1" });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body as string);
    expect(body.level).toBe("error");
    expect(body.title).toContain("fetch-mail");
    expect(body.body).toBe("connection refused");
    expect(body.metadata).toEqual({ taskName: "fetch-mail", taskId: "t-1" });
  });

  it("logs (does not throw) when fetch rejects", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const logger = { error: vi.fn() };
    const notifier = createConsoleNotifier(
      { apiUrl: "http://localhost:3501/api/notify", logger },
      fetchFn,
    );

    await notifier.notifyFailure("test-task", "boom");

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("test-task") }),
      expect.stringContaining("notify"),
    );
  });

  it("logs (does not throw) when API returns non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("{\"error\":\"title: Required\"}", { status: 400 }),
    );
    const logger = { error: vi.fn() };
    const notifier = createConsoleNotifier(
      { apiUrl: "http://localhost:3501/api/notify", logger },
      fetchFn,
    );

    await notifier.notify({ title: "x", body: "y", level: "info" });

    expect(logger.error).toHaveBeenCalledOnce();
  });
});
