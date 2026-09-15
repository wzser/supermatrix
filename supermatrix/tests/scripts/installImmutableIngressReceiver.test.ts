import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import { installImmutableIngressReceiver, HDQ_RECEIVER_DECLARATION } from "../../scripts/install-immutable-ingress-receiver.ts";
import { createTempStore } from "../adapters/store-sqlite/helpers.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedSessions(store: Awaited<ReturnType<typeof createTempStore>>["store"], targetPayload?: string | null, wcaPayload?: string | null): Promise<void> {
  await store.createSession({
    id: asSessionId("sess_hdq_receiver"),
    name: "huodaiduijie",
    scope: "user",
    backend: "claude",
    workdir: asAbsolutePath("/tmp/huodaiduijie"),
    purpose: "test receiver",
    createdAt: asTimestamp(1),
    capabilityPayload: targetPayload === undefined ? null : JSON.parse(targetPayload ?? "null"),
  });
  await store.createSession({
    id: asSessionId("sess_wca_sender"),
    name: "private_workflow_6d0060b18f1258cc",
    scope: "user",
    backend: "claude",
    workdir: asAbsolutePath("/tmp/private_workflow_6d0060b18f1258cc"),
    purpose: "test sender",
    createdAt: asTimestamp(1),
    capabilityPayload: wcaPayload === undefined ? null : JSON.parse(wcaPayload ?? "null"),
  });
}

