import { execFile } from "node:child_process";
import type { ExecutorResult, ShellConfig } from "./types.js";

export function executeShell(config: ShellConfig): Promise<ExecutorResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "/bin/sh",
      ["-c", config.command],
      { cwd: config.cwd, timeout: config.timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          resolve({ success: false, output: stdout, error: "timeout: command exceeded time limit" });
          return;
        }
        if (error) {
          resolve({ success: false, output: stdout, error: stderr || error.message });
          return;
        }
        resolve({ success: true, output: stdout, error: null });
      }
    );
  });
}
