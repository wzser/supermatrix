#!/usr/bin/env node

const requiredPathEntries = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  process.env.SM_REPO_ROOT ? `${process.env.SM_REPO_ROOT}/node_modules/.bin` : null
].filter(Boolean);

const pathEntries = (process.env.PATH ?? "").split(":");
const missing = requiredPathEntries.filter((entry) => !pathEntries.includes(entry));

if (missing.length > 0) {
  console.error(JSON.stringify({ ok: false, missing, path: process.env.PATH ?? "" }));
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  ok: true,
  summary: "PATH includes script_job toolchain entries",
  path: process.env.PATH
}));
