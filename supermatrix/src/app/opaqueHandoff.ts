import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { AbsolutePath } from "../domain/ids.ts";

const OPAQUE_START = "[opaque_envelope_base64]";
const OPAQUE_END = "[/opaque_envelope_base64]";
const COMMAND_PREFIX = "Invoke exactly this fixed command: ";
const COMMAND_SUFFIX = ".";
const FRAMEWORK_COMM_ID = "'<framework comm_id>'";
const FIXED_EXECUTABLE = "bin/parent-comment-problem-sync.sh";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type OpaqueHandoff = {
  encodedBytes: string;
  bytesSha256: string;
  executable: string;
  args: string[];
};

export type OpaqueHandoffExecutionInput = {
  cwd: AbsolutePath;
  handoff: OpaqueHandoff;
  commId: string;
  signal?: AbortSignal;
};

export type OpaqueHandoffExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type OpaqueHandoffExecutor = (
  input: OpaqueHandoffExecutionInput,
) => Promise<OpaqueHandoffExecutionResult>;

/**
 * Recognise the legacy opaque handoff prompt emitted by pinglunmaster and
 * turn it into an execution contract. The prompt remains the audit record,
 * but the agent is no longer the transport for the opaque bytes.
 */
export function parseOpaqueHandoffPrompt(prompt: string): OpaqueHandoff | null {
  const start = prompt.indexOf(OPAQUE_START);
  if (start < 0) return null;
  const end = prompt.indexOf(OPAQUE_END, start + OPAQUE_START.length);
  if (end < 0) throw new Error("opaque handoff end marker is missing");
  if (prompt.indexOf(OPAQUE_START, start + OPAQUE_START.length) >= 0) {
    throw new Error("opaque handoff contains more than one envelope");
  }
  const encodedBlock = prompt.slice(start + OPAQUE_START.length, end);
  if (!encodedBlock.startsWith("\n") || !encodedBlock.endsWith("\n")) {
    throw new Error("opaque handoff envelope framing is not canonical");
  }
  const encodedBytes = encodedBlock.slice(1, -1);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encodedBytes) || encodedBytes.length === 0) {
    throw new Error("opaque handoff envelope is not base64");
  }
  const bytes = Buffer.from(encodedBytes, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encodedBytes) {
    throw new Error("opaque handoff envelope is not canonical base64");
  }

  const commandStart = prompt.lastIndexOf(COMMAND_PREFIX, start);
  if (commandStart < 0) throw new Error("opaque handoff fixed command is missing");
  const commandLineStart = commandStart + COMMAND_PREFIX.length;
  const commandLineEnd = prompt.indexOf("\n", commandLineStart);
  const commandLine = prompt
    .slice(commandLineStart, commandLineEnd < 0 ? start : commandLineEnd)
    .trim();
  const fixedCommand = `${FIXED_EXECUTABLE} --input - --handoff-comm-id ${FRAMEWORK_COMM_ID}`;
  if (!commandLine.startsWith(fixedCommand)) {
    throw new Error("opaque handoff fixed command is not the supported stdin contract");
  }
  const commandTail = commandLine.slice(fixedCommand.length);
  if (!commandTail.startsWith(COMMAND_SUFFIX) || (commandTail.length > 1 && !/^\.\s/u.test(commandTail))) {
    throw new Error("opaque handoff fixed command has unexpected framing");
  }
  const executable = FIXED_EXECUTABLE;
  if (executable !== FIXED_EXECUTABLE) {
    throw new Error("opaque handoff fixed command is not the registered consumer");
  }
  if (
    executable.startsWith("/") ||
    executable.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/u.test(executable)
  ) {
    throw new Error("opaque handoff executable must be a safe relative path");
  }

  return {
    encodedBytes,
    bytesSha256: createHash("sha256").update(bytes).digest("hex"),
    executable,
    args: ["--input", "-", "--handoff-comm-id", FRAMEWORK_COMM_ID],
  };
}

/** Execute a fixed argv without a shell, feeding the exact decoded bytes. */
export const executeOpaqueHandoff: OpaqueHandoffExecutor = async (input) => {
  const bytes = Buffer.from(input.handoff.encodedBytes, "base64");
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== input.handoff.bytesSha256) {
    throw new Error("opaque handoff bytes digest mismatch");
  }
  if (!input.commId) {
    throw new Error("opaque handoff requires a framework comm id");
  }
  if (
    input.handoff.executable !== FIXED_EXECUTABLE ||
    JSON.stringify(input.handoff.args) !== JSON.stringify(["--input", "-", "--handoff-comm-id", FRAMEWORK_COMM_ID])
  ) {
    throw new Error("opaque handoff consumer contract is not fixed");
  }
  const args = input.handoff.args.map((arg) =>
    arg === FRAMEWORK_COMM_ID ? input.commId : arg,
  );
  return await new Promise<OpaqueHandoffExecutionResult>((resolve, reject) => {
    const child = spawn(input.handoff.executable, args, {
      cwd: input.cwd,
      shell: false,
      detached: true,
      env: {
        ...process.env,
        SM_OPAQUE_HANDOFF_SHA256: input.handoff.bytesSha256,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited; try the direct child.
        }
      }
      try { child.kill(signal); } catch { /* already exited */ }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      terminate();
      forceKillHandle = setTimeout(() => terminate("SIGKILL"), 250);
      if (typeof forceKillHandle === "object" && "unref" in forceKillHandle) forceKillHandle.unref();
      reject(error);
    };
    const onAbort = () => fail(new Error("opaque handoff consumer aborted"));
    if (input.signal?.aborted) {
      onAbort();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail(new Error("opaque handoff consumer stdout exceeded output limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    child.stdin.end(bytes);
  });
};

export async function* runOpaqueHandoff(
  input: OpaqueHandoffExecutionInput,
  executor: OpaqueHandoffExecutor,
): AsyncIterable<import("../domain/events/agentEvent.ts").AgentEvent> {
  yield {
    kind: "started",
    backendSessionId: `opaque-handoff:${input.handoff.bytesSha256}`,
  };
  try {
    if (input.signal?.aborted) throw new Error("opaque handoff consumer aborted");
    const result = await executor(input);
    if (input.signal?.aborted) throw new Error("opaque handoff consumer aborted");
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      yield { kind: "error", message: `opaque handoff consumer failed: ${detail}`, recoverable: false };
      return;
    }
    yield { kind: "completed", finalMessage: result.stdout.trim() };
  } catch (error) {
    yield {
      kind: "error",
      message: `opaque handoff delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: false,
    };
  }
}
