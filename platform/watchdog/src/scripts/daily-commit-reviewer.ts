import { execFileSync as nodeExecFileSync } from "node:child_process";
import {
  mkdtempSync as nodeMkdtempSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CODEX_BIN = "codex";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_TIMEOUT_MS = 120_000;

type ExecFile = (bin: string, args: string[], options: {
  cwd: string;
  encoding: "utf-8";
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}) => unknown;

export type CodexReviewerOptions = {
  codexBin?: string;
  model?: string;
  timeoutMs?: number;
  execFile?: ExecFile;
  makeTempDir?: (prefix: string) => string;
  readFile?: (path: string) => string;
  removeDir?: (path: string) => void;
};

export function buildCodexReviewArgs(prompt: string, outputPath: string, model = DEFAULT_CODEX_MODEL): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--output-last-message",
    outputPath,
    prompt,
  ];
}

export function runCodexReviewer(
  prompt: string,
  cwd: string,
  options: CodexReviewerOptions = {},
): string {
  const codexBin = options.codexBin ?? process.env.WATCHDOG_DAILY_COMMIT_CODEX_BIN ?? DEFAULT_CODEX_BIN;
  const model = options.model ?? process.env.WATCHDOG_DAILY_COMMIT_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execFile = options.execFile ?? nodeExecFileSync;
  const makeTempDir = options.makeTempDir ?? nodeMkdtempSync;
  const readFile = options.readFile ?? ((path: string) => nodeReadFileSync(path, "utf-8"));
  const removeDir = options.removeDir ?? ((path: string) => nodeRmSync(path, { recursive: true, force: true }));

  const tempDir = makeTempDir(join(tmpdir(), "watchdog-daily-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  try {
    execFile(codexBin, buildCodexReviewArgs(prompt, outputPath, model), {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return readFile(outputPath).trim();
  } finally {
    removeDir(tempDir);
  }
}
