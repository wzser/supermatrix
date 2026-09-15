#!/usr/bin/env node

// This file intentionally uses only Node built-ins.  It is the dependency-free
// entrypoint: npm must be able to invoke onboarding before node_modules exists.
import { access, constants as fsConstants } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : undefined;
}

const requestedSourceRoot = optionValue("--source-root");
const sourceRoot = resolve(requestedSourceRoot ?? process.env.SM_ONBOARD_SOURCE_ROOT ?? packageRoot);
const npm = process.env.SM_ONBOARD_NPM ?? "npm";
const tsxPath = join(sourceRoot, "node_modules", ".bin", "tsx");
const larkCliPath = join(sourceRoot, "node_modules", ".bin", "lark-cli");

async function executable(file) {
  return access(file, fsConstants.X_OK).then(() => true).catch(() => false);
}

async function installDependencies() {
  const hasLock = await access(join(sourceRoot, "package-lock.json"), fsConstants.R_OK)
    .then(() => true).catch(() => false);
  const command = hasLock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  const child = spawn(npm, command, { cwd: sourceRoot, stdio: "inherit", env: process.env });
  await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${npm} ${command[0]} failed${signal ? ` (${signal})` : ` with exit ${code ?? 1}`}`));
    });
  });
}

if (!isAbsolute(sourceRoot)) {
  throw new Error(`onboarding source root is not absolute: ${sourceRoot}`);
}
if (!await executable(tsxPath) || !await executable(larkCliPath)) {
  await installDependencies();
}
if (!await executable(tsxPath)) {
  throw new Error(`tsx was not installed at ${tsxPath}`);
}

const entrypoint = join(sourceRoot, "scripts", "sm-onboard.ts");
const child = spawn(tsxPath, [entrypoint, ...args], {
  cwd: sourceRoot,
  stdio: "inherit",
  env: process.env,
});
child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
