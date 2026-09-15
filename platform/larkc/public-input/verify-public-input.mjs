#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname);
const repo = path.resolve(root, "..");
const manifestPath = path.join(root, "lark-install-permissions.v1.json");
const cardManifestPath = path.join(root, "card-callback-public-manifest.json");
const cardPackagePath = path.join(repo, "card-callback", "package.json");
const installDocPath = path.join(root, "LARK_INSTALL_PERMISSIONS.md");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const cardManifest = JSON.parse(fs.readFileSync(cardManifestPath, "utf8"));
const cardPackage = JSON.parse(fs.readFileSync(cardPackagePath, "utf8"));
const installDoc = fs.readFileSync(installDocPath, "utf8");

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const sortedUnique = (items) => [...new Set(items)].sort();
const cardRoot = path.join(repo, cardManifest.source_root);
const expectedSourceCommit = "8e2bb079a4d5a1728bf54f43c3daaa0e3753301a";
const forbidden = [
  /\/Users\//,
  /\/data\//,
  /supermatrix\.db/i,
  /-----BEGIN [A-Z ]+-----/,
  /LARK_APP_SECRET\s*=\s*(?!PROVIDE|REPLACE|<)/i,
  /LARK_APP_ID\s*=\s*cli_(?!x{8,})[a-z0-9]{8,}/i
];

for (const [name, values] of Object.entries({
  user: manifest.identities.user_oauth.required_scopes,
  app: manifest.identities.app.required_scopes
})) {
  check(JSON.stringify(values) === JSON.stringify(sortedUnique(values)), `${name} scopes must be sorted and unique`);
}

check(manifest.contract === "lark-install-permissions.v1", "wrong permission contract id");
check(manifest.lark_cli.version === "1.0.93", "permission contract is not pinned to lark-cli 1.0.93");
check(cardManifest.source_root === "card-callback", "card source root must be card-callback");
check(cardManifest.runtime_dependency.version === "1.73.3", "card SDK version is not pinned to 1.73.3");
check(cardManifest.source?.commit === expectedSourceCommit, `card source commit must be ${expectedSourceCommit}`);
check(cardManifest.materialized_card_subtree?.root === cardManifest.source_root, "materialized card subtree root drifted");
check(cardManifest.materialized_card_subtree?.exact === true, "materialized card subtree must be exact");
check(cardPackage.dependencies?.["@larksuiteoapi/node-sdk"] === "1.73.3", "package.json must exact-pin card SDK to 1.73.3");
for (const [name, version] of Object.entries({
  axios: "1.18.0",
  "form-data": "4.0.6",
  protobufjs: "8.8.0",
  qs: "6.16.0"
})) {
  check(cardPackage.overrides?.[name] === version, `package.json override drifted: ${name}@${version}`);
}
check(cardManifest.integration_contract.routing_marker === "value.__ask_user === true", "card routing marker drifted");
check(cardManifest.integration_contract.single_consumer.includes("only SDK WSClient"), "single SDK WSClient rule missing");
check(!cardManifest.include.includes("test/e2e.test.js"), "private-path e2e test must not be public input");

const sourceHashes = cardManifest.source?.sha256 ?? {};
const include = cardManifest.include;
check(JSON.stringify(Object.keys(sourceHashes).sort()) === JSON.stringify(sortedUnique(include)), "source hashes must cover exactly the 14 public card files");
for (const [relative, digest] of Object.entries(sourceHashes)) {
  check(/^[a-f0-9]{64}$/.test(digest), `invalid SHA-256 for card-callback/${relative}`);
}
check(!include.some((relative) => relative.startsWith("node_modules/")), "node_modules cannot be a public source asset");
check(!Object.keys(sourceHashes).some((relative) => relative.startsWith("node_modules/")), "node_modules cannot have a source hash");

const baseSection = installDoc.split("## 4. Base schema and writeback contract")[1]?.split("## 5.")[0] ?? "";
for (const line of baseSection.split("\n")) {
  if (/^lark-cli base /.test(line)) check(false, `Base example must select named profile: ${line}`);
}

for (const relative of include) {
  check(!path.isAbsolute(relative), `absolute public allowlist path: ${relative}`);
  const file = path.resolve(cardRoot, relative);
  check(file === cardRoot || file.startsWith(`${cardRoot}${path.sep}`), `public path escapes card subtree: ${relative}`);
  check(fs.existsSync(file), `missing allowlist file: card-callback/${relative}`);
  if (fs.existsSync(file)) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    check(actual === sourceHashes[relative], `SHA-256 mismatch: card-callback/${relative}`);
  }
}

const matchesExclude = (relative) => cardManifest.exclude.some((pattern) => {
  if (pattern.endsWith("/")) return relative.startsWith(pattern);
  if (pattern.startsWith("*")) return relative.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return relative.startsWith(pattern.slice(0, -1));
  return relative === pattern;
});
const materializedFiles = [];
const walk = (directory, prefix = "") => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (!matchesExclude(`${relative}/`)) walk(path.join(directory, entry.name), `${relative}/`);
    } else {
      materializedFiles.push(relative);
    }
  }
};
if (fs.existsSync(cardRoot)) walk(cardRoot);
for (const relative of materializedFiles) {
  check(include.includes(relative) || matchesExclude(relative), `unlisted materialized card file: card-callback/${relative}`);
}
for (const relative of include) {
  check(materializedFiles.includes(relative), `missing materialized card file: card-callback/${relative}`);
}

const publicFiles = [
  path.join(root, "LARK_INSTALL_PERMISSIONS.md"),
  path.join(root, "VERIFICATION.md"),
  path.join(root, "lark-install-permissions.v1.json"),
  path.join(root, "card-callback-public-manifest.json"),
  path.join(root, "card-callback.env.example"),
  ...include.map((relative) => path.join(cardRoot, relative))
];
for (const file of publicFiles) {
  if (!fs.existsSync(file)) {
    check(false, `missing public file: ${path.relative(repo, file)}`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of forbidden) check(!pattern.test(content), `${pattern} matched ${path.relative(repo, file)}`);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  contract: manifest.contract,
  cli: manifest.lark_cli.version,
  card_sdk: cardManifest.runtime_dependency.version,
  allowlisted_card_files: include.length,
  checked_public_files: publicFiles.length,
  network: "not used"
}, null, 2));
