import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT =
  "/Users/LOCAL_USER/SuperMatrix/scripts/kimi-sea-autonomous-turn-patch.py";
export const KIMI_AUTONOMOUS_TURN_PATCH_BINARY = "/Users/LOCAL_USER/.kimi-code/bin/kimi";
export const KIMI_PATCH_MARKER_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

export type KimiAutonomousTurnPatchResult = {
  status: "pass" | "fail";
  markerCount: number;
  error?: string;
};

export type KimiPatchCommandRunner = (
  command: string,
  args: string[],
  options?: { maxBuffer?: number },
) => string;

function commandFailure(error: unknown): string {
  const failure = error as { message?: unknown; stderr?: unknown };
  const message = typeof failure.message === "string" ? failure.message : String(error);
  const stderr = typeof failure.stderr === "string"
    ? failure.stderr
    : Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString("utf-8")
      : "";
  return [message, stderr]
    .filter((part) => part.trim().length > 0)
    .join("; ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export type KimiBinarySnapshot =
  | {
      status: "pass";
      binaryPath: string;
      snapshotPath: string;
      snapshotDir: string;
      mode: number;
    }
  | { status: "fail"; error: string };

export function snapshotKimiBinary(
  binaryPath = KIMI_AUTONOMOUS_TURN_PATCH_BINARY,
): KimiBinarySnapshot {
  let snapshotDir: string | undefined;
  try {
    const mode = statSync(binaryPath).mode & 0o777;
    snapshotDir = mkdtempSync(join(tmpdir(), "watchdog-kimi-upgrade-"));
    const snapshotPath = join(snapshotDir, "kimi");
    copyFileSync(binaryPath, snapshotPath);
    chmodSync(snapshotPath, mode);
    return {
      status: "pass",
      binaryPath,
      snapshotPath,
      snapshotDir,
      mode,
    };
  } catch (error) {
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    return {
      status: "fail",
      error: `pre-upgrade Kimi binary snapshot failed: ${commandFailure(error)}`,
    };
  }
}

export function restoreKimiBinarySnapshot(
  snapshot: Extract<KimiBinarySnapshot, { status: "pass" }>,
): { status: "pass" } | { status: "fail"; error: string } {
  const restorePath = join(
    dirname(snapshot.binaryPath),
    `.watchdog-kimi-rollback-${process.pid}-${Date.now()}`,
  );
  try {
    copyFileSync(snapshot.snapshotPath, restorePath);
    chmodSync(restorePath, snapshot.mode);
    renameSync(restorePath, snapshot.binaryPath);
    return { status: "pass" };
  } catch (error) {
    rmSync(restorePath, { force: true });
    return {
      status: "fail",
      error: `Kimi binary rollback failed: ${commandFailure(error)}`,
    };
  }
}

export function discardKimiBinarySnapshot(
  snapshot: Extract<KimiBinarySnapshot, { status: "pass" }>,
): void {
  rmSync(snapshot.snapshotDir, { recursive: true, force: true });
}

function runKimiPatchCommand(
  command: string,
  args: string[],
  options?: { maxBuffer?: number },
): string {
  return execFileSync(command, args, {
    encoding: "utf-8",
    timeout: 300000,
    maxBuffer: options?.maxBuffer ?? 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CLI_NO_AUTO_UPDATE: "1",
    },
  });
}

export function runKimiAutonomousTurnPatch(
  runCommand: KimiPatchCommandRunner = runKimiPatchCommand,
): KimiAutonomousTurnPatchResult {
  try {
    runCommand("python3", [KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT]);
  } catch (error) {
    return {
      status: "fail",
      markerCount: 0,
      error: `SM-PATCH restore script failed: ${commandFailure(error)}`,
    };
  }

  try {
    const markerCount = runCommand("strings", [KIMI_AUTONOMOUS_TURN_PATCH_BINARY], {
      maxBuffer: KIMI_PATCH_MARKER_OUTPUT_MAX_BUFFER,
    })
      .split(/\r?\n/u)
      .filter((line) => line.includes("SM-PATCH"))
      .length;
    if (markerCount < 1) {
      return {
        status: "fail",
        markerCount,
        error: `SM-PATCH marker verification failed: strings ${KIMI_AUTONOMOUS_TURN_PATCH_BINARY} | grep -c "SM-PATCH" returned ${markerCount} (expected >= 1)`,
      };
    }
    return { status: "pass", markerCount };
  } catch (error) {
    return {
      status: "fail",
      markerCount: 0,
      error: `SM-PATCH marker verification command failed: ${commandFailure(error)}`,
    };
  }
}

export type KimiPatchFailureSpawnBody = {
  from: "watchdog";
  target: "codexroot";
  prompt: string;
  client_request_id: string;
  closure: {
    kind: "message";
    target: { type: "todo_pool" };
  };
};

export function buildKimiPatchFailureSpawnBody(input: {
  runDate: string;
  patch: KimiAutonomousTurnPatchResult;
}): KimiPatchFailureSpawnBody {
  const failure = input.patch.error ?? `SM-PATCH marker count ${input.patch.markerCount}`;
  return {
    from: "watchdog",
    target: "codexroot",
    client_request_id: `${input.runDate}:watchdog:kimi-sm-patch:codexroot`,
    closure: { kind: "message", target: { type: "todo_pool" } },
    prompt: `Kimi Code 升级后的 SM-PATCH 恢复失败，需要 codexroot（T800）处理。\n\n失败：${failure}\n补丁脚本：${KIMI_AUTONOMOUS_TURN_PATCH_SCRIPT}\n目标二进制：${KIMI_AUTONOMOUS_TURN_PATCH_BINARY}\nmarkerCount：${input.patch.markerCount}\n\n请检查 kimi-code 上游二进制漂移（锚点或 SEA 空闲区）并给出修复与验证证据。watchdog 只负责升级后的调用、审计和失败上报；watchdog 不得修改该补丁脚本或 hand-edit 二进制，由 codexroot 按 owner 边界评估补丁修复。`,
  };
}
