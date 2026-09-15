import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAutobitableServer } from "../src/server.mjs";

const SECRET = "smwhsec_public_safe_test_secret";
const SECRET_HASH = createHash("sha256").update(SECRET).digest("hex");

function webhook(overrides = {}) {
  return {
    webhook_id: "wh_public_safe",
    display_name: "Public-safe test webhook",
    status: "active",
    settlement_mode: "receipt_verified",
    owner_session: "owner-session",
    settlement_owner: "owner-session",
    approved_by: "target-session",
    bitable: { base_token_alias: "base-alias", table_id: "tbl_demo", view_id: "vew_demo", field_allowlist: [] },
    command: { type: "prompt", target_session: "target-session", prompt_template: "record_id={{record_id}}" },
    security: { header: "X-SM-Webhook-Secret", secret_sha256: SECRET_HASH },
    params_schema: {
      type: "object",
      required: ["webhook_id", "table_id", "view_id", "record_id"],
      additional_properties: false,
      properties: {
        webhook_id: { type: "string" }, table_id: { type: "string" }, view_id: { type: "string" },
        record_id: { type: "string" }, triggered_at: { type: "string" }, fields: { type: "object" }
      }
    },
    idempotency: { enabled: true, key_template: "{{webhook_id}}:{{table_id}}:{{view_id}}:{{record_id}}:{{triggered_at}}", on_duplicate: "return_existing" },
    execution: { timeout_ms: 500, expected_duration_ms: 5_000 },
    receipt_proof: { kind: "session_reply_present", contains_all: ["REPORT: ok"] },
    writeback: { enabled: false },
    ...overrides
  };
}

async function makeRegistry(dir, entries = [webhook()]) {
  const registryPath = join(dir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ schema_version: 1, webhooks: entries }));
  return registryPath;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SM-Webhook-Secret": SECRET },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function latestRuns(path) {
  const content = await readFile(path, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const latest = new Map();
  for (const line of content.split("\n").filter(Boolean)) {
    const run = JSON.parse(line);
    latest.set(run.run_id, run);
  }
  return [...latest.values()];
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for fixture state");
}

async function freePort() {
  const probe = createServer();
  const url = await listen(probe);
  const port = new URL(url).port;
  await close(probe);
  return Number(port);
}

function startFacadeCli({ registryPath, runStorePath, smBaseUrl, port }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      AUTOBITABLE_HOST: "127.0.0.1",
      AUTOBITABLE_PORT: String(port),
      AUTOBITABLE_REGISTRY_PATH: registryPath,
      AUTOBITABLE_RUN_STORE_PATH: runStorePath,
      AUTOBITABLE_RETRY_LOOP: "0",
      AUTOBITABLE_NOTIFY: "0",
      SM_API_BASE: smBaseUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stderrText = () => stderr;
  return child;
}

async function stopCli(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
}

test("public-safe entry point is a facade over the owner source", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(source, /\.\.\/\.\.\/src\/server\.mjs/u);
  assert.doesNotMatch(source, /handlePromptDispatch|settlePrompt|appendRun|createServer/u);
});

