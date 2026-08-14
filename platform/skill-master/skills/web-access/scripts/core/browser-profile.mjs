import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBrowserUrl,
  buildBrowserWsUrl,
  checkPort,
  resolveBrowserWsUrl,
  waitForDevToolsActivePort
} from "./chrome-endpoint.mjs";
import { readRuntimeState, writeRuntimeState } from "./browser-runtime-state.mjs";
import { launchManagedChrome, stopManagedChrome } from "./open-managed-chrome.mjs";

export const PROFILES_CONFIG_ENV = "WEB_ACCESS_PROFILES_CONFIG";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROFILES_CONFIG_PATH = path.join(__dirname, "../../config/browser-profiles.json");

export function expandHomeDir(input, home = os.homedir()) {
  const raw = String(input || "").trim();
  if (!raw.startsWith("~/")) return raw;
  return path.join(home, raw.slice(2));
}

function assertValidPort(value, name) {
  let port;

  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    port = Number(value);
  } else {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return port;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

export function parseProfilesConfig(raw, { home = os.homedir() } = {}) {
  const parsed = JSON.parse(raw);
  const profiles = {};

  for (const [name, profile] of Object.entries(parsed.profiles || {})) {
    const remoteDebuggingPort = assertValidPort(profile.remoteDebuggingPort, "remoteDebuggingPort");
    const userDataDir = assertNonEmptyString(profile.userDataDir, "userDataDir");

    profiles[name] = {
      name,
      userDataDir: expandHomeDir(userDataDir, home),
      remoteDebuggingPort,
      description: String(profile.description || "").trim()
    };
  }

  if (!parsed.defaultProfile || !profiles[parsed.defaultProfile]) {
    throw new Error("Invalid defaultProfile: missing target profile");
  }

  const ports = new Set();
  for (const profile of Object.values(profiles)) {
    if (ports.has(profile.remoteDebuggingPort)) {
      throw new Error(`Duplicate remoteDebuggingPort: ${profile.remoteDebuggingPort}`);
    }
    ports.add(profile.remoteDebuggingPort);
  }

  return {
    defaultProfile: parsed.defaultProfile,
    profiles
  };
}

export function loadProfilesConfig(configPath = process.env[PROFILES_CONFIG_ENV] || DEFAULT_PROFILES_CONFIG_PATH) {
  return parseProfilesConfig(fs.readFileSync(configPath, "utf8"));
}

export function resolveProfileName(requestedProfileName, config) {
  return String(requestedProfileName || "").trim() || config.defaultProfile;
}

export function getProfileDefinition(config, requestedProfileName) {
  const name = resolveProfileName(requestedProfileName, config);
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Unknown browser profile: ${name}`);
  }
  return profile;
}

export async function getActiveManagedBrowser({
  loadProfilesConfig: loadProfilesConfigImpl = loadProfilesConfig,
  readRuntimeState: readRuntimeStateImpl = readRuntimeState,
  checkPort: checkPortImpl = checkPort,
  readDevToolsActivePort: readDevToolsActivePortImpl = waitForDevToolsActivePort
} = {}) {
  const state = await readRuntimeStateImpl();
  if (!state?.profileName) return null;

  const config = loadProfilesConfigImpl();
  const profile = config.profiles[state.profileName];
  if (!profile) return null;

  if (!await checkPortImpl(profile.remoteDebuggingPort)) {
    return null;
  }

  try {
    const activePort = await readDevToolsActivePortImpl(profile.userDataDir, {
      timeoutMs: 250,
      pollMs: 50
    });
    return {
      profile,
      remoteDebuggingPort: activePort.port,
      wsPath: activePort.wsPath || null,
      browserUrl: buildBrowserUrl(activePort.port),
      browserWsUrl: buildBrowserWsUrl(activePort)
    };
  } catch {
    return {
      profile,
      remoteDebuggingPort: profile.remoteDebuggingPort,
      wsPath: null,
      browserUrl: buildBrowserUrl(profile.remoteDebuggingPort),
      browserWsUrl: buildBrowserWsUrl({ port: profile.remoteDebuggingPort })
    };
  }
}

export async function ensureManagedBrowser({
  profileName = "",
  loadProfilesConfig: loadProfilesConfigImpl = loadProfilesConfig,
  readRuntimeState: readRuntimeStateImpl = readRuntimeState,
  writeRuntimeState: writeRuntimeStateImpl = writeRuntimeState,
  isManagedBrowserHealthy = async (state) => Boolean(state?.remoteDebuggingPort),
  readDevToolsActivePort = waitForDevToolsActivePort,
  stopManagedChrome: stopManagedChromeImpl = stopManagedChrome,
  launchManagedChrome: launchManagedChromeImpl = launchManagedChrome,
  waitForManagedBrowser = async (profile) => {
    let activePort;
    try {
      activePort = await waitForDevToolsActivePort(profile.userDataDir);
    } catch (error) {
      if (!await checkPort(profile.remoteDebuggingPort)) throw error;
      activePort = {
        port: profile.remoteDebuggingPort,
        wsPath: null
      };
    }
    return {
      remoteDebuggingPort: activePort.port,
      wsPath: activePort.wsPath,
      browserUrl: buildBrowserUrl(activePort.port),
      browserWsUrl: await resolveBrowserWsUrl(activePort)
    };
  }
} = {}) {
  const config = loadProfilesConfigImpl();
  const profile = getProfileDefinition(config, profileName);

  if (!fs.existsSync(profile.userDataDir)) {
    throw new Error(`Managed browser profile directory does not exist: ${profile.userDataDir}`);
  }

  const current = await readRuntimeStateImpl();
  const healthy = current ? await isManagedBrowserHealthy(current) : false;
  if (
    current &&
    current.profileName === profile.name &&
    healthy
  ) {
    let browserWsUrl = current.browserWsUrl || null;
    let wsPath = current.wsPath || null;
    let remoteDebuggingPort = current.remoteDebuggingPort;

    if (!browserWsUrl && !wsPath) {
      try {
        const activePort = await readDevToolsActivePort(profile.userDataDir, {
          timeoutMs: 250,
          pollMs: 50
        });
        wsPath = activePort.wsPath || null;
        remoteDebuggingPort = activePort.port;
        browserWsUrl = buildBrowserWsUrl(activePort);
      } catch (error) {
        if (!await checkPort(profile.remoteDebuggingPort)) throw error;
        remoteDebuggingPort = profile.remoteDebuggingPort;
        browserWsUrl = await resolveBrowserWsUrl({ port: remoteDebuggingPort });
      }
    } else if (!browserWsUrl) {
      browserWsUrl = buildBrowserWsUrl({
        port: remoteDebuggingPort,
        wsPath
      });
    }

    return {
      reused: true,
      profile,
      browserUrl: buildBrowserUrl(remoteDebuggingPort),
      browserWsUrl,
      remoteDebuggingPort,
      wsPath
    };
  }

  if (current) {
    await stopManagedChromeImpl(current);
  }

  await launchManagedChromeImpl(profile);
  const ready = await waitForManagedBrowser(profile);

  await writeRuntimeStateImpl({
    profileName: profile.name,
    userDataDir: profile.userDataDir,
    remoteDebuggingPort: ready.remoteDebuggingPort,
    wsPath: ready.wsPath || null,
    browserWsUrl: ready.browserWsUrl,
    launchedAt: new Date().toISOString()
  });

  return {
    reused: false,
    profile,
    ...ready
  };
}
