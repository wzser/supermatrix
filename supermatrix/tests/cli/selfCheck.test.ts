import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliUpgradeProfile } from "../../src/cli/selfCheck.ts";
import type { BootCheck } from "../../src/app/bootSelfCheck/types.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const TSX = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const SELF_CHECK = resolve(REPO_ROOT, "src/cli/selfCheck.ts");

describe("standalone self-check CLI", () => {
  test("cli-upgrade profile decorates healthy Codex detail with stable referenced models", async () => {
    const resolvedDefaultSlug = "gpt-6-preview";
    const healthyCodexCheck: BootCheck = {
      name: "codex-default-model",
      phases: ["pre-wiring"],
      async run() {
        return {
          name: "codex-default-model",
          status: "ok",
          detail: {
            source: "detected",
            slug: resolvedDefaultSlug,
            candidates: 5,
          },
        };
      },
    };

    const { report, exitCode } = await runCliUpgradeProfile({
      checks: [healthyCodexCheck],
    });

    expect(exitCode).toBe(0);
    expect(report.checks).toEqual([
      {
        name: "codex-default-model",
        status: "ok",
        detail: {
          source: "detected",
          slug: resolvedDefaultSlug,
          candidates: 5,
          referencedModels: [
            "gpt-5.5",
            "gpt-5.6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            resolvedDefaultSlug,
          ],
        },
      },
    ]);
  });

  test("cli-upgrade profile emits isolated machine-readable Codex/Kimi results", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "sm-cli-upgrade-self-check-"));
    const fakeCodex = resolve(tempDir, "codex");
    const fakeKimi = resolve(tempDir, "kimi");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
printf '%s\n' '{"models":[{"slug":"gpt-5.6-sol","priority":0,"visibility":"list","supported_in_api":true},{"slug":"gpt-5.6-luna","priority":1,"visibility":"list","supported_in_api":true},{"slug":"gpt-5.5","priority":2,"visibility":"list","supported_in_api":true}]}'
`,
    );
    writeFileSync(
      fakeKimi,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("0.29.0\\n");
  process.exit(0);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              audio: false,
              embeddedContext: true,
              image: true
            }
          },
          authMethods: []
        }
      }) + "\\n");
    }
  }
});
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), 5000);
});
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeCodex, 0o755);
    chmodSync(fakeKimi, 0o755);

    try {
      const result = spawnSync(
        "npm",
        ["run", "--silent", "self-check", "--", "--profile", "cli-upgrade"],
        {
        cwd: REPO_ROOT,
        encoding: "utf8",
        // Deliberately loose: npm + tsx cold-transforming the CLI entry
        // dominates this ~3s run, so a tight bound measures machine speed, not
        // the CLI. The old 2.5s killed the child and left stdout empty, which
        // surfaced as an unrelated `JSON.parse` SyntaxError. A genuinely hung
        // child is still killed here.
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ""}`,
          SM_CODEX_DEFAULT_MODEL: "gpt-5.5",
          SM_KIMI_CLI_PATH: fakeKimi,
        },
        },
      );
      const report = JSON.parse(result.stdout) as {
        schemaVersion: number;
        profile: string;
        mode: string;
        ok: boolean;
        checks: Array<{
          name: string;
          status: string;
          detail?: {
            reasonCode?: string;
            aliases?: Array<{ alias: string; target: string }>;
            referencedModels?: string[];
          };
        }>;
      };

      expect(result.status).toBe(0);
      expect(report).toMatchObject({
        schemaVersion: 1,
        profile: "cli-upgrade",
        mode: "observe",
        ok: true,
      });
      expect(report.checks.map(({ name }) => name)).toEqual([
        "codex-default-model",
        "kimi-acp-health",
      ]);
      expect(report.checks.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining([
          "dual-instance",
          "scheduler-health",
          "supervisor-presence",
          "reconcile-backend-processes",
        ]),
      );
      expect(
        report.checks.find(({ name }) => name === "codex-default-model"),
      ).toMatchObject({
        status: "warn",
        detail: {
          reasonCode: "CODEX_ALIAS_CATALOG_DRIFT",
          aliases: [
            { alias: "gpt5.6-terra", target: "gpt-5.6-terra" },
            { alias: "terra", target: "gpt-5.6-terra" },
            { alias: "5.6-terra", target: "gpt-5.6-terra" },
          ],
          referencedModels: [
            "gpt-5.5",
            "gpt-5.6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
          ],
        },
      });
      expect(
        report.checks.find(({ name }) => name === "kimi-acp-health"),
      ).toMatchObject({ status: "ok" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("cli-upgrade profile maps a failed check to ok=false and exit 1", () => {
    const source = `
      import { runCliUpgradeProfile } from ${JSON.stringify(SELF_CHECK)};
      void (async () => {
        const failed = {
          name: "forced-fail",
          phases: ["pre-wiring"],
          run: async () => ({
            name: "forced-fail",
            status: "fail",
            message: "forced failure"
          })
        };
        const { report, exitCode } = await runCliUpgradeProfile({ checks: [failed] });
        process.stdout.write(JSON.stringify(report));
        process.exit(exitCode);
      })();
    `;
    const result = spawnSync(TSX, ["-e", source], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 15_000,
    });
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };

    expect(result.status).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "forced-fail", status: "fail" }),
    ]);
  });
});
