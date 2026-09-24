import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

const CONTROLLER_TOKEN = "controller-secret-for-claude-maintenance-tests";
const LEASE_TOKEN = "lease-token-for-one-claude-switch-test-0001";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

function makeDeps(store: ReturnType<typeof createFakeBindingStore>): ApiDeps {
  return {
    store,
    childSession: {
      async spawnChild() {
        throw new Error("childSession should not be called by maintenance lease API tests");
      },
    },
    runOnSession: async () => {
      throw new Error("runOnSession should not be called by maintenance lease API tests");
    },
    notifier: {
      async notify() {
        throw new Error("notifier should not be called by maintenance lease API tests");
      },
    } as ApiDeps["notifier"],
    logger: logger as ApiDeps["logger"],
  };
}

describe("Claude maintenance lease API", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let store: ReturnType<typeof createFakeBindingStore>;
  let previousControllerToken: string | undefined;

  beforeEach(async () => {
    previousControllerToken = process.env.SM_CLAUDE_MAINTENANCE_TOKEN;
    process.env.SM_CLAUDE_MAINTENANCE_TOKEN = CONTROLLER_TOKEN;
    store = createFakeBindingStore();
    server = await startApiServer(makeDeps(store), 0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousControllerToken === undefined) {
      delete process.env.SM_CLAUDE_MAINTENANCE_TOKEN;
    } else {
      process.env.SM_CLAUDE_MAINTENANCE_TOKEN = previousControllerToken;
    }
  });

  async function post(
    path: "acquire" | "release",
    body: Record<string, unknown>,
    authorization: "valid" | "missing" | "wrong" = "valid",
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authorization === "valid") headers.Authorization = `Bearer ${CONTROLLER_TOKEN}`;
    if (authorization === "wrong") headers.Authorization = "Bearer wrong-controller-token";
    return fetch(`${baseUrl}/api/backends/claude/maintenance/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function get(
    authorization: "valid" | "missing" | "wrong" = "valid",
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (authorization === "valid") headers.Authorization = `Bearer ${CONTROLLER_TOKEN}`;
    if (authorization === "wrong") headers.Authorization = "Bearer wrong-controller-token";
    return fetch(`${baseUrl}/api/backends/claude/maintenance/status`, {
      method: "GET",
      headers,
    });
  }

  function requestBody(clientRequestId = "2026-08-05:sm-switch:claude:lease-test") {
    return {
      client_request_id: clientRequestId,
      lease_token: LEASE_TOKEN,
    };
  }

  test("requires the dedicated controller bearer and strict request shape", async () => {
    await expect(post("acquire", requestBody(), "missing")).resolves.toMatchObject({ status: 401 });
    await expect(post("acquire", requestBody(), "wrong")).resolves.toMatchObject({ status: 403 });
    await expect(post("acquire", { ...requestBody(), owner: "pretend-owner" })).resolves.toMatchObject({ status: 400 });
    expect(await store.listBackendMaintenanceLeaseEvents("claude")).toEqual([]);
  });

  test("status is bearer-protected, read-only, and exposes only redacted lease metadata", async () => {
    const missing = await get("missing");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ ok: false, error: "missing_bearer_token" });

    const wrong = await get("wrong");
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toEqual({ ok: false, error: "invalid_bearer_token" });

    const idle = await get();
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({
      ok: true,
      backend: "claude",
      state: "idle",
    });
    expect(await store.listBackendMaintenanceLeaseEvents("claude")).toEqual([]);

    const acquired = await post("acquire", requestBody());
    expect(acquired.status).toBe(200);
    const eventsBeforeStatus = await store.listBackendMaintenanceLeaseEvents("claude");
    const acquireLease = store.acquireBackendMaintenanceLease.bind(store);
    const releaseLease = store.releaseBackendMaintenanceLease.bind(store);
    let acquireCalls = 0;
    let releaseCalls = 0;
    store.acquireBackendMaintenanceLease = async (input) => {
      acquireCalls += 1;
      return acquireLease(input);
    };
    store.releaseBackendMaintenanceLease = async (input) => {
      releaseCalls += 1;
      return releaseLease(input);
    };

    const held = await get();
    expect(held.status).toBe(200);
    const heldBody = await held.json();
    expect(heldBody).toEqual({
      ok: true,
      backend: "claude",
      state: "held",
      lease: {
        owner: "sm-switch",
        requestId: "2026-08-05:sm-switch:claude:lease-test",
        acquiredAt: expect.any(Number),
      },
    });
    expect(JSON.stringify(heldBody)).not.toContain(LEASE_TOKEN);
    expect(acquireCalls).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(await store.listBackendMaintenanceLeaseEvents("claude")).toEqual(eventsBeforeStatus);
  });

  test("acquire/release are idempotent, owner-bound, auditable, and never echo the opaque token", async () => {
    const acquired = await post("acquire", requestBody());
    expect(acquired.status).toBe(200);
    const acquiredBody = await acquired.json() as {
      ok: boolean;
      backend: string;
      state: string;
      duplicate: boolean;
      lease: { owner: string; requestId: string; acquiredAt: number };
    };
    expect(acquiredBody).toMatchObject({
      ok: true,
      backend: "claude",
      state: "acquired",
      duplicate: false,
      lease: { owner: "sm-switch", requestId: "2026-08-05:sm-switch:claude:lease-test" },
    });
    expect(JSON.stringify(acquiredBody)).not.toContain(LEASE_TOKEN);

    const duplicate = await post("acquire", requestBody("2026-08-05:sm-switch:claude:retry"));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      state: "acquired",
      duplicate: true,
      lease: { owner: "sm-switch", requestId: "2026-08-05:sm-switch:claude:lease-test" },
    });

    const held = await post("acquire", {
      client_request_id: "2026-08-05:sm-switch:claude:other-token",
      lease_token: "other-opaque-lease-token-for-claude-test-0002",
    });
    expect(held.status).toBe(409);
    await expect(held.json()).resolves.toMatchObject({
      ok: false,
      error: "claude_maintenance_lease_held",
      lease: { owner: "sm-switch" },
    });

    const wrongRelease = await post("release", {
      client_request_id: "2026-08-05:sm-switch:claude:wrong-release",
      lease_token: "other-opaque-lease-token-for-claude-test-0002",
    });
    expect(wrongRelease.status).toBe(409);
    await expect(wrongRelease.json()).resolves.toMatchObject({
      ok: false,
      error: "claude_maintenance_lease_token_mismatch",
    });

    const released = await post("release", requestBody("2026-08-05:sm-switch:claude:release"));
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({
      ok: true,
      backend: "claude",
      state: "released",
      duplicate: false,
    });
    const duplicateRelease = await post("release", requestBody("2026-08-05:sm-switch:claude:release-retry"));
    expect(duplicateRelease.status).toBe(200);
    await expect(duplicateRelease.json()).resolves.toEqual({
      ok: true,
      backend: "claude",
      state: "released",
      duplicate: true,
    });

    const events = await store.listBackendMaintenanceLeaseEvents("claude");
    expect(events.map((event) => event.outcome)).toEqual([
      "not_held",
      "released",
      "token_mismatch",
      "held",
      "duplicate",
      "acquired",
    ]);
    expect(JSON.stringify(events)).not.toContain(LEASE_TOKEN);
  });

  test("acquire refuses actual running Claude message_runs, not a session busy count", async () => {
    const session = await store.createSession({
      id: asSessionId("sess_claude_running"),
      name: "claude-running",
      scope: "user",
      backend: "claude",
      workdir: asAbsolutePath("/tmp/claude-running"),
      purpose: "API lease test",
      createdAt: asTimestamp(1),
    });
    await store.admitMessageRun({
      id: asMessageRunId("mr_claude_running"),
      sessionId: session.id,
      groupId: asLarkGroupId("oc_claude_running"),
      prompt: "running",
      startedAt: asTimestamp(2),
    });

    const response = await post("acquire", requestBody("2026-08-05:sm-switch:claude:drain-check"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "claude_runs_in_flight",
      backend: "claude",
      runningMessageRuns: 1,
    });
  });

  test("storage failures return an error and never report a lease as acquired", async () => {
    store.acquireBackendMaintenanceLease = async () => {
      throw new Error("maintenance lease storage unavailable");
    };

    const response = await post("acquire", requestBody("2026-08-05:sm-switch:claude:storage-error"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "claude_maintenance_store_unavailable",
    });
  });
});
