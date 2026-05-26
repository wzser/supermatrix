import { describe, expect, test } from "vitest";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "foo",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/foo"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore bindings", () => {
  test("createSessionWithBinding creates both atomically", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const out = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      expect(out.session.id).toBe("s1");
      expect(out.binding.groupId).toBe("oc_1");
      expect(out.binding.sessionId).toBe("s1");
      const found = await store.findByGroup(asLarkGroupId("oc_1"));
      expect(found?.sessionId).toBe("s1");
    } finally {
      await cleanup();
    }
  });

  test("createSessionWithBinding rolls back if binding conflicts", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await expect(
        store.createSessionWithBinding(
          { id: asSessionId("s2"), ...BASE, name: "bar" },
          asLarkGroupId("oc_1")
        )
      ).rejects.toThrow();
      expect(await store.findSessionByName("bar")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("deleteSessionAndBinding soft-deletes session and removes binding", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const { session } = await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.deleteSessionAndBinding(session.id);
      const after = await store.findSessionById(session.id);
      expect(after?.status).toBe("deleted");
      expect(await store.findByGroup(asLarkGroupId("oc_1"))).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
