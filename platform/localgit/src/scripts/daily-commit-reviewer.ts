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
  input?: string;
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

export function buildCodexReviewArgs(outputPath: string, model = DEFAULT_CODEX_MODEL): string[] {
  // The prompt is piped over stdin ("-"), never placed on argv: a large review payload
  // (hundreds of sampled files) overflows ARG_MAX and spawnSync throws E2BIG — the
  // skill-master 1619-file blocked incident (2026-07-13). `codex exec` reads the agent
  // instructions from stdin when the positional prompt is "-".
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export function runCodexReviewer(
  prompt: string,
  cwd: string,
  options: CodexReviewerOptions = {},
): string {
  const codexBin = options.codexBin ?? process.env.LOCALGIT_DAILY_COMMIT_CODEX_BIN ?? DEFAULT_CODEX_BIN;
  const model = options.model ?? process.env.LOCALGIT_DAILY_COMMIT_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execFile = options.execFile ?? nodeExecFileSync;
  const makeTempDir = options.makeTempDir ?? nodeMkdtempSync;
  const readFile = options.readFile ?? ((path: string) => nodeReadFileSync(path, "utf-8"));
  const removeDir = options.removeDir ?? ((path: string) => nodeRmSync(path, { recursive: true, force: true }));

  const tempDir = makeTempDir(join(tmpdir(), "localgit-daily-codex-"));
  const outputPath = join(tempDir, "last-message.txt");
  try {
    execFile(codexBin, buildCodexReviewArgs(outputPath, model), {
      cwd,
      input: prompt,
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