describe("install immutable ingress receiver", () => {
  test("installs the tracked HDQ declaration, preserves existing capabilities, and leaves WCA undeclared", async () => {
    const fixture = await createTempStore();
    try {
      await seedSessions(fixture.store, JSON.stringify({ resultSinks: [{ kind: "audit_only" }], eventBusContract: { subscribe: "topic", subscribeGatesCompletion: false } }));
      const receipt = installImmutableIngressReceiver({ db: fixture.store.db, operationId: "test-install", sourceCommit: "commit-test", nowMs: 1 });
      expect(receipt.changed).toBe(true);
      expect(receipt.capabilityPayload.resultSinks).toEqual([{ kind: "audit_only" }]);
      expect(receipt.capabilityPayload.eventBusContract).toEqual({ subscribe: "topic", subscribeGatesCompletion: false });
      expect(receipt.capabilityPayload.immutableIngress).toEqual(HDQ_RECEIVER_DECLARATION);
      expect(receipt.nonReceiver.immutableIngressAbsent).toBe(true);
      expect(fixture.store.db.prepare("SELECT capability_payload FROM sessions WHERE name = 'private_workflow_6d0060b18f1258cc'").get()).toEqual({ capability_payload: null });
      const second = installImmutableIngressReceiver({ db: fixture.store.db, operationId: "test-install-again", sourceCommit: "commit-test", nowMs: 2 });
      expect(second.changed).toBe(false);
      expect(second.afterCapabilityPayloadSha256).toBe(receipt.afterCapabilityPayloadSha256);
    } finally {
      await fixture.cleanup();
    }
  });

  test("upgrades the previously installed HDQ declaration to receiver-terminal completion", async () => {
    const fixture = await createTempStore();
    try {
      const { completionMode: _completionMode, ...legacyDeclaration } = HDQ_RECEIVER_DECLARATION;
      await seedSessions(fixture.store, JSON.stringify({ resultSinks: [], immutableIngress: legacyDeclaration }));
      const receipt = installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "test-install-upgrade",
        sourceCommit: "commit-test",
        nowMs: 1,
      });
      expect(receipt.changed).toBe(true);
      expect(receipt.capabilityPayload.immutableIngress).toEqual(HDQ_RECEIVER_DECLARATION);
    } finally {
      await fixture.cleanup();
    }
  });

  test("fails closed for a non-receiver target, invalid existing JSON, and a WCA declaration", async () => {
    const wrongTarget = await createTempStore();
    try {
      await seedSessions(wrongTarget.store);
      expect(() => installImmutableIngressReceiver({ db: wrongTarget.store.db, operationId: "wrong-target", sourceCommit: "test", targetSessionName: "private_workflow_6d0060b18f1258cc" })).toThrow(/WCA is not a receiver/);
    } finally {
      await wrongTarget.cleanup();
    }

    const invalid = await createTempStore();
    try {
      await seedSessions(invalid.store);
      invalid.store.db.prepare("UPDATE sessions SET capability_payload = ? WHERE name = 'huodaiduijie'").run("not-json");
      expect(() => installImmutableIngressReceiver({ db: invalid.store.db, operationId: "invalid", sourceCommit: "test" })).toThrow(/invalid JSON/);
    } finally {
      await invalid.cleanup();
    }

    const wca = await createTempStore();
    try {
      await seedSessions(wca.store, null, JSON.stringify({ resultSinks: [], immutableIngress: HDQ_RECEIVER_DECLARATION }));
      expect(() => installImmutableIngressReceiver({ db: wca.store.db, operationId: "wca", sourceCommit: "test" })).toThrow(/private_workflow_6d0060b18f1258cc.*not a receiver/);
    } finally {
      await wca.cleanup();
    }
  });

  test("rolls back declaration activation when the durable receipt cannot be written", async () => {
    const fixture = await createTempStore();
    const dir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-receipt-failure-"));
    const receiptPath = join(dir, "not-a-directory");
    try {
      await seedSessions(fixture.store);
      await writeFile(receiptPath, "blocking file");
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "receipt-failure",
        sourceCommit: "commit-test",
        receiptDir: receiptPath,
      })).toThrow();
      const target = await fixture.store.findSessionByName("huodaiduijie");
      expect(target?.capabilityPayload?.immutableIngress).toBeUndefined();
    } finally {
      await fixture.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves a recoverable temp receipt when the database transaction fails before commit", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-db-failure-"));
    try {
      await seedSessions(fixture.store);
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "db-before-commit",
        sourceCommit: "commit-test",
        receiptDir,
        beforeReceiptCommit: () => {
          throw new Error("forced database failure before commit");
        },
      })).toThrow(/forced database failure/);
      const target = await fixture.store.findSessionByName("huodaiduijie");
      expect(target?.capabilityPayload?.immutableIngress).toBeUndefined();
      expect(await readdir(receiptDir)).toEqual(["db-before-commit.json.tmp"]);
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "db-before-commit",
        sourceCommit: "commit-test",
        receiptDir,
      })).toThrow(/stale|does not match/u);
      expect(await readdir(receiptDir)).toEqual(["db-before-commit.json.tmp"]);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });

  test("recovers a committed deployment after publication is interrupted without changing receipt content", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-recovery-"));
    try {
      await seedSessions(fixture.store);
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "post-commit-recovery",
        sourceCommit: "commit-test",
        receiptDir,
        publishReceipt: () => {
          throw new Error("publication interrupted after commit");
        },
      })).toThrow(/publication interrupted/);
      const tempBytes = await readFile(join(receiptDir, "post-commit-recovery.json.tmp"), "utf8");
      expect(await readdir(receiptDir)).toEqual(["post-commit-recovery.json.tmp"]);

      const recovered = installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "post-commit-recovery",
        sourceCommit: "different-retry-commit-must-not-rewrite",
        nowMs: 99,
        receiptDir,
      });
      expect(JSON.stringify(recovered, null, 2) + "\n").toBe(tempBytes);
      expect(await readFile(join(receiptDir, "post-commit-recovery.json"), "utf8")).toBe(tempBytes);
      expect(await readdir(receiptDir)).toEqual(["post-commit-recovery.json"]);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });

  test("reuses an existing final receipt only when it matches the committed database state", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-existing-final-"));
    try {
      await seedSessions(fixture.store);
      const first = installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "existing-final",
        sourceCommit: "commit-test",
        nowMs: 1,
        receiptDir,
      });
      const finalPath = join(receiptDir, "existing-final.json");
      const finalBytes = await readFile(finalPath, "utf8");
      const second = installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "existing-final",
        sourceCommit: "different-retry-commit",
        nowMs: 2,
        receiptDir,
      });
      expect(second).toEqual(first);
      expect(await readFile(finalPath, "utf8")).toBe(finalBytes);

      await chmod(finalPath, 0o600);
      await writeFile(finalPath, "{}\n");
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "existing-final",
        sourceCommit: "commit-test",
        receiptDir,
      })).toThrow(/different content|invalid|mismatch|stale/u);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });

  test("rejects a partially tampered final receipt", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-partial-tamper-"));
    try {
      await seedSessions(fixture.store);
      const receipt = installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "partial-tamper",
        sourceCommit: "commit-test",
        receiptDir,
      });
      const finalPath = join(receiptDir, "partial-tamper.json");
      await chmod(finalPath, 0o600);
      await writeFile(finalPath, `${JSON.stringify({
        ...receipt,
        changed: false,
      }, null, 2)}\n`);
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "partial-tamper",
        sourceCommit: "commit-test",
        receiptDir,
      })).toThrow(/stale|does not match/u);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });

  test("rejects staged recovery when the current target lacks the fixed declaration", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-no-declaration-recovery-"));
    try {
      await seedSessions(fixture.store);
      const target = await fixture.store.findSessionByName("huodaiduijie");
      const nonReceiver = await fixture.store.findSessionByName("private_workflow_6d0060b18f1258cc");
      const targetPayload = { resultSinks: [] };
      const targetPayloadSha256 = sha256(JSON.stringify(targetPayload));
      const nonReceiverPayloadSha256 = sha256(JSON.stringify({ resultSinks: [] }));
      const forgedReceipt = {
        schema: "supermatrix-immutable-ingress-deployment/v1",
        operationId: "no-declaration-recovery",
        appliedAt: 1,
        targetSessionName: "huodaiduijie",
        targetSessionId: target!.id,
        changed: false,
        beforeCapabilityPayloadSha256: targetPayloadSha256,
        afterCapabilityPayloadSha256: targetPayloadSha256,
        capabilityPayload: targetPayload,
        nonReceiver: {
          sessionName: "private_workflow_6d0060b18f1258cc",
          sessionId: nonReceiver!.id,
          capabilityPayloadSha256: nonReceiverPayloadSha256,
          unchanged: true,
          immutableIngressAbsent: true,
        },
        source: {
          repository: "SuperMatrix",
          script: "scripts/install-immutable-ingress-receiver.ts",
          commit: "stale-commit",
          declarationSha256: sha256(JSON.stringify(HDQ_RECEIVER_DECLARATION)),
        },
      };
      await writeFile(
        join(receiptDir, "no-declaration-recovery.json.tmp"),
        `${JSON.stringify(forgedReceipt, null, 2)}\n`,
        { mode: 0o400 },
      );

      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "no-declaration-recovery",
        sourceCommit: "different-retry-commit",
        receiptDir,
      })).toThrow(/stale|does not match/u);
      expect(await readdir(receiptDir)).toEqual(["no-declaration-recovery.json.tmp"]);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });

  test("fails closed when an idempotent declaration is mutated during readback", async () => {
    const fixture = await createTempStore();
    const receiptDir = await mkdtemp(join(tmpdir(), "sm-immutable-installer-cas-conflict-"));
    try {
      await seedSessions(fixture.store, JSON.stringify({ resultSinks: [], immutableIngress: HDQ_RECEIVER_DECLARATION }));
      fixture.store.db.exec(`
        CREATE TRIGGER mutate_immutable_ingress AFTER UPDATE OF capability_payload ON sessions
        WHEN NEW.name = 'huodaiduijie'
        BEGIN
          UPDATE sessions SET capability_payload = '{"resultSinks":[]}' WHERE id = NEW.id;
        END;
      `);
      expect(() => installImmutableIngressReceiver({
        db: fixture.store.db,
        operationId: "idempotent-cas-conflict",
        sourceCommit: "commit-test",
        receiptDir,
      })).toThrow(/readback|concurrently/);
      expect(await readdir(receiptDir)).toEqual([]);
      const row = fixture.store.db.prepare("SELECT capability_payload FROM sessions WHERE name = 'huodaiduijie'").get() as { capability_payload: string };
      expect(JSON.parse(row.capability_payload).immutableIngress).toEqual(HDQ_RECEIVER_DECLARATION);
    } finally {
      await fixture.cleanup();
      await rm(receiptDir, { recursive: true, force: true });
    }
  });
});
