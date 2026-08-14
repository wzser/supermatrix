#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureManagedBrowser } from "./browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROXY_SCRIPT = path.join(ROOT, "scripts", "core", "cdp-proxy.mjs");
const TOKEN_ENV = "CDP_PROXY_TOKEN";
const TOKEN_HEADER = "x-cdp-proxy-token";
const TOKEN_FILE = path.join(os.tmpdir(), "web-access-cdp-proxy.token");

export function parseNodeMajor(version) {
  return Number.parseInt(String(version).split(".")[0], 10);
}

export function parseProxyPort(envValue) {
  if (envValue === undefined || envValue === null || envValue === "") return 3456;
  const port = Number(envValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CDP_PROXY_PORT: ${envValue} (expected integer 1-65535)`);
  }
  return port;
}

export function ensureNode22(version = process.versions.node) {
  const major = parseNodeMajor(version);
  if (!Number.isFinite(major)) {
    throw new Error(`无法解析 Node.js 版本: ${version}`);
  }
  if (major < 22) {
    throw new Error(`需要 Node.js 22+ (当前: v${version})`);
  }
  return major;
}

export function getProxyUnauthorizedMessage(token) {
  if (String(token || "").trim()) {
    return "proxy: unauthorized — token mismatch. Set CDP_PROXY_TOKEN or read token file.";
  }
  return "proxy: unauthorized — proxy is running but token is missing. Set CDP_PROXY_TOKEN or restart cdp-proxy to regenerate the token file.";
}

export function parseArgs(argv) {
  const args = { profile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --profile");
      }
      args.profile = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function getChromeReadyMessage(profile) {
  return `chrome: ok (profile ${profile.name}, port ${profile.remoteDebuggingPort})`;
}

function checkNode() {
  const version = `v${process.versions.node}`;
  try {
    ensureNode22(process.versions.node);
    console.log(`node: ok (${version})`);
  } catch (error) {
    console.error(`node: error (${version}, 需要升级到 22+)`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

function readTokenFile() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function getProxyToken() {
  const envToken = String(process.env[TOKEN_ENV] || "").trim();
  return envToken || readTokenFile();
}

function httpGetJson(url, token, timeoutMs = 3000) {
  const headers = token ? { [TOKEN_HEADER]: token } : {};
  return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      let data = null;
      try {
        data = JSON.parse(await res.text());
      } catch {
        data = null;
      }
      return { status: res.status, data };
    })
    .catch(() => ({ status: 0, data: null }));
}

function logUnauthorized(token) {
  console.log(getProxyUnauthorizedMessage(token));
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), "web-access-cdp-proxy.log");
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    ...(os.platform() === "win32" ? { windowsHide: true } : {})
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy(proxyPort) {
  const targetsUrl = `http://127.0.0.1:${proxyPort}/targets`;
  let token = getProxyToken();
  const targets = await httpGetJson(targetsUrl, token);
  if (targets.status === 401) {
    logUnauthorized(token);
    return false;
  }
  if (Array.isArray(targets.data)) {
    console.log("proxy: ready");
    return true;
  }

  console.log("proxy: connecting...");
  startProxyDetached();
  await new Promise((resolve) => setTimeout(resolve, 2000));

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    token = getProxyToken();
    const result = await httpGetJson(targetsUrl, token, 8000);
    if (result.status === 401) {
      logUnauthorized(token);
      return false;
    }
    if (Array.isArray(result.data)) {
      console.log("proxy: ready");
      return true;
    }
    if (attempt === 1) {
      console.log("⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接...");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("❌ 连接超时，请检查 Chrome 调试设置");
  console.log(`  日志：${path.join(os.tmpdir(), "web-access-cdp-proxy.log")}`);
  return false;
}

export async function ensureProxyReady({ profileName = "" } = {}) {
  const proxyPort = parseProxyPort(process.env.CDP_PROXY_PORT);
  await ensureManagedBrowser({ profileName });
  const ready = await ensureProxy(proxyPort);
  if (!ready) {
    throw new Error("Proxy is not ready. Check CDP_PROXY_TOKEN and proxy startup logs.");
  }
  return true;
}

async function main(argv = process.argv.slice(2)) {
  checkNode();
  const proxyPort = parseProxyPort(process.env.CDP_PROXY_PORT);

  const args = parseArgs(argv);
  const managed = await ensureManagedBrowser({ profileName: args.profile });
  console.log(getChromeReadyMessage({
    name: managed.profile.name,
    remoteDebuggingPort: managed.remoteDebuggingPort
  }));

  if (!(await ensureProxy(proxyPort))) {
    process.exit(1);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  await runCli();
}
