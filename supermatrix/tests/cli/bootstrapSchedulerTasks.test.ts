import { afterEach, describe, expect, test, vi } from "vitest";
import type { ScheduledTaskReviewRequest } from "../../src/app/commands/setBackend.ts";
import { createScheduledTaskLister, createScheduledTaskReviewRequester } from "../../src/cli/bootstrap.ts";

describe("createScheduledTaskLister", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["SM_SCHEDULER_BASE_URL"];
    delete process.env["SM_SCHEDULER_HEALTH_URL"];
  });

  test("lists scheduler v2 tasks by owner field and body.prompt", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
          {
            id: "task-1",
            name: "policeman-daily-metapatrol",
            owner: "policeman",
            ownerSession: "",
          cron: "0 21 * * *",
          config: { body: { prompt: "run daily metapatrol" } },
        },
        {
          id: "task-2",
          name: "other-task",
          owner: "other",
          cron: "0 8 * * *",
          description: "ignore me",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const warn = vi.fn();
    const list = createScheduledTaskLister({ warn });
    await expect(list("policeman")).resolves.toEqual([
      {
        id: "policeman-daily-metapatrol",
        cronExpression: "0 21 * * *",
        prompt: "run daily metapatrol",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3502/tasks?enabled=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps compatibility with legacy ownerSession and body.text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            id: "legacy-task",
            ownerSession: "foo",
            cron: "*/5 * * * *",
            config: { body: { text: "legacy prompt text" } },
          },
        ],
      })),
    );

    const list = createScheduledTaskLister({ warn: vi.fn() });
    await expect(list("foo")).resolves.toEqual([
      {
        id: "legacy-task",
        cronExpression: "*/5 * * * *",
        prompt: "legacy prompt text",
      },
    ]);
  });
});

describe("createScheduledTaskReviewRequester", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("spawns scheduler asynchronously with a task-preserving review request", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const requestReview = createScheduledTaskReviewRequester({
      apiBase: "http://127.0.0.1:3501/",
    });

    await requestReview({
      sessionName: "ad-adjust",
      previousBackend: "claude",
      newBackend: "codex",
      backendSwitchAuditId: "cfg_review-1",
      backendSwitchAuditCreatedAt: Date.parse("2026-07-14T08:00:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3501/api/spawn2.0",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: expect.any(AbortSignal),
        body: expect.any(String),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeTypeOf("string");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      from: "supermatrix-root",
      target: "scheduler",
      client_request_id: "2026-07-14:backend-switch-task-review:ad-adjust:cfg_review-1",
      closure: { kind: "message", target: { type: "todo_pool" } },
    });
    expect(body.prompt).toContain("Session: ad-adjust");
    expect(body.prompt).toContain("Transition: claude -> codex");
    expect(body.prompt).toContain("Review only enabled scheduler v2 tasks whose owner exactly equals the session name");
    expect(body.prompt).toContain("Do not infer ownership from target, model, or prompt text");
    expect(body.prompt).toContain("Preserve cron, owner, type, closure, timeout");
    expect(body.prompt).toContain("Do not change target or model to bypass");
  });

  test("surfaces non-successful spawn responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "unavailable" })));
    const requestReview = createScheduledTaskReviewRequester({
      apiBase: "http://127.0.0.1:3501",
    });

    await expect(requestReview({
      sessionName: "ad-adjust",
      previousBackend: "claude",
      newBackend: "codex",
      backendSwitchAuditId: "cfg_review-2",
      backendSwitchAuditCreatedAt: Date.parse("2026-07-14T08:00:00.000Z"),
    }))
      .rejects.toThrow("scheduler review spawn failed: HTTP 503 unavailable");
  });

  test("reuses the committed backend-switch audit id for transport retries", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const requestReview = createScheduledTaskReviewRequester({
      apiBase: "http://127.0.0.1:3501",
    });
    const request: ScheduledTaskReviewRequest = {
      sessionName: "ad-adjust",
      previousBackend: "claude",
      newBackend: "codex",
      backendSwitchAuditId: "cfg_switch-1",
      backendSwitchAuditCreatedAt: Date.parse("2026-07-14T23:59:58.000Z"),
    };

    await requestReview(request);
    await requestReview(request);

    const clientRequestIds = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(init.body as string).client_request_id as string;
    });
    expect(clientRequestIds).toEqual([
      "2026-07-14:backend-switch-task-review:ad-adjust:cfg_switch-1",
      "2026-07-14:backend-switch-task-review:ad-adjust:cfg_switch-1",
    ]);
  });
});
