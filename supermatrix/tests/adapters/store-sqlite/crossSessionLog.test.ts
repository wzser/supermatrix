import { describe, expect, test } from "vitest";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/cross-session-log"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore cross_session_log", () => {
  test("persists client_request_id on new comm rows", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSession({ id: asSessionId("sess_caller"), name: "caller", ...BASE });
      await store.createSession({ id: asSessionId("sess_target"), name: "target", ...BASE });

      await store.logCrossSessionComm({
        id: "comm_client_request_1",
        fromSessionId: asSessionId("sess_caller"),
        toSessionId: asSessionId("sess_target"),
        kind: "spawn",
        prompt: "do work",
        clientRequestId: "biz-request-store-123",
        createdAt: asTimestamp(1_700_000_100_000),
      } as Parameters<typeof store.logCrossSessionComm>[0] & { clientRequestId: string });

      const rows = await store.listAllCrossSessionComms();
      expect(rows).toHaveLength(1);
      expect((rows[0] as { clientRequestId?: string | null }).clientRequestId).toBe("biz-request-store-123");
    } finally {
      await cleanup();
    }
  });
});
