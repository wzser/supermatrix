import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteBindingStore } from "../../../src/adapters/store-sqlite/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";

describe("SqliteBindingStore workspace lock", () => {
  it("defaults new sessions to unlocked and preserves lock toggles across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-workspace-lock-"));
    const dbPath = join(dir, "console.db");
    try {
      const sessionId = asSessionId("sess_lock");
      const first = new SqliteBindingStore(dbPath);
      await first.init();
      try {
        await first.createSession({
          id: sessionId,
          name: "lock-test",
          scope: "user",
          backend: "claude",
          workdir: asAbsolutePath("/tmp/lock-test"),
          purpose: "workspace lock test",
          createdAt: asTimestamp(1_700_000_000_000),
        });

        await expect(first.getSessionWorkspaceLocked(sessionId)).resolves.toBe(false);
        await first.updateSessionWorkspaceLocked(sessionId, true);
      } finally {
        await first.close();
      }

      const second = new SqliteBindingStore(dbPath);
      await second.init();
      try {
        await expect(second.getSessionWorkspaceLocked(sessionId)).resolves.toBe(true);
        await second.updateSessionWorkspaceLocked(sessionId, false);
      } finally {
        await second.close();
      }

      const third = new SqliteBindingStore(dbPath);
      await third.init();
      try {
        await expect(third.getSessionWorkspaceLocked(sessionId)).resolves.toBe(false);
      } finally {
        await third.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
