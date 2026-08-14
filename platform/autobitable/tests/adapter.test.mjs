import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createAutobitableServer } from "../src/server.mjs";

async function postJson(url, body, secret = "dev-secret") {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SM-Webhook-Secret": secret
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function makeFixtureRegistry(dir, overrides = {}) {
  const registryPath = join(dir, "registry.json");
  const scriptPath = resolve("tests/fixtures/echo-json.mjs");
  const registry = {
    schema_version: 1,
    updated_at: "2026-05-08T12:00:00+08:00",
    owner: "autobitable",
    description: "test registry",
    webhooks: [
      {
        webhook_id: "wh_smoke_script",
        display_name: "脚本烟测",
        description: "本地脚本烟测。",
        status: "active",
        class: "script_job",
        owner_session: "autobitable",
        created_by: "autobitable",
        category: "平台运维",
        bitable: {
          base_token_alias: "smoke_base",
          table_id: "tblSmoke",
          view_id: "vewSmoke",
          table_name: "Smoke",
          trigger: "manual_button",
          field_allowlist: []
        },
        command: {
          type: "script",
          target_session: "autobitable",
          script_name: "echo_json",
          argv: ["node", scriptPath]
        },
        security: {
          header: "X-SM-Webhook-Secret",
          secret: "script-secret"
        },
        params_schema: {
          type: "object",
          required: ["webhook_id", "table_id", "view_id", "record_id"]
        },
        idempotency: {
          key_template: "{{webhook_id}}:{{table_id}}:{{view_id}}:{{record_id}}:{{triggered_at}}",
          on_duplicate: "return_existing"
        },
        execution: {
          expected_duration_ms: 30000,
          timeout_ms: 30000,
          concurrency: { scope: "record_id", on_conflict: "skip_if_running" }
        },
        receipt_proof: { kind: "script_output_json", expect_ok: true },
        notify: {
          trigger_failed: { channel: "none" },
          receipt_missing: { channel: "none" },
          succeeded: { channel: "none" }
        },
        writeback: { enabled: false },
        approved_by: "autobitable",
        created_at: "2026-05-08T12:00:00+08:00",
        updated_at: "2026-05-08T12:00:00+08:00"
      },
      {
        webhook_id: "wh_smoke_prompt",
        display_name: "Prompt 烟测",
        description: "本地 prompt spawn 烟测。",
        status: "active",
        class: "prompt_delegation",
        owner_session: "autobitable",
        created_by: "autobitable",
        category: "跨会话委派",
        bitable: {
          base_token_alias: "smoke_base",
          table_id: "tblSmoke",
          view_id: "vewSmoke",
          table_name: "Smoke",
          trigger: "manual_button",
          field_allowlist: []
        },
        command: {
          type: "prompt",
          target_session: "autobitable",
          prompt_template: "REPORT: 请处理 {{record_id}}"
        },
        security: {
          header: "X-SM-Webhook-Secret",
          secret: "prompt-secret"
        },
        params_schema: {
          type: "object",
          required: ["webhook_id", "table_id", "view_id", "record_id"]
        },
        idempotency: {
          key_template: "{{webhook_id}}:{{table_id}}:{{view_id}}:{{record_id}}:{{triggered_at}}",
          on_duplicate: "return_existing"
        },
        execution: {
          expected_duration_ms: 30000,
          timeout_ms: 30000,
          concurrency: { scope: "record_id", on_conflict: "skip_if_running" }
        },
        receipt_proof: { kind: "session_reply_present", timeout_ms: 300000 },
        notify: {
          trigger_failed: { channel: "none" },
          receipt_missing: { channel: "none" },
          succeeded: { channel: "none" }
        },
        writeback: { enabled: false },
        approved_by: "autobitable",
        created_at: "2026-05-08T12:00:00+08:00",
        updated_at: "2026-05-08T12:00:00+08:00"
      }
    ],
    ...overrides
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  return registryPath;
}

describe("autobitable adapter", () => {
  let dir;
  let registryPath;
  let runStorePath;
  let server;
  let baseUrl;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "autobitable-test-"));
    registryPath = await makeFixtureRegistry(dir);
    runStorePath = join(dir, "runs.jsonl");
    server = await createAutobitableServer({
      registryPath,
      runStorePath,
      secret: "dev-secret",
      smBaseUrl: "http://127.0.0.1:1"
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("dry-run validates payload and computes idempotency key without executing", async () => {
    const res = await postJson(`${baseUrl}/webhooks/bitable`, {
      webhook_id: "wh_smoke_script",
      table_id: "tblSmoke",
      view_id: "vewSmoke",
      record_id: "rec001",
      triggered_at: "2026-05-08T12:01:00+08:00",
      dry_run: true
    }, "script-secret");

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.idempotency_key, "wh_smoke_script:tblSmoke:vewSmoke:rec001:2026-05-08T12:01:00+08:00");
  });

  test("rejects non-object JSON bodies before registry routing", async () => {
    const res = await postJson(`${baseUrl}/webhooks/bitable`, null);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /JSON object/);
  });

  test("rejects the default secret when a webhook has its own secret", async () => {
    const res = await postJson(`${baseUrl}/webhooks/bitable`, {
      webhook_id: "wh_smoke_script",
      table_id: "tblSmoke",
      view_id: "vewSmoke",
      record_id: "rec_secret_check",
      dry_run: true
    }, "dev-secret");

    assert.equal(res.status, 401);
    assert.match(res.body.error, /invalid webhook secret/);
  });

  test("rejects fields outside the allowlist", async () => {
    const res = await postJson(`${baseUrl}/webhooks/bitable`, {
      webhook_id: "wh_smoke_script",
      table_id: "tblSmoke",
      view_id: "vewSmoke",
      record_id: "rec002",
      dry_run: true,
      fields: { "未授权字段": "nope" }
    }, "script-secret");

    assert.equal(res.status, 400);
    assert.match(res.body.error, /not allowlisted/);
  });

  test("executes an allowlisted script and returns existing run for duplicate", async () => {
    const payload = {
      webhook_id: "wh_smoke_script",
      table_id: "tblSmoke",
      view_id: "vewSmoke",
      record_id: "rec003",
      triggered_at: "2026-05-08T12:03:00+08:00"
    };
    const first = await postJson(`${baseUrl}/webhooks/bitable`, payload, "script-secret");
    const second = await postJson(`${baseUrl}/webhooks/bitable`, payload, "script-secret");

    assert.equal(first.status, 202);
    assert.equal(first.body.final_status, "success");
    assert.equal(first.body.command_type, "script");
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.run_id, first.body.run_id);

    const runs = await readFile(runStorePath, "utf8");
    assert.match(runs, /"webhook_id":"wh_smoke_script"/);
    assert.match(runs, /"final_status":"success"/);
  });

  test("supplements PATH for script job subprocess toolchains", async () => {
    const pathDir = await mkdtemp(join(tmpdir(), "autobitable-path-test-"));
    const pathCheckRegistryPath = await makeFixtureRegistry(pathDir, {
      webhooks: [
        {
          webhook_id: "wh_path_check",
          display_name: "PATH 烟测",
          description: "验证窄 PATH 下 script_job 仍能找到 Node/lark-cli 工具链。",
          status: "active",
          class: "script_job",
          owner_session: "autobitable",
          created_by: "autobitable",
          category: "平台运维",
          bitable: {
            base_token_alias: "smoke_base",
            table_id: "tblSmoke",
            view_id: "vewSmoke",
            table_name: "Smoke",
            trigger: "manual_button",
            field_allowlist: []
          },
          command: {
            type: "script",
            target_session: "autobitable",
            script_name: "path_env_check",
            argv: [resolve("tests/fixtures/path-env-check.mjs")]
          },
          params_schema: {
            type: "object",
            required: ["webhook_id", "table_id", "view_id", "record_id"]
          },
          idempotency: {
            key_template: "{{webhook_id}}:{{table_id}}:{{view_id}}:{{record_id}}:{{triggered_at}}",
            on_duplicate: "return_existing"
          },
          execution: {
            expected_duration_ms: 30000,
            timeout_ms: 30000,
            concurrency: { scope: "record_id", on_conflict: "skip_if_running" }
          },
          receipt_proof: { kind: "script_output_json", expect_ok: true },
          notify: {
            trigger_failed: { channel: "none" },
            receipt_missing: { channel: "none" },
            succeeded: { channel: "none" }
          },
          writeback: { enabled: false },
          approved_by: "autobitable",
          created_at: "2026-05-09T10:50:00+08:00",
          updated_at: "2026-05-09T10:50:00+08:00"
        }
      ]
    });
    const pathRunStorePath = join(pathDir, "path-runs.jsonl");
    const pathServer = await createAutobitableServer({
      registryPath: pathCheckRegistryPath,
      runStorePath: pathRunStorePath,
      secret: "dev-secret",
      smBaseUrl: "http://127.0.0.1:1"
    });
    await new Promise((resolve) => pathServer.listen(0, "127.0.0.1", resolve));
    const pathAddress = pathServer.address();
    const originalPath = process.env.PATH;
    const originalSmRepoRoot = process.env.SM_REPO_ROOT;
    process.env.SM_REPO_ROOT = "/tmp/supermatrix-public-test";
    process.env.PATH = "/usr/bin:/bin";

    try {
      const res = await postJson(`http://127.0.0.1:${pathAddress.port}/webhooks/bitable`, {
        webhook_id: "wh_path_check",
        table_id: "tblSmoke",
        view_id: "vewSmoke",
        record_id: "recPath",
        triggered_at: "2026-05-09T10:50:00+08:00"
      });

      assert.equal(res.status, 202);
      assert.equal(res.body.final_status, "success");
      const run = JSON.parse((await readFile(pathRunStorePath, "utf8")).trim());
      const pathEntries = run.receipt_evidence.stdout_json.path.split(":");
      assert.ok(pathEntries.includes("/usr/local/bin"));
      assert.ok(pathEntries.includes("/opt/homebrew/bin"));
      assert.ok(pathEntries.includes("/tmp/supermatrix-public-test/node_modules/.bin"));
    } finally {
      process.env.PATH = originalPath;
      if (originalSmRepoRoot === undefined) {
        delete process.env.SM_REPO_ROOT;
      } else {
        process.env.SM_REPO_ROOT = originalSmRepoRoot;
      }
      await new Promise((resolve) => pathServer.close(resolve));
    }
  });

  test("renders record_id into script argv, honors cwd, and stores plain stdout", async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), "autobitable-cwd-test-"));
    const cwdDir = join(scriptDir, "workdir");
    await mkdir(cwdDir, { recursive: true });
    const expectedCwd = await realpath(cwdDir);
    const scriptPath = join(scriptDir, "plain-stdout.mjs");
    await writeFile(scriptPath, `
const recordId = process.argv[process.argv.indexOf("--record-id") + 1];
console.log("record=" + recordId + " cwd=" + process.cwd());
`);
    const plainRegistryPath = await makeFixtureRegistry(scriptDir, {
      webhooks: [
        {
          webhook_id: "wh_plain_script",
          display_name: "Plain stdout script",
          description: "Verify argv template and cwd support.",
          status: "active",
          class: "script_job",
          owner_session: "autobitable",
          created_by: "autobitable",
          category: "平台运维",
          bitable: {
            base_token_alias: "smoke_base",
            table_id: "tblSmoke",
            view_id: "vewSmoke",
            table_name: "Smoke",
            trigger: "manual_button",
            field_allowlist: []
          },
          command: {
            type: "script",
            target_session: "autobitable",
            script_name: "plain_stdout",
            cwd: cwdDir,
            argv: [process.execPath, scriptPath, "--record-id", "{{record_id}}"]
          },
          security: {
            header: "X-SM-Webhook-Secret",
            secret: "plain-secret"
          },
          params_schema: {
            type: "object",
            required: ["webhook_id", "table_id", "view_id", "record_id"]
          },
          idempotency: {
            key_template: "{{webhook_id}}:{{record_id}}",
            on_duplicate: "return_existing"
          },
          execution: {
            expected_duration_ms: 30000,
            timeout_ms: 30000,
            concurrency: { scope: "record_id", on_conflict: "skip_if_running" }
          },
          receipt_proof: { kind: "exit_zero" },
          notify: {
            trigger_failed: { channel: "none" },
            receipt_missing: { channel: "none" },
            succeeded: { channel: "none" }
          },
          writeback: { enabled: false },
          approved_by: "autobitable",
          created_at: "2026-05-13T19:00:00+08:00",
          updated_at: "2026-05-13T19:00:00+08:00"
        }
      ]
    });
    const plainRunStorePath = join(scriptDir, "plain-runs.jsonl");
    const plainServer = await createAutobitableServer({
      registryPath: plainRegistryPath,
      runStorePath: plainRunStorePath,
      secret: "dev-secret",
      smBaseUrl: "http://127.0.0.1:1"
    });
    await new Promise((resolve) => plainServer.listen(0, "127.0.0.1", resolve));
    const plainAddress = plainServer.address();

    try {
      const res = await postJson(`http://127.0.0.1:${plainAddress.port}/webhooks/bitable`, {
        webhook_id: "wh_plain_script",
        table_id: "tblSmoke",
        view_id: "vewSmoke",
        record_id: "recArgv"
      }, "plain-secret");

      assert.equal(res.status, 202);
      assert.equal(res.body.final_status, "success");
      const run = JSON.parse((await readFile(plainRunStorePath, "utf8")).trim());
      assert.equal(run.receipt_evidence.exit_code, 0);
      assert.match(run.receipt_evidence.stdout, /record=recArgv/);
      assert.match(run.receipt_evidence.stdout, new RegExp(`cwd=${expectedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      await new Promise((resolve) => plainServer.close(resolve));
    }
  });

  test("immediate ack script jobs respond before the background script finishes", async () => {
    const scriptDir = await mkdtemp(join(tmpdir(), "autobitable-async-test-"));
    const scriptPath = join(scriptDir, "slow-script.mjs");
    await writeFile(scriptPath, `
setTimeout(() => {
  console.log("async complete");
}, 75);
`);
    const asyncRegistryPath = await makeFixtureRegistry(scriptDir, {
      webhooks: [
        {
          webhook_id: "wh_async_script",
          display_name: "Async script",
          description: "Verify immediate ACK script execution.",
          status: "active",
          class: "script_job",
          owner_session: "autobitable",
          created_by: "autobitable",
          category: "平台运维",
          bitable: {
            base_token_alias: "smoke_base",
            table_id: "tblSmoke",
            view_id: "vewSmoke",
            table_name: "Smoke",
            trigger: "manual_button",
            field_allowlist: []
          },
          command: {
            type: "script",
            target_session: "autobitable",
            script_name: "slow_script",
            argv: [process.execPath, scriptPath]
          },
          security: {
            header: "X-SM-Webhook-Secret",
            secret: "async-secret"
          },
          params_schema: {
            type: "object",
            required: ["webhook_id", "table_id", "view_id", "record_id"]
          },
          idempotency: {
            key_template: "{{webhook_id}}:{{record_id}}",
            on_duplicate: "return_existing"
          },
          execution: {
            expected_duration_ms: 30000,
            timeout_ms: 30000,
            ack_mode: "immediate",
            concurrency: { scope: "record_id", on_conflict: "skip_if_running" }
          },
          receipt_proof: { kind: "exit_zero" },
          notify: {
            trigger_failed: { channel: "none" },
            receipt_missing: { channel: "none" },
            succeeded: { channel: "none" }
          },
          writeback: { enabled: false },
          approved_by: "autobitable",
          created_at: "2026-05-13T19:00:00+08:00",
          updated_at: "2026-05-13T19:00:00+08:00"
        }
      ]
    });
    const asyncRunStorePath = join(scriptDir, "async-runs.jsonl");
    const asyncServer = await createAutobitableServer({
      registryPath: asyncRegistryPath,
      runStorePath: asyncRunStorePath,
      secret: "dev-secret",
      smBaseUrl: "http://127.0.0.1:1"
    });
    await new Promise((resolve) => asyncServer.listen(0, "127.0.0.1", resolve));
    const asyncAddress = asyncServer.address();

    try {
      const res = await postJson(`http://127.0.0.1:${asyncAddress.port}/webhooks/bitable`, {
        webhook_id: "wh_async_script",
        table_id: "tblSmoke",
        view_id: "vewSmoke",
        record_id: "recAsync"
      }, "async-secret");

      assert.equal(res.status, 202);
      assert.equal(res.body.trigger_status, "running");
      assert.equal(res.body.final_status, "pending");
      await delay(150);
      const runs = (await readFile(asyncRunStorePath, "utf8")).trim().split(/\n/u).map((line) => JSON.parse(line));
      assert.equal(runs.length, 2);
      assert.equal(runs[1].final_status, "success");
      assert.match(runs[1].receipt_evidence.stdout, /async complete/);
    } finally {
      await new Promise((resolve) => asyncServer.close(resolve));
    }
  });

  test("routes prompt commands to SuperMatrix spawn", async () => {
    let captured;
    const sm = createServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/spawn");
      let body = "";
      for await (const chunk of req) body += chunk;
      captured = JSON.parse(body);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        childSessionId: "sess_child_test",
        childSessionName: "child_autobitable_test",
        messageRunId: "mr_test"
      }));
    });
    await new Promise((resolve) => sm.listen(0, "127.0.0.1", resolve));
    const smAddress = sm.address();
    const promptServer = await createAutobitableServer({
      registryPath,
      runStorePath: join(dir, "prompt-runs.jsonl"),
      secret: "dev-secret",
      smBaseUrl: `http://127.0.0.1:${smAddress.port}`
    });
    await new Promise((resolve) => promptServer.listen(0, "127.0.0.1", resolve));
    const promptAddress = promptServer.address();

    const res = await postJson(`http://127.0.0.1:${promptAddress.port}/webhooks/bitable`, {
      webhook_id: "wh_smoke_prompt",
      table_id: "tblSmoke",
      view_id: "vewSmoke",
      record_id: "rec004",
      triggered_at: "2026-05-08T12:04:00+08:00"
    }, "prompt-secret");

    assert.equal(res.status, 202);
    assert.equal(res.body.command_type, "prompt");
    assert.equal(res.body.child_session_id, "sess_child_test");
    assert.equal(captured.target, "autobitable");
    assert.equal(captured.from, "autobitable");
    assert.equal(Object.hasOwn(captured, "mode"), false);
    assert.deepEqual(captured.verification_predicate, {
      type: "inbox-message",
      session_name: "autobitable",
      field: "prompt",
      contains_all: ["rec004"],
      expected_window_sec: 3600
    });
    assert.match(captured.prompt, /rec004/);

    await new Promise((resolve) => promptServer.close(resolve));
    await new Promise((resolve) => sm.close(resolve));
  });
});
