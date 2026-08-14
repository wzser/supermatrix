// POST /api/caller-identity — the runtime side of Bitable/registry caller
// provenance. A local CLI presents the token SuperMatrix injected into a run;
// the runtime maps that token to its registry entry. Because a same-uid sibling
// can replay an env-harvested token, the result is provenance-only and must not
// carry owner authority.
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import { createCallerAttestationRegistry } from "../../src/domain/callerAttestation.ts";

function makeLogger(): any {
  const logger: any = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  logger.child = () => logger;
  return logger;
}

function mkDeps(callerAttestations: ReturnType<typeof createCallerAttestationRegistry>): ApiDeps {
  return {
    store: {
      listActiveSessions: async () => [],
      countBusySessions: async () => 0,
    },
    callerAttestations,
    logger: makeLogger(),
  } as unknown as ApiDeps;
}

describe("POST /api/caller-identity", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let baseUrl: string;
  let registry: ReturnType<typeof createCallerAttestationRegistry>;

  beforeEach(async () => {
    registry = createCallerAttestationRegistry();
    server = await startApiServer(mkDeps(registry), 0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/api/caller-identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  test("a live attestation resolves to a provenance mapping without owner authority", async () => {
    const token = registry.mint({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      now: 1700000000000,
    });

    const { status, json } = await post({ token });

    expect(status).toBe(200);
    expect(json).toEqual({
      ok: true,
      attested: true,
      ownerAuthority: false,
      sessionId: "s-fp",
      sessionName: "first-principle",
      ownerSessionName: "first-principle",
      backend: "codex",
      issuedAt: 1700000000000,
    });
  });

  test("a child session resolves to its top-level owner", async () => {
    const token = registry.mint({
      sessionId: "s-child",
      sessionName: "child_first-principle_ab12cd",
      backend: "claude",
      now: 1,
    });

    const { json } = await post({ token });

    expect(json.sessionName).toBe("child_first-principle_ab12cd");
    expect(json.ownerSessionName).toBe("first-principle");
  });

  test("an unknown or revoked attestation is unattested, never a fallback identity", async () => {
    const token = registry.mint({ sessionId: "s1", sessionName: "a", backend: "codex", now: 1 });
    registry.revokeSession("s1");

    const { status, json } = await post({ token });

    expect(status).toBe(403);
    expect(json.ok).toBe(false);
    expect(json.attested).toBe(false);
    expect(json.ownerAuthority).toBe(false);
    expect(json).not.toHaveProperty("sessionName");
    expect(json).not.toHaveProperty("ownerSessionName");
  });

  test("a guessed attestation does not resolve", async () => {
    registry.mint({ sessionId: "s-fp", sessionName: "first-principle", backend: "codex", now: 1 });

    for (const guess of ["smca_first-principle", "first-principle", "smca_" + "0".repeat(64)]) {
      const { status, json } = await post({ token: guess });
      expect(status).toBe(403);
      expect(json.attested).toBe(false);
    }
  });

  test("the endpoint refuses to take an identity claim from the caller", async () => {
    // The whole boundary: a caller must not be able to smuggle in the name it
    // wants to be recorded as. Extra top-level keys are rejected outright so a
    // future consumer cannot start trusting a self-reported field.
    const token = registry.mint({
      sessionId: "s-x",
      sessionName: "impersonator",
      backend: "codex",
      now: 1,
    });

    const { status, json } = await post({ token, sessionName: "first-principle" });

    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  test("a missing, blank, or non-string token is a 400, not an identity", async () => {
    for (const body of [{}, { token: "" }, { token: "   " }, { token: 42 }]) {
      const { status, json } = await post(body);
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json).not.toHaveProperty("sessionName");
    }
  });

  test("invalid JSON is a 400", async () => {
    const { status, json } = await post("{not json");
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
  });

  test("GET is not served, so attestations never land in URLs or access logs", async () => {
    const res = await fetch(`${baseUrl}/api/caller-identity?token=smca_x`);
    expect(res.status).toBe(404);
  });
});