test("owner public-safe profile rejects a parallel command surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-safe-profile-"));
  try {
    const registryPath = await makeRegistry(dir, [{ ...webhook(), command: { type: "script", argv: ["node", "-e", ""] } }]);
    await assert.rejects(
      createAutobitableServer({ registryPath, runStorePath: join(dir, "runs.jsonl"), retryLoopEnabled: false }),
      /only accepts prompt delegation/u
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("public-safe profile does not expose the notify-card ingress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-safe-route-"));
  const registryPath = await makeRegistry(dir);
  const adapter = await createAutobitableServer({ registryPath, runStorePath: join(dir, "runs.jsonl"), retryLoopEnabled: false, notify: false });
  const adapterUrl = await listen(adapter);
  try {
    const response = await fetch(`${adapterUrl}/webhooks/notify-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_type: "not-available", value: "ignored" })
    });
    assert.equal(response.status, 404);
  } finally {
    await close(adapter);
    await rm(dir, { recursive: true, force: true });
  }
});

test("public-safe profile fails closed without absolute tenant state paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-safe-paths-"));
  try {
    const registryPath = await makeRegistry(dir);
    await assert.rejects(
      createAutobitableServer({ registryPath, retryLoopEnabled: false }),
      /requires an absolute runStorePath; set AUTOBITABLE_RUN_STORE_PATH/u
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI uses separate absolute registry and run namespaces", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "autobitable-public-safe-cli-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "autobitable-public-safe-cli-b-"));
  const sm = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/spawn2.0") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "queued", ref: "spawnq_cli_namespace", resultUrl: "/api/spawn_async_items/spawnq_cli_namespace/take" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  const smUrl = await listen(sm);
  const registryA = await makeRegistry(dirA, [webhook({ webhook_id: "wh_namespace_a" })]);
  const registryB = await makeRegistry(dirB, [webhook({ webhook_id: "wh_namespace_b" })]);
  const runStoreA = join(dirA, "private", "runs.jsonl");
  const runStoreB = join(dirB, "private", "runs.jsonl");
  const portA = await freePort();
  const portB = await freePort();
  const cliA = startFacadeCli({ registryPath: registryA, runStorePath: runStoreA, smBaseUrl: smUrl, port: portA });
  const cliB = startFacadeCli({ registryPath: registryB, runStorePath: runStoreB, smBaseUrl: smUrl, port: portB });
  try {
    await waitFor(async () => {
      const [healthA, healthB] = await Promise.all([
        fetch(`http://127.0.0.1:${portA}/health`).catch(() => null),
        fetch(`http://127.0.0.1:${portB}/health`).catch(() => null)
      ]);
      return Boolean(healthA?.ok && healthB?.ok);
    });
    const [healthA, healthB] = await Promise.all([
      fetch(`http://127.0.0.1:${portA}/health`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${portB}/health`).then((response) => response.json())
    ]);
    assert.equal(healthA.webhooks, 1);
    assert.equal(healthB.webhooks, 1);

    const request = (port, webhook_id, record_id) => fetch(`http://127.0.0.1:${port}/feishu/bitable/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SM-Webhook-Secret": SECRET },
      body: JSON.stringify({ webhook_id, table_id: "tbl_demo", view_id: "vew_demo", record_id })
    });
    assert.equal((await request(portA, "wh_namespace_a", "rec_a")).status, 202);
    assert.equal((await request(portB, "wh_namespace_b", "rec_b")).status, 202);
    await waitFor(async () => {
      const [contentA, contentB] = await Promise.all([
        readFile(runStoreA, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error)),
        readFile(runStoreB, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error))
      ]);
      return contentA.includes("wh_namespace_a") && contentB.includes("wh_namespace_b");
    });
    const contentA = await readFile(runStoreA, "utf8");
    const contentB = await readFile(runStoreB, "utf8");
    assert.match(contentA, /wh_namespace_a/u);
    assert.doesNotMatch(contentA, /wh_namespace_b/u);
    assert.match(contentB, /wh_namespace_b/u);
    assert.doesNotMatch(contentB, /wh_namespace_a/u);
    assert.equal(cliA.stderrText(), "");
    assert.equal(cliB.stderrText(), "");
  } finally {
    await stopCli(cliA);
    await stopCli(cliB);
    await close(sm);
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("uses persisted triggered_at and idempotency identity across the current date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-safe-identity-"));
  const runStorePath = join(dir, "runs.jsonl");
  const dispatches = [];
  const sm = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/spawn2.0") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      dispatches.push(JSON.parse(raw));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "queued", ref: "spawnq_identity", resultUrl: "/api/spawn_async_items/spawnq_identity/take" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "waiting_child" }));
  });
  const smUrl = await listen(sm);
  const registryPath = await makeRegistry(dir, [webhook({ settlement_mode: "dispatch_only" })]);
  const adapter = await createAutobitableServer({ registryPath, runStorePath, smBaseUrl: smUrl, retryLoopEnabled: false, notify: false });
  const adapterUrl = await listen(adapter);
  try {
    const triggeredAt = "2026-09-13T23:59:59.000Z";
    const response = await post(`${adapterUrl}/feishu/bitable/webhook`, {
      webhook_id: "wh_public_safe", table_id: "tbl_demo", view_id: "vew_demo", record_id: "rec_identity", triggered_at: triggeredAt
    });
    assert.equal(response.status, 202);
    assert.equal(dispatches.length, 1);
    assert.match(dispatches[0].client_request_id, /^2026-09-13:autobitable:wh_public_safe:tbl_demo:vew_demo:rec_identity:/u);
    assert.equal(dispatches[0].client_request_id, "2026-09-13:autobitable:wh_public_safe:tbl_demo:vew_demo:rec_identity:2026-09-13T23:59:59.000Z");
  } finally {
    await close(adapter); await close(sm); await rm(dir, { recursive: true, force: true });
  }
});

test("settles only the real Spawn2.0 result shape, failing closed for failed, waiting, and null results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-safe-settlement-"));
  const runStorePath = join(dir, "runs.jsonl");
  const outcomes = new Map([
    ["rec_failed", { ok: true, commStatus: "failed", status: "failed", finalMessage: "transport failed" }],
    ["rec_waiting", { ok: true, status: "waiting_child" }],
    ["rec_null", null],
    ["rec_success", { ok: true, commStatus: "completed", status: "completed", finalMessage: "REPORT: ok" }]
  ]);
  const sm = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/spawn2.0") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const recordId = JSON.parse(raw).prompt.match(/record_id=([^\s]+)/u)?.[1];
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "queued", ref: `spawnq_${recordId}`, resultUrl: `/api/spawn_async_items/spawnq_${recordId}/take` }));
      return;
    }
    const recordId = req.url.match(/spawnq_(rec_[^/]+)/u)?.[1];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(outcomes.get(recordId)));
  });
  const smUrl = await listen(sm);
  const registryPath = await makeRegistry(dir);
  const adapter = await createAutobitableServer({ registryPath, runStorePath, smBaseUrl: smUrl, retryLoopEnabled: true, retrySweepIntervalMs: 15, notify: false });
  const adapterUrl = await listen(adapter);
  try {
    const responses = await Promise.all([...outcomes.keys()].map((record_id) => post(`${adapterUrl}/feishu/bitable/webhook`, {
      webhook_id: "wh_public_safe", table_id: "tbl_demo", view_id: "vew_demo", record_id
    })));
    assert.ok(responses.every((response) => response.status === 202));
    await waitFor(async () => {
      const runs = await latestRuns(runStorePath);
      return [
        ["rec_failed", "evidence_missing"],
        ["rec_success", "success"]
      ].every(([record_id, final_status]) => runs.some((run) => run.record_id === record_id && run.final_status === final_status));
    });
    const runs = await latestRuns(runStorePath);
    assert.equal(runs.find((run) => run.record_id === "rec_failed").final_status, "evidence_missing");
    assert.equal(runs.find((run) => run.record_id === "rec_waiting").final_status, "pending");
    assert.equal(runs.find((run) => run.record_id === "rec_null").final_status, "pending");
    assert.equal(runs.find((run) => run.record_id === "rec_success").final_status, "success");
  } finally {
    await close(adapter); await close(sm); await rm(dir, { recursive: true, force: true });
  }
});
