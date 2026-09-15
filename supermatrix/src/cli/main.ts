import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createExternalSignalGate } from "./externalSignalGate.ts";

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
  const shutdown = createExternalSignalGate({
    captureFirstSigterm: captureSigtermForensics,
    onDenied: (signal, count) => {
      console.log(
        `[supermatrix] ignored unauthorized external ${signal} (count=${count}); ` +
          "use the codexroot maintenance gate",
      );
    },
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the large bootstrap module graph behind the signal gate as well. A
  // TERM arriving while adapters/config modules are loading must not regain a
  // startup-only bypass window.
  const { bootstrap } = await import("./bootstrap.ts");
  const app = await bootstrap(process.env);
  await app.start();
}

main().catch((err) => {
  console.error("[supermatrix] fatal:", err);
  process.exit(1);
});
