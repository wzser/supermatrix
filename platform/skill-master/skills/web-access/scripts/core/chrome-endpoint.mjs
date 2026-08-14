import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function activePortFiles({
  platform = os.platform(),
  home = os.homedir(),
  localAppData = process.env.LOCALAPPDATA || ""
} = {}) {
  switch (platform) {
    case "darwin":
      return [
        path.join(home, "Library/Application Support/Google/Chrome/DevToolsActivePort"),
        path.join(home, "Library/Application Support/Google/Chrome Canary/DevToolsActivePort"),
        path.join(home, "Library/Application Support/Chromium/DevToolsActivePort")
      ];
    case "linux":
      return [
        path.join(home, ".config/google-chrome/DevToolsActivePort"),
        path.join(home, ".config/chromium/DevToolsActivePort")
      ];
    case "win32":
      if (!localAppData) return [];
      return [
        path.join(localAppData, "Google/Chrome/User Data/DevToolsActivePort"),
        path.join(localAppData, "Chromium/User Data/DevToolsActivePort")
      ];
    default:
      return [];
  }
}

export function buildBrowserUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function devToolsActivePortFile(userDataDir) {
  return path.join(userDataDir, "DevToolsActivePort");
}

export function parseDevToolsActivePort(raw = "") {
  const [portLine = "", wsPath = ""] = String(raw).trim().split(/\r?\n/);
  const port = Number.parseInt(portLine, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DevToolsActivePort port: ${portLine}`);
  }
  return { port, wsPath: wsPath || null };
}

export function buildBrowserWsUrl({ port, wsPath = null }) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

export async function resolveBrowserWsUrl({
  port,
  wsPath = null,
  fetchImpl = fetch,
  timeoutMs = 2000
}) {
  const fallbackUrl = buildBrowserWsUrl({ port, wsPath });

  try {
    const response = await fetchImpl(`${buildBrowserUrl(port)}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return fallbackUrl;
    }

    const payload = await response.json();
    const liveBrowserWsUrl = String(payload?.webSocketDebuggerUrl || "").trim();
    if (!liveBrowserWsUrl) {
      return fallbackUrl;
    }
    return liveBrowserWsUrl;
  } catch {
    return fallbackUrl;
  }
}

export function checkPort(port, host = "127.0.0.1", timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function waitForDevToolsActivePort(
  userDataDir,
  { timeoutMs = 10000, pollMs = 200 } = {}
) {
  const filePath = devToolsActivePortFile(userDataDir);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const parsed = parseDevToolsActivePort(fs.readFileSync(filePath, "utf8"));
      if (await checkPort(parsed.port)) return parsed;
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for DevToolsActivePort in ${userDataDir}`);
}

export async function detectChromePort() {
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port)) {
        return port;
      }
    } catch {}
  }

  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) return port;
  }

  return null;
}
