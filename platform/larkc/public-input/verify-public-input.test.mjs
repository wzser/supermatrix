import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspace = path.resolve(new URL("..", import.meta.url).pathname);
const publicInput = path.join(workspace, "public-input");
const verifier = "public-input/verify-public-input.mjs";
const manifest = JSON.parse(fs.readFileSync(path.join(publicInput, "card-callback-public-manifest.json"), "utf8"));

function copySelectedArchive() {
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), "larkc-public-"));
  fs.cpSync(publicInput, path.join(archive, "public-input"), { recursive: true });
  for (const relative of manifest.include) {
    const source = path.join(workspace, "card-callback", relative);
    const destination = path.join(archive, "card-callback", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return archive;
}

function runVerifier(archive) {
  try {
    const stdout = execFileSync(process.execPath, [verifier], { cwd: archive, encoding: "utf8" });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withArchive(mutator, expectedMessage) {
  const archive = copySelectedArchive();
  try {
    mutator(archive);
    const result = runVerifier(archive);
    assert.notEqual(result.status, 0);
    assert.match(result.output, new RegExp(expectedMessage));
  } finally {
    fs.rmSync(archive, { recursive: true, force: true });
  }
}

test("verifies a clean selected archive and exact public count", () => {
  const archive = copySelectedArchive();
  try {
    const result = runVerifier(archive);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /"allowlisted_card_files": 14/);
    assert.match(result.output, /"checked_public_files": 19/);
  } finally {
    fs.rmSync(archive, { recursive: true, force: true });
  }
});

test("rejects an extra materialized card file", () => {
  withArchive((archive) => {
    const extra = path.join(archive, "card-callback", "src", "extra.js");
    fs.writeFileSync(extra, "export default true;\n");
  }, "unlisted materialized card file");
});

test("rejects a missing materialized card file", () => {
  withArchive((archive) => fs.rmSync(path.join(archive, "card-callback", "src", "card.js")), "missing allowlist file");
});

test("rejects a source hash mismatch", () => {
  withArchive((archive) => {
    const file = path.join(archive, "card-callback", "src", "card.js");
    fs.appendFileSync(file, "\n");
  }, "SHA-256 mismatch");
});
