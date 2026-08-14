import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const RUNTIME_STATE_ENV = "WEB_ACCESS_RUNTIME_STATE_FILE";

export function defaultRuntimeStatePath(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, "web-access-managed-browser.json");
}

function assertStringField(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid runtime state field ${fieldName}`);
  }
  return value;
}

function assertPort(value) {
  let port;

  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    port = Number(value);
  } else {
    throw new Error(`Invalid runtime state remoteDebuggingPort: ${value}`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid runtime state remoteDebuggingPort: ${value}`);
  }

  return port;
}

function validateRuntimeState(state) {
  if (!state || typeof state !== "object") {
    throw new Error("Invalid runtime state: expected object");
  }

  return {
    profileName: assertStringField(state.profileName, "profileName"),
    userDataDir: assertStringField(state.userDataDir, "userDataDir"),
    remoteDebuggingPort: assertPort(state.remoteDebuggingPort),
    launchedAt: state.launchedAt ? String(state.launchedAt) : undefined
  };
}

export async function readRuntimeState(runtimeStatePath = process.env[RUNTIME_STATE_ENV] || defaultRuntimeStatePath()) {
  try {
    return validateRuntimeState(JSON.parse(await fs.readFile(runtimeStatePath, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeRuntimeState(state, runtimeStatePath = process.env[RUNTIME_STATE_ENV] || defaultRuntimeStatePath()) {
  const validated = validateRuntimeState(state);

  await fs.mkdir(path.dirname(runtimeStatePath), { recursive: true });
  await fs.writeFile(runtimeStatePath, `${JSON.stringify(validated, null, 2)}\n`);
  return runtimeStatePath;
}

export async function clearRuntimeState(runtimeStatePath = process.env[RUNTIME_STATE_ENV] || defaultRuntimeStatePath()) {
  try {
    await fs.unlink(runtimeStatePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
