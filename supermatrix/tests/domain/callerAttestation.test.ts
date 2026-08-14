import { describe, expect, test } from "vitest";
import {
  createCallerAttestationRegistry,
  CALLER_ATTESTATION_ENV_VAR,
} from "../../src/domain/callerAttestation.ts";

function mkRegistry() {
  return createCallerAttestationRegistry();
}

describe("callerAttestation registry", () => {
  test("a minted token resolves back to the runtime identity it was minted for", () => {
    const registry = mkRegistry();
    const token = registry.mint({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      now: 1000,
    });

    expect(registry.resolve(token)).toEqual({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      issuedAt: 1000,
    });
  });

  test("the token is unguessable: high entropy, not derived from the session name", () => {
    const registry = mkRegistry();
    const token = registry.mint({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      now: 1,
    });

    // The whole point of the runtime-backed gate: an impersonator knows the
    // victim's *name* (it is public in the session catalog) but must not be
    // able to derive or guess its attestation.
    expect(token).not.toContain("first-principle");
    expect(token).not.toContain("s-fp");
    expect(token.replace(/^smca_/u, "")).toMatch(/^[0-9a-f]{64}$/u);

    const second = registry.mint({
      sessionId: "s-other",
      sessionName: "other",
      backend: "codex",
      now: 1,
    });
    expect(second).not.toBe(token);
  });

  test("an unknown, empty, or whitespace token resolves to null (never a default identity)", () => {
    const registry = mkRegistry();
    registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 1 });

    expect(registry.resolve("smca_deadbeef")).toBeNull();
    expect(registry.resolve("")).toBeNull();
    expect(registry.resolve("   ")).toBeNull();
  });

  test("one session's token never resolves to another session", () => {
    const registry = mkRegistry();
    const fpToken = registry.mint({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      now: 1,
    });
    const otherToken = registry.mint({
      sessionId: "s-x",
      sessionName: "impersonator",
      backend: "codex",
      now: 1,
    });

    expect(registry.resolve(otherToken)?.sessionName).toBe("impersonator");
    expect(registry.resolve(fpToken)?.sessionName).toBe("first-principle");
  });

  test("re-minting for a session rotates: the previous token stops resolving", () => {
    const registry = mkRegistry();
    const first = registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 1 });
    const second = registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 2 });

    expect(first).not.toBe(second);
    expect(registry.resolve(first)).toBeNull();
    expect(registry.resolve(second)?.issuedAt).toBe(2);
    // Bounded memory: one live attestation per session, not one per run forever.
    expect(registry.size()).toBe(1);
  });

  test("revokeSession invalidates the live token for that session only", () => {
    const registry = mkRegistry();
    const a = registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 1 });
    const b = registry.mint({ sessionId: "s2", sessionName: "b", backend: "claude", now: 1 });

    registry.revokeSession("s1");

    expect(registry.resolve(a)).toBeNull();
    expect(registry.resolve(b)?.sessionName).toBe("b");
    expect(registry.size()).toBe(1);
  });

  test("revokeSession on an unknown session is a no-op", () => {
    const registry = mkRegistry();
    const a = registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 1 });
    registry.revokeSession("nope");
    expect(registry.resolve(a)?.sessionName).toBe("a");
  });

  test("exposes the env var name backends inject, so callers and adapters cannot drift", () => {
    expect(CALLER_ATTESTATION_ENV_VAR).toBe("SM_CALLER_ATTESTATION");
  });
});
