import { spawn } from "node:child_process";
import type { AbsolutePath } from "../../domain/ids.ts";
import {
  resolveCodexExecutionEffort,
  resolveCodexExecutionModel,
  type CodexCommandBuilderEvidence,
} from "./commandBuilder.ts";
import { normalizeCodexChildEnv } from "./process.ts";
import { resolveCodexRouteModel } from "./routeState.ts";

type JsonRecord = Record<string, unknown>;

export type CodexForkBootstrapInput = {
  sourceBackendSessionId: string;
  sessionName: string;
  branchName: string;
  workdir: AbsolutePath;
  model: string | null | undefined;
  effort: string | null | undefined;
  command?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  onEffortNormalized?: CodexCommandBuilderEvidence["onEffortNormalized"];
};

export function buildCodexForkBootstrapPrompt(input: {
  sessionName: string;
  branchName: string;
}): string {
  return [
    "Use the multi-agent tool to spawn one full-history forked sub-agent with fork_context true.",
    `Initial child prompt: You are initializing SuperMatrix conversation branch "${input.branchName}" for session "${input.sessionName}". Reply with exactly BRANCH_READY. Do not inspect files or make changes.`,
    "Wait for the child to complete.",
    "Do not close the child.",
    "In your final answer, output exactly: CHILD_ID=<id> RESULT=<child result>.",
  ].join("\n");
}

export function buildCodexForkBootstrapArgs(input: CodexForkBootstrapInput): string[] {
  const args = [
    "exec",
    "resume",
    input.sourceBackendSessionId,
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const requestedModel = resolveCodexExecutionModel(input.model);
  // sm-switch route-state resolution, same boundary as the main dispatch
  // (buildCodexAppServerRunPlan): on the deepseek route the intent model is not
  // served by the proxy, so the fork bootstrap must resume on the served model
  // instead of being rejected with 400. Fail-open semantics are the resolver's.
  const model = resolveCodexRouteModel(requestedModel);
  args.push("--model", model);
  // Normalize effort against the requested (intent) model, matching
  // buildCodexAppServerRunPlan: the route only swaps the served model, it must
  // not move the effort ceiling.
  const effort = resolveCodexExecutionEffort(input.effort, requestedModel);
  if (effort && input.effort && effort !== input.effort) {
    input.onEffortNormalized?.({
      kind: "codex_effort_normalized",
      model: requestedModel,
      persistedEffort: input.effort,
      cliEffort: effort,
    });
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort=${effort}`);
  }
  args.push("--", buildCodexForkBootstrapPrompt(input));
  return args;
}

export function extractCodexForkChildIdFromJsonLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const item = getRecord(parsed.item);
  const receiverThreadIds = item ? getStringArray(item.receiver_thread_ids) : null;
  if (receiverThreadIds?.[0]) return receiverThreadIds[0];

  const payload = getRecord(parsed.payload);
  const output = payload ? getString(payload.output) : null;
  const fromOutput = output ? extractAgentIdFromOutput(output) : null;
  if (fromOutput) return fromOutput;

  const text = item ? getString(item.text) : null;
  return text ? extractChildIdFromText(text) : null;
}

export async function runCodexForkBootstrap(input: CodexForkBootstrapInput): Promise<string> {
  const command = input.command ?? "codex";
  const args = buildCodexForkBootstrapArgs(input);
  const child = spawn(command, args, {
    cwd: input.workdir,
    stdio: ["ignore", "pipe", "pipe"],
    env: normalizeCodexChildEnv(input.env ?? process.env),
    detached: true,
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let childId: string | null = null;

  const timeout = setTimeout(() => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
    }
  }, input.timeoutMs ?? 120_000);
  timeout.unref();

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      childId = childId ?? extractCodexForkChildIdFromJsonLine(line);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);
  if (stdoutBuffer.trim()) {
    childId = childId ?? extractCodexForkChildIdFromJsonLine(stdoutBuffer.trim());
  }
  if (code !== 0) {
    throw new Error(
      `codex fork bootstrap failed with exit ${code}: ${stderrBuffer.trim() || "no stderr"}`,
    );
  }
  if (!childId) {
    throw new Error("codex fork bootstrap did not return a child agent id");
  }
  return childId;
}

function extractAgentIdFromOutput(output: string): string | null {
  try {
    const parsed = JSON.parse(output);
    if (isRecord(parsed)) return getString(parsed.agent_id);
  } catch {
    return extractChildIdFromText(output);
  }
  return null;
}

function extractChildIdFromText(text: string): string | null {
  return /CHILD_ID=([0-9a-f-]{36})/u.exec(text)?.[1] ?? null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}
