import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap.ts";

// Max time to wait for in-flight runs to finish before escalating to a
// force exit on SIGINT/SIGTERM. Long enough that typical claude turns can
// finish, short enough that the operator isn't left waiting indefinitely
// for a stuck run. A second signal (e.g. double Ctrl+C) short-circuits to
// an immediate force exit.
const SHUTDOWN_TIMEOUT_MS = 60_000;

// On 2026-04-17 SM entered a 20s-cadence SIGTERM restart loop whose sender
// could not be identified from any log. This snapshot runs synchronously on
// every SIGTERM (before the graceful shutdown starts) so if it recurs we can
// see what processes were alive at the moment the signal arrived — the
// sender usually appears in the ps tree.
function captureSigtermForensics(signal: string): void {
  try {
    const ts = new Date().toISOString();
    const snap = execFileSync("/bin/ps", ["-ef"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const logPath = path.resolve(process.cwd(), "logs/sm-sigterm-forensics.log");
    appendFileSync(
      logPath,
      `\n=== ${ts} signal=${signal} pid=${process.pid} ppid=${process.ppid} ===\n${snap}`,
    );
  } catch {
    // best-effort; never block shutdown
  }
}

async function main() {
  const app = await bootstrap(process.env);
  await app.start();

  let signalCount = 0;

  const shutdown = (signal: string): void => {
    signalCount++;

    if (signal === "SIGTERM" && signalCount === 1) {
      captureSigtermForensics(signal);
    }

    // Second press → user is impatient, escalate to force exit now.
    if (signalCount >= 2) {
      console.log(`[supermatrix] second ${signal} — forcing exit`);
      app.lifecycle.requestRestart(`signal: ${signal} (double press)`, {
        force: true,
        source: "signal",
      });
      return;
    }

    // First press → graceful: let ProcessLifecycle wait for in-flight
    // runs to drain before exiting. If they don't drain within the
    // timeout, escalate to force.
    const inFlight = app.lifecycle.inFlightCount();
    if (inFlight > 0) {
      console.log(
        `[supermatrix] received ${signal}, ${inFlight} run(s) in flight — ` +
          `graceful shutdown, force timeout in ${SHUTDOWN_TIMEOUT_MS / 1000}s`,
      );
    } else {
      console.log(`[supermatrix] received ${signal}, shutting down`);
    }

    app.lifecycle.requestRestart(`signal: ${signal}`, {
      force: false,
      source: "signal",
    });

    // Hard-timeout fallback. .unref() so this timer never keeps the
    // event loop alive — if graceful exit completes first, the timer
    // is silently discarded with the process.
    setTimeout(() => {
      console.log(
        `[supermatrix] shutdown timeout reached (${SHUTDOWN_TIMEOUT_MS / 1000}s) — forcing exit`,
      );
      app.lifecycle.requestRestart(`signal: ${signal} (timeout escalation)`, {
        force: true,
        source: "signal",
      });
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[supermatrix] fatal:", err);
  process.exit(1);
});
