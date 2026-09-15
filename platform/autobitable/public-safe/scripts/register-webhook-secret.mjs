import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_KEY = "AUTOBITABLE_WEBHOOK_SECRETS_BY_ID";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--webhook-id") args.webhookId = argv[++index];
    else if (argv[index] === "--env-file") args.envFile = argv[++index];
    else if (argv[index] === "--rotate") args.rotate = true;
  }
  return args;
}

export async function registerWebhookSecret({ webhookId, envFile, rotate = false }) {
  if (!/^wh_[a-z0-9_-]+$/u.test(webhookId ?? "")) throw new Error("--webhook-id must be a wh_ identifier");
  if (!envFile) throw new Error("--env-file is required; keep this file outside version control");
  const path = resolve(envFile);
  const content = await readFile(path, "utf8");
  const match = content.match(new RegExp(`^(export\\s+)?${ENV_KEY}=(.*)$`, "m"));
  if (!match) throw new Error(`${ENV_KEY} assignment is missing`);
  const raw = match[2].trim();
  const json = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  const secrets = JSON.parse(json || "{}");
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new Error(`${ENV_KEY} must be a JSON object`);
  const existed = Boolean(secrets[webhookId]);
  if (existed && !rotate) throw new Error(`secret already exists for ${webhookId}`);
  const secret = `smwhsec_${randomBytes(32).toString("base64url")}`;
  secrets[webhookId] = secret;
  const replacement = `${match[1] ?? ""}${ENV_KEY}='${JSON.stringify(secrets)}'`;
  const updated = `${content.slice(0, match.index)}${replacement}${content.slice((match.index ?? 0) + match[0].length)}`;
  const temporaryPath = join(dirname(path), `.${webhookId}.${process.pid}.tmp`);
  await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  return { webhook_id: webhookId, rotated: existed, secret_sha256: createHash("sha256").update(secret).digest("hex") };
}

async function main() {
  const result = await registerWebhookSecret(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
