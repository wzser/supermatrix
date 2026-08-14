import { execFile, execFileSync, spawn } from "node:child_process";
import os from "node:os";
import util from "node:util";

const execFileAsync = util.promisify(execFile);

export function buildChromeLaunchCommand(profile, { platform = os.platform() } = {}) {
  const profileArgs = [
    `--user-data-dir=${profile.userDataDir}`,
    `--remote-debugging-port=${profile.remoteDebuggingPort}`
  ];

  switch (platform) {
    case "darwin":
      return { command: "open", args: ["-na", "Google Chrome", "--args", ...profileArgs] };
    case "linux":
      return { command: "google-chrome", args: profileArgs };
    default:
      throw new Error(`Managed Chrome launch is not supported on platform: ${platform}`);
  }
}

export async function launchManagedChrome(
  profile,
  {
    execFileImpl = execFileAsync,
    spawnImpl = spawn,
    platform = os.platform()
  } = {}
) {
  const { command, args } = buildChromeLaunchCommand(profile, { platform });
  if (platform === "linux") {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  await execFileImpl(command, args);
}

export async function stopManagedChrome(
  state,
  { execFileSyncImpl = execFileSync, platform = os.platform() } = {}
) {
  const userDataDir = String(state?.userDataDir || "").trim();
  if (!userDataDir) return;

  if (platform === "darwin" || platform === "linux") {
    try {
      execFileSyncImpl("pkill", ["-f", "--", `--user-data-dir=${userDataDir}`], { stdio: "ignore" });
    } catch (error) {
      if (error?.status === 1) return;
      throw error;
    }
    return;
  }

  throw new Error(`Managed Chrome stop is not supported on platform: ${platform}`);
}
