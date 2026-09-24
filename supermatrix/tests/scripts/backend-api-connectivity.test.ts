import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyBackendConnectivityError } from "../../scripts/backend-api-connectivity.ts";

type ScriptRun = { code: number | null; stdout: string; stderr: string };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runConnectivityScript(
  mode: "safe-success" | "hook-only" | "transport",
  options: { routeStateContent?: string } = {},
): Promise<ScriptRun> {
  const root = await mkdtemp(join(tmpdir(), "sm-backend-connectivity-"));
  roots.push(root);
  const extraEnv: Record<string, string> = {};
  if (options.routeStateContent !== undefined) {
    const routeStatePath = join(root, "route-state.json");
    await writeFile(routeStatePath, options.routeStateContent, "utf8");
    extraEnv["SM_CODEX_ROUTE_STATE_PATH"] = routeStatePath;
  }
  const fakeCli = join(root, "fake-backend-cli.mjs");
  await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE;
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\\n");
  process.exit(0);
}
if (args[0] === "exec") {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) + "\\n");
  process.exit(0);
}
const hookStarted = { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" };
const hookResponse = { type: "system", subtype: "hook_response", hook_name: "SessionStart:startup" };
if (mode === "hook-only") {
  process.stdout.write(JSON.stringify(hookStarted) + "\\n" + JSON.stringify(hookResponse) + "\\n");
  process.exit(0);
}
if (mode === "transport") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "ECONNRESET" }) + "\\n");
  process.exit(1);
}
if (!args.includes("--safe-mode")) {
  process.stdout.write(JSON.stringify(hookStarted) + "\\n" + JSON.stringify(hookResponse) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) + "\\n");
process.exit(0);
`, "utf8");
  await chmod(fakeCli, 0o755);

  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      status: "ok",
      backend: "kimi",
      state: "ready",
      pid: 123,
      roundtrip: { ok: true, rttMs: 1 },
    }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as AddressInfo).port;

  try {
    return await new Promise<ScriptRun>((resolvePromise) => {
      const child = spawn(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        [resolve(process.cwd(), "scripts/backend-api-connectivity.ts")],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            FAKE_CLAUDE_MODE: mode,
            SM_BACKEND_API_ENV_FILE: join(root, "missing.env"),
            SM_BACKEND_API_PROBE_TIMEOUT_MS: "2000",
            SM_CLAUDE_AUTH_CHECK_TIMEOUT_MS: "2000",
            SM_CLAUDE_CLI_PATH: fakeCli,
            SM_CODEX_CLI_PATH: fakeCli,
            SM_API_PORT: String(port),
            ...extraEnv,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((err) => err ? reject(err) : resolvePromise());
    });
  }
}

function summaryOf(run: ScriptRun): {
  ok: boolean;
  probes: Array<{ backend: string; ok: boolean; failureKind?: string; model?: string; skipped?: boolean; skippedReason?: string }>;
} {
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as {
    ok: boolean;
    probes: Array<{ backend: string; ok: boolean; failureKind?: string; model?: string; skipped?: boolean; skippedReason?: string }>;
  };
}

describe("backend-api-connectivity Claude probe", () => {
  test("isolates startup hooks and waits for a terminal result", async () => {
    const run = await runConnectivityScript("safe-success");
    const summary = summaryOf(run);

    expect(run.code).toBe(0);
    expect(summary.probes).toContainEqual(expect.objectContaining({ backend: "claude", ok: true }));
  });

  test("does not accept hook-only output without a terminal result", async () => {
    const run = await runConnectivityScript("hook-only");
    const summary = summaryOf(run);

    expect(run.code).toBe(1);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "claude",
      ok: false,
      failureKind: "bad_payload",
    }));
  });

  test("keeps terminal transport failures fail-closed", async () => {
    const run = await runConnectivityScript("transport");
    const summary = summaryOf(run);

    expect(run.code).toBe(1);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "claude",
      ok: false,
      failureKind: "transport",
    }));
  });

  test.each([
    ["API Error: 401 unauthorized", "auth"],
    ["request timed out", "timeout"],
    ["socket ECONNRESET", "transport"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyBackendConnectivityError(message)).toBe(expected);
  });
});

describe("backend-api-connectivity codex route-state awareness", () => {
  const deepseekRouteState = JSON.stringify({
    contractVersion: "sm-switch.route-state/v1",
    backend: "codex",
    route: "deepseek",
    defaultModel: "deepseek-v4-flash",
    servedModels: ["deepseek-v4-flash"],
    activatedAt: "2026-08-07T16:21:23.512Z",
    proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
  });

  test("probes codex with the deepseek route defaultModel", async () => {
    const run = await runConnectivityScript("safe-success", { routeStateContent: deepseekRouteState });
    const summary = summaryOf(run);

    expect(run.code).toBe(0);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "codex",
      ok: true,
      model: "deepseek-v4-flash",
    }));
  });

  test("reports codex skipped (not failed) when deepseek route serves no model", async () => {
    const noModelRouteState = JSON.stringify({
      contractVersion: "sm-switch.route-state/v1",
      backend: "codex",
      route: "deepseek",
      defaultModel: null,
      servedModels: [],
      activatedAt: "2026-08-07T16:21:23.512Z",
      proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
    });
    const run = await runConnectivityScript("safe-success", { routeStateContent: noModelRouteState });
    const summary = summaryOf(run);

    expect(run.code).toBe(0);
    expect(summary.ok).toBe(true);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "codex",
      ok: true,
      skipped: true,
    }));
    const codexProbe = summary.probes.find((probe) => probe.backend === "codex");
    expect(codexProbe?.skippedReason).toContain("route=deepseek");
  });

  test("falls open to the gpt-5.5 status quo on a corrupt route-state file", async () => {
    const run = await runConnectivityScript("safe-success", { routeStateContent: "{ not json" });
    const summary = summaryOf(run);

    expect(run.code).toBe(0);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "codex",
      ok: true,
      model: "gpt-5.5",
    }));
  });

  test("keeps gpt-5.5 behavior on an explicit openai route", async () => {
    const openaiRouteState = JSON.stringify({
      contractVersion: "sm-switch.route-state/v1",
      backend: "codex",
      route: "openai",
      defaultModel: null,
      servedModels: [],
      activatedAt: "2026-08-07T16:21:23.512Z",
      proxy: null,
    });
    const run = await runConnectivityScript("safe-success", { routeStateContent: openaiRouteState });
    const summary = summaryOf(run);

    expect(run.code).toBe(0);
    expect(summary.probes).toContainEqual(expect.objectContaining({
      backend: "codex",
      ok: true,
      model: "gpt-5.5",
    }));
  });

  test("does not classify model_not_served under deepseek as repairable model_access", () => {
    expect(classifyBackendConnectivityError("HTTP 400 model_not_served", "deepseek")).toBe("degraded");
    expect(classifyBackendConnectivityError("HTTP 400 model_not_served", "openai")).toBe("model_access");
    expect(classifyBackendConnectivityError("HTTP 400 model_not_served")).toBe("model_access");
  });
});
