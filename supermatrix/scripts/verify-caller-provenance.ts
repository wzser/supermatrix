#!/usr/bin/env tsx
// Executable evidence for the caller-provenance boundary.
//
//   npx tsx scripts/verify-caller-provenance.ts
//
// Answers one question with running code rather than assertion: what does
// SuperMatrix actually guarantee about "which session is writing this row",
// given every session runs under the same OS uid?
//
// It starts a real API server from src on an ephemeral loopback port and drives
// it over real HTTP, so it also serves as the contract check for consumers
// (wendangwang queue enqueue and anything else recording caller provenance).
//
// Narrative in docs/caller-provenance-boundary.md.
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { startApiServer, type ApiDeps } from "../src/cli/apiServer.ts";
import {
  CALLER_ATTESTATION_ENV_VAR,
  createCallerAttestationRegistry,
} from "../src/domain/callerAttestation.ts";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(name: string, passed: boolean, detail: string): void {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

function silentLogger(): any {
  const logger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  logger.child = () => logger;
  return logger;
}

/**
 * E1 — Is a backend-shaped Node process environment readable by a sibling
 * under the same uid? `/bin/sleep` is a SIP platform binary whose environment
 * is hidden on this host, so it is not representative of the real backend.
 */
async function envExposureProbe(): Promise<void> {
  const secret = `smca_probe_${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    env: { SM_PROBE_SECRET: secret },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 300));
  let leaked = false;
  let evidence = "";
  // Keep argv split explicitly. zsh does not word-split an unquoted scalar, so
  // hiding these flags in one shell variable can produce a `ps` usage false negative.
  const args = ["-Ewww", "-p", String(child.pid)];
  try {
    const { stdout } = await execFileAsync("/bin/ps", args);
    leaked = stdout.includes(secret);
    evidence = `ps ${args[0]} ${leaked ? "exposed" : "did not expose"} the probe token; `;
  } catch (err) {
    evidence = `ps ${args[0]} errored (${(err as Error).message.slice(0, 80)}); `;
  } finally {
    child.kill();
  }
  check(
    "E1 same-uid sibling can read a Node backend process env",
    leaked,
    `${evidence}=> an env-injected attestation is harvestable and replayable; ` +
      `this transport cannot establish caller-bound identity.`,
  );
}

async function endpointProbes(): Promise<void> {
  const registry = createCallerAttestationRegistry();
  const deps = {
    store: { listActiveSessions: async () => [], countBusySessions: async () => 0 },
    callerAttestations: registry,
    logger: silentLogger(),
  } as unknown as ApiDeps;

  const server = await startApiServer(deps, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (body: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`${base}/api/caller-identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  const postFromSibling = async (
    token: string,
  ): Promise<{ requesterPid: number; status: number; json: any }> => {
    const source = [
      "const res = await fetch(process.env.SM_PROBE_URL, {",
      "  method: 'POST',",
      "  headers: { 'Content-Type': 'application/json' },",
      "  body: JSON.stringify({ token: process.env.SM_PROBE_TOKEN }),",
      "});",
      "process.stdout.write(JSON.stringify({",
      "  requesterPid: process.pid, status: res.status, json: await res.json(),",
      "}));",
    ].join("\n");
    const { stdout } = await execFileAsync(process.execPath, ["-e", source], {
      env: {
        SM_PROBE_URL: `${base}/api/caller-identity`,
        SM_PROBE_TOKEN: token,
      },
      timeout: 5_000,
    });
    return JSON.parse(stdout) as { requesterPid: number; status: number; json: any };
  };

  try {
    // The victim: a contract owner whose registry rows are worth forging.
    const victim = registry.mint({
      sessionId: "s-fp",
      sessionName: "first-principle",
      backend: "codex",
      now: Date.now(),
    });
    // A legitimate token used to prove that adding a self-reported name to the
    // request is still rejected. This check is independent of token theft.
    const forger = registry.mint({
      sessionId: "s-imp",
      sessionName: "impersonator",
      backend: "codex",
      now: Date.now(),
    });

    const ok = await post({ token: victim });
    check(
      "E2 a live token resolves to its runtime mapping with owner authority disabled",
      ok.status === 200 &&
        ok.json.sessionName === "first-principle" &&
        ok.json.attested === true &&
        ok.json.ownerAuthority === false,
      `HTTP ${ok.status} ${JSON.stringify(ok.json)}`,
    );

    const victimProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      env: { [CALLER_ATTESTATION_ENV_VAR]: victim },
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 300));
    const victimPid = victimProcess.pid ?? 0;
    let harvestedMatchesVictim = false;
    let replayedVictim: { requesterPid: number; status: number; json: any } = {
      requesterPid: 0,
      status: 0,
      json: {},
    };
    let replayError = "";
    try {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-Ewww", "-p", String(victimPid)],
      );
      const marker = `${CALLER_ATTESTATION_ENV_VAR}=`;
      const markerStart = stdout.indexOf(marker);
      const harvested = markerStart < 0
        ? ""
        : (stdout.slice(markerStart + marker.length).split(/\s/u, 1)[0] ?? "");
      harvestedMatchesVictim = harvested === victim;
      replayedVictim = await postFromSibling(harvested);
    } catch (err) {
      replayError = err instanceof Error ? err.message : String(err);
    } finally {
      victimProcess.kill();
    }
    check(
      "E3 replaying a harvested victim token reaches the victim mapping through the official path",
      harvestedMatchesVictim &&
        replayedVictim.status === 200 &&
        replayedVictim.json.ownerSessionName === "first-principle" &&
        replayedVictim.json.ownerAuthority === false,
      `victimPid=${victimPid} requesterPid=${replayedVictim.requesterPid} ` +
        `harvested=${harvestedMatchesVictim} HTTP ${replayedVictim.status} ` +
        `ownerSessionName=${replayedVictim.json.ownerSessionName}, ` +
        `ownerAuthority=${replayedVictim.json.ownerAuthority}; ` +
        `${replayError ? `error=${replayError}; ` : ""}the endpoint cannot identify the presenter`,
    );

    // The victim's name is public, so a name gate is defeated by exporting it.
    // The token cannot be guessed from that name, even though E1 shows that a
    // live token can be harvested from a Node process env.
    const guesses = ["first-principle", "smca_first-principle", `smca_${"0".repeat(64)}`];
    const guessResults = await Promise.all(guesses.map((g) => post({ token: g })));
    check(
      "E4 guessing from the public session name yields no identity",
      guessResults.every((r) => r.status === 403 && r.json.attested === false),
      `tried ${guesses.length} guesses -> statuses ${guessResults.map((r) => r.status).join(",")}`,
    );

    const claimed = await post({ token: forger, sessionName: "first-principle" });
    check(
      "E5 the official path refuses a self-reported identity claim",
      claimed.status === 400,
      `HTTP ${claimed.status} ${JSON.stringify(claimed.json)}`,
    );

    // Scheduler script tasks and human terminals hold no attestation. That is
    // legitimate and must stay serviceable — it maps to `unattested`, which is
    // a defined answer, not an error and not an identity.
    const none = await post({});
    const unknown = await post({ token: "smca_not_a_real_token" });
    check(
      "E6 the unattested path is a defined, non-identity answer (scheduler/kimi/human preserved)",
      none.status === 400 &&
        unknown.status === 403 &&
        unknown.json.attested === false &&
        unknown.json.ownerAuthority === false &&
        !("sessionName" in unknown.json),
      `no-token=HTTP ${none.status}; unknown-token=HTTP ${unknown.status} attested=${unknown.json.attested}, ` +
        `no sessionName field => callers cannot fall back to an implied owner`,
    );

    registry.revokeSession("s-fp");
    const revoked = await post({ token: victim });
    check(
      "E7 an attestation stops resolving once its run ends",
      revoked.status === 403,
      `HTTP ${revoked.status} after revokeSession`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  console.log("caller-provenance boundary — executable evidence\n");
  await envExposureProbe();
  await endpointProbes();
  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n\n` +
      "This verifies a provenance-only contract, not an authorization boundary.\n" +
      "Same-uid env harvesting and token replay are in scope and demonstrated by\n" +
      "E1/E3; see docs/caller-provenance-boundary.md.",
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
