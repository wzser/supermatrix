import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BootCheck } from "../app/bootSelfCheck/types.ts";
import { createCodexDefaultModelCheck } from "../app/bootSelfCheck/checks/codexDefaultModel.ts";
import {
  createKimiAcpHealthCheck,
  parseKimiCliVersion,
} from "../app/bootSelfCheck/checks/kimiAcpHealth.ts";
import { errorMessage } from "../app/errorMessage.ts";
import { resolveCodexDefaultModel } from "../adapters/backend-codex/defaultModelResolver.ts";

export function createCliCompatibilityChecks(): BootCheck[] {
  return [
    createCodexDefaultModelCheck({ resolve: () => resolveCodexDefaultModel() }),
    createKimiAcpHealthCheck({
      probeVersion: async () => {
        const cmd = process.env["SM_KIMI_CLI_PATH"] ?? "kimi";
        const execFileP = promisify(execFile);
        try {
          const { stdout, stderr } = await execFileP(cmd, ["--version"], {
            timeout: 5_000,
          });
          return {
            kind: "ok" as const,
            version: parseKimiCliVersion(`${String(stdout)}\n${String(stderr)}`),
          };
        } catch (err) {
          return {
            kind: "fail" as const,
            error: `--version: ${errorMessage(err)}`,
          };
        }
      },
      probeAcpInitialize: async ({ timeoutMs }) => {
        const { AcpClient } = await import("../adapters/backend-kimi/acpClient.ts");
        const client = new AcpClient();
        const start = Date.now();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            client.ensureReady(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`ACP initialize timeout after ${timeoutMs}ms`)),
                timeoutMs,
              );
            }),
          ]);
          return { kind: "ok" as const, rttMs: Date.now() - start };
        } catch (err) {
          return { kind: "fail" as const, error: errorMessage(err) };
        } finally {
          if (timer) clearTimeout(timer);
          await client.dispose().catch(() => { /* probe cleanup is best-effort */ });
        }
      },
    }),
  ];
}
