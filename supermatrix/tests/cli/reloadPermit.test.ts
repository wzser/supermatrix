import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { consumePlatformReloadPermit } from "../../src/cli/reloadPermit.ts";

const tempDirs: string[] = [];
const NONCE = "smrp_0123456789abcdef0123456789abcdef";

function consumePermit(
  input: Omit<Parameters<typeof consumePlatformReloadPermit>[0], "resolveCallerAttestation">,
) {
  return consumePlatformReloadPermit({
    ...input,
    resolveCallerAttestation: (token) => {
      if (token === "smca_valid_test") {
        return {
          sessionId: "child_codexroot_test",
          messageRunId: "run_codexroot_test",
          sessionName: "child_codexroot_test",
          backend: "codex",
          issuedAt: 900_000,
        };
      }
      if (token === "smca_direct_codexroot_test") {
        return {
          sessionId: "sess_codexroot_test",
          messageRunId: "run_codexroot_direct_test",
          sessionName: "codexroot",
          backend: "codex",
          issuedAt: 900_000,
        };
      }
      if (token === "smca_non_codexroot_child_test") {
        return {
          sessionId: "child_watchdog_test",
          messageRunId: "run_watchdog_test",
          sessionName: "child_watchdog_test",
          backend: "codex",
          issuedAt: 900_000,
        };
      }
      return null;
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function writePermit(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sm-reload-permit-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "supermatrix.db");
  writeFileSync(dbPath, "");
  writeFileSync(
    join(dir, `.supermatrix-reload-permit.${NONCE}.json`),
    JSON.stringify({
      version: 1,
      operation: "reload-supermatrix",
      nonce: NONCE,
      requestedAtMs: 1_000_000,
      source: "codexroot-maintenance",
      force: false,
      actorSessionName: "codexroot",
      callerSessionId: "child_codexroot_test",
      callerAttestationToken: "smca_valid_test",
      ...overrides,
    }),
  );
  return dbPath;
}

describe("consumePlatformReloadPermit", () => {
  test("atomically accepts one exact, fresh child_codexroot owner permit only once", async () => {
    const dbPath = writePermit();
    const input = {
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    };

    await expect(consumePermit(input)).resolves.toEqual({
      callerRunId: "run_codexroot_test",
      callerSessionId: "child_codexroot_test",
    });
    await expect(consumePermit(input)).resolves.toBe(false);
  });

  test("accepts existing direct codexroot attestation behavior", async () => {
    const dbPath = writePermit({
      callerSessionId: "sess_codexroot_test",
      callerAttestationToken: "smca_direct_codexroot_test",
    });

    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toEqual({
      callerRunId: "run_codexroot_direct_test",
      callerSessionId: "sess_codexroot_test",
    });
  });

  test("rejects a non-codexroot child owner attestation", async () => {
    const dbPath = writePermit({
      callerSessionId: "child_watchdog_test",
      callerAttestationToken: "smca_non_codexroot_child_test",
    });

    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toBe(false);
  });

  test.each([
    ["wrong source", { source: "scheduled-daily" }],
    ["wrong force", { force: true }],
    ["wrong actor", { actorSessionName: "another-session" }],
    ["stale", { requestedAtMs: 800_000 }],
  ])("rejects and consumes a permit with %s", async (_label, overrides) => {
    const dbPath = writePermit(overrides);
    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toBe(false);
    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toBe(false);
  });

  test("does not touch the valid permit when an unrelated nonce is presented", async () => {
    const dbPath = writePermit();
    await expect(consumePermit({
      dbPath,
      nonce: "smrp_ffffffffffffffffffffffffffffffff",
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toBe(false);
    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toEqual({
      callerRunId: "run_codexroot_test",
      callerSessionId: "child_codexroot_test",
    });
  });

  test("rejects a self-asserted codexroot permit without live attestation", async () => {
    const dbPath = writePermit({ callerAttestationToken: "smca_forged" });
    await expect(consumePermit({
      dbPath,
      nonce: NONCE,
      source: "codexroot-maintenance",
      force: false,
      nowMs: 1_030_000,
    })).resolves.toBe(false);
  });
});
