import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerWebhookSecret } from "../scripts/register-webhook-secret.mjs";

test("registers runtime-only secrets and returns the registry hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autobitable-public-secret-registration-"));
  const envFile = join(dir, "adapter.env");
  try {
    await writeFile(envFile, "AUTOBITABLE_WEBHOOK_SECRETS_BY_ID='{}'\n");
    const result = await registerWebhookSecret({ webhookId: "wh_secret_test", envFile });
    const contents = await readFile(envFile, "utf8");
    const map = JSON.parse(contents.match(/='(.*)'/u)[1]);
    assert.equal(result.rotated, false);
    assert.equal(result.secret_sha256, createHash("sha256").update(map.wh_secret_test).digest("hex"));
    assert.match(map.wh_secret_test, /^smwhsec_[A-Za-z0-9_-]+$/u);
    assert.doesNotMatch(JSON.stringify({ result }), new RegExp(map.wh_secret_test, "u"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
