// Runtime-backed caller provenance.
//
// Problem: local CLIs that write on behalf of a session (queue enqueue, registry
// writes, receipts) only ever saw a *self-reported* caller name. Comparing that
// name against SM_SESSION_NAME closes the confused-agent case but nothing more:
// the session name is public in the session catalog, so a caller that wants to
// be attributed to another owner just exports that name.
//
// This registry replaces the guessable name with an unguessable per-run token
// the runtime mints and injects into the backend process env. The runtime maps a
// presented token back to the run that received it, which helps catch accidental
// name drift. It does NOT prove which process presented the token: on this host,
// a same-uid sibling can read a Node process's env with `ps -Ewww` and replay it.
//
// Boundary (do NOT call this authentication): attested and unattested are
// provenance labels only. Neither state may confer owner authority. See
// docs/caller-provenance-boundary.md.
import { randomBytes } from "node:crypto";

/** Env var the backend adapters inject into each run's process. */
export const CALLER_ATTESTATION_ENV_VAR = "SM_CALLER_ATTESTATION";

const TOKEN_PREFIX = "smca_";

export type CallerAttestation = {
  sessionId: string;
  sessionName: string;
  backend: string;
  issuedAt: number;
};

export type MintInput = {
  sessionId: string;
  sessionName: string;
  backend: string;
  now: number;
};

export type CallerAttestationRegistry = {
  /** Issues a fresh token for the session, invalidating that session's previous one. */
  mint(input: MintInput): string;
  /** Registry entry behind a presented token, or null; not proof of its presenter. */
  resolve(token: string): CallerAttestation | null;
  revokeSession(sessionId: string): void;
  /** Live attestation count; one per session by construction. */
  size(): number;
};

function defaultGenerateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function createCallerAttestationRegistry(
  opts: { generateToken?: () => string } = {},
): CallerAttestationRegistry {
  const generateToken = opts.generateToken ?? defaultGenerateToken;
  const byToken = new Map<string, CallerAttestation>();
  const tokenBySession = new Map<string, string>();

  return {
    mint(input: MintInput): string {
      // Rotate: a session holds exactly one live attestation, so a token leaked
      // from an earlier run stops working and the map cannot grow unbounded.
      const previous = tokenBySession.get(input.sessionId);
      if (previous) byToken.delete(previous);

      const token = generateToken();
      byToken.set(token, {
        sessionId: input.sessionId,
        sessionName: input.sessionName,
        backend: input.backend,
        issuedAt: input.now,
      });
      tokenBySession.set(input.sessionId, token);
      return token;
    },

    resolve(token: string): CallerAttestation | null {
      const trimmed = token.trim();
      if (!trimmed) return null;
      return byToken.get(trimmed) ?? null;
    },

    revokeSession(sessionId: string): void {
      const token = tokenBySession.get(sessionId);
      if (!token) return;
      byToken.delete(token);
      tokenBySession.delete(sessionId);
    },

    size(): number {
      return byToken.size;
    },
  };
}

/**
 * Process-wide registry. The backend adapters (minters) and the loopback API
 * server (resolver) live in the same SuperMatrix process, so they share this
 * instance by default; tests inject their own.
 */
export const defaultCallerAttestationRegistry = createCallerAttestationRegistry();
