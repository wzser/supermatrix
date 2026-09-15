import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import type { ImmutableIngressDeclaration } from "../domain/childCapabilities.ts";

export type { ImmutableIngressDeclaration } from "../domain/childCapabilities.ts";

export const IMMUTABLE_INGRESS_PROTOCOL = "supermatrix-immutable-ingress/v1" as const;

export type ImmutableIngressIdentityBinding = {
  receiptPointer: string;
  carrierPointer: string;
};

export type ImmutableIngressReceiverInput = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type ImmutableIngressReceiverCleanupFailure = {
  code: "receiver_process_group_cleanup_failed";
  operation: "signal" | "probe";
  signal?: NodeJS.Signals;
  errorCode: string;
};

export type ImmutableIngressReceiverResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  cleanupFailure?: ImmutableIngressReceiverCleanupFailure;
};

export type ImmutableIngressReceiver = (
  input: ImmutableIngressReceiverInput,
) => Promise<ImmutableIngressReceiverResult>;

export type ImmutableIngressAdmission =
  | {
      accepted: true;
      admittedPrompt: string;
      artifactId: string;
      promptSha256: string;
      receiptSha256: string;
      terminalReceiptJson: string;
      eventIdentity: Record<string, unknown>;
    }
  | {
      accepted: false;
      reason: string;
      failure?: ImmutableIngressReceiverCleanupFailure;
    };

export type ImmutableIngressBridge = {
  admit(input: {
    targetSessionName: string;
    targetWorkdir?: string;
    clientRequestId: string;
    prompt: string;
    declaration: ImmutableIngressDeclaration;
    receiverTimeoutMs?: number;
    receiverDeadlineAt?: number;
  }): Promise<ImmutableIngressAdmission>;
};

const MAX_RECEIVER_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECEIVER_TIMEOUT_MS = 30_000;
export const IMMUTABLE_INGRESS_RECEIVER_KILL_GRACE_MS = 250;
export const IMMUTABLE_INGRESS_RESPONSE_OVERHEAD_MS = 50;
const PLACEHOLDER = "{prompt_file}";
const SAFE_RELATIVE_COMMAND = /^[A-Za-z0-9._/-]+$/u;
const POINTER = /^(?:|\/[^/]+(?:\/[^/]*)*)$/u;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function processErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" || typeof code === "number") return String(code);
  }
  return "UNKNOWN";
}

function cleanupFailureReason(failure: ImmutableIngressReceiverCleanupFailure): string {
  const operation = failure.operation === "signal"
    ? `signal ${failure.signal ?? "UNKNOWN"}`
    : "probe";
  return `immutable ingress receiver process group cleanup failed: ${operation} failed with ${failure.errorCode}`;
}

function pointerGet(value: unknown, pointer: string): unknown {
  if (!POINTER.test(pointer)) return undefined;
  if (pointer === "") return value;
  let current: unknown = value;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return undefined;
      current = current[Number(part)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isAdmissionIdentityValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function validateDeclaration(declaration: ImmutableIngressDeclaration): string | null {
  if (!declaration || declaration.protocol !== IMMUTABLE_INGRESS_PROTOCOL) {
    return "ingress declaration protocol is unsupported";
  }
  if (declaration.completionMode !== undefined && declaration.completionMode !== "receiver_terminal") {
    return "ingress completion mode is unsupported";
  }
  if (
    typeof declaration.startMarker !== "string" || declaration.startMarker.length === 0 ||
    typeof declaration.endMarker !== "string" || declaration.endMarker.length === 0 ||
    declaration.startMarker === declaration.endMarker
  ) {
    return "ingress declaration markers are invalid";
  }
  if (
    typeof declaration.command !== "string" ||
    declaration.command.length === 0 ||
    declaration.command.startsWith("/") ||
    declaration.command.includes("..") ||
    !SAFE_RELATIVE_COMMAND.test(declaration.command)
  ) {
    return "ingress receiver command must be a safe relative path";
  }
  if (!Array.isArray(declaration.args) || declaration.args.some((arg) => typeof arg !== "string")) {
    return "ingress receiver args are invalid";
  }
  if (declaration.args.filter((arg) => arg.includes(PLACEHOLDER)).length !== 1) {
    return "ingress receiver must declare exactly one {prompt_file} argument";
  }
  if (declaration.args.some((arg) => arg.includes("{") && arg !== PLACEHOLDER)) {
    return "ingress receiver args contain an unsupported placeholder";
  }
  if (!declaration.receipt || !POINTER.test(declaration.receipt.terminalPointer) || !POINTER.test(declaration.receipt.acceptedPointer)) {
    return "ingress receipt pointers are invalid";
  }
  if (!declaration.receipt.identity || Object.keys(declaration.receipt.identity).length === 0) {
    return "ingress receipt identity bindings are required";
  }
  for (const [name, binding] of Object.entries(declaration.receipt.identity)) {
    if (!name || !binding || !POINTER.test(binding.receiptPointer) || !POINTER.test(binding.carrierPointer)) {
      return "ingress receipt identity binding is invalid";
    }
    if (binding.receiptPointer === "" || binding.carrierPointer === "") {
      return "ingress receipt identity pointers must not target the document root";
    }
  }
  return null;
}

function findCarrier(prompt: string, declaration: ImmutableIngressDeclaration):
  | { start: number; end: number; carrier: Record<string, unknown> }
  | { error: string } {
  const { startMarker, endMarker } = declaration;
  if (prompt.split(startMarker).length !== 2 || prompt.split(endMarker).length !== 2) {
    return { error: "ingress marker missing or ambiguous" };
  }
  const start = prompt.indexOf(startMarker);
  const end = prompt.indexOf(endMarker, start + startMarker.length);
  if (end < 0 || end < start) return { error: "ingress marker framing is invalid" };
  const section = prompt.slice(start + startMarker.length, end).trim();
  if (!section) return { error: "ingress carrier is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(section);
  } catch {
    return { error: "ingress carrier is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "ingress carrier must be a JSON object" };
  }
  return { start, end, carrier: parsed as Record<string, unknown> };
}

/**
 * A declared receiver must only claim prompts that opt into its carrier
 * protocol. Keep this gate deliberately weaker than findCarrier: a prompt
 * containing either exact marker is a carrier attempt and must fail closed if
 * its framing, authentication, or receipt validation is invalid. Plain
 * engineering prompts remain on the ordinary Spawn2 child path.
 */
export function hasImmutableIngressCarrierMarker(
  prompt: string,
  declaration: ImmutableIngressDeclaration,
): boolean {
  return prompt.includes(declaration.startMarker) || prompt.includes(declaration.endMarker);
}

async function persistImmutablePrompt(runtimeRoot: string, clientRequestId: string, bytes: Buffer): Promise<{
  path: string;
  artifactId: string;
  sha256: string;
}> {
  const digest = sha256(bytes);
  const requestDigest = sha256(clientRequestId);
  const dir = join(runtimeRoot, "data", "spawn2", "immutable-ingress", `${requestDigest}-${digest}`);
  const path = join(dir, "prompt.bin");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error("immutable ingress artifact bytes changed");
  }
  await chmod(path, 0o400);
  const stored = await readFile(path);
  if (!stored.equals(bytes)) throw new Error("immutable ingress artifact readback mismatch");
  return { path, artifactId: `sm-immutable-ingress-v1:${digest}`, sha256: digest };
}

function defaultReceiver(input: ImmutableIngressReceiverInput): Promise<ImmutableIngressReceiverResult> {
  return new Promise((resolve) => {
    const child = nodeSpawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationRequested = false;
    let leaderClosed = false;
    let cleanupFailure: ImmutableIngressReceiverCleanupFailure | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ImmutableIngressReceiverResult) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const recordCleanupFailure = (
      operation: ImmutableIngressReceiverCleanupFailure["operation"],
      error: unknown,
      signal?: NodeJS.Signals,
    ) => {
      if (operation === "probe" && cleanupFailure) return;
      cleanupFailure = {
        code: "receiver_process_group_cleanup_failed",
        operation,
        ...(signal ? { signal } : {}),
        errorCode: processErrorCode(error),
      };
    };
    const killGroup = (signal: NodeJS.Signals) => {
      if (typeof child.pid !== "number") return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ESRCH") throw error;
      }
    };
    const probeProcessGroup = (): "present" | "absent" | "unknown" => {
      if (typeof child.pid !== "number") return "absent";
      try {
        process.kill(-child.pid, 0);
        return "present";
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "ESRCH") return "absent";
        recordCleanupFailure("probe", error);
        return "unknown";
      }
    };
    const finishTerminated = () => finish({
      exitCode: 1,
      stdout,
      stderr,
      ...(cleanupFailure ? { cleanupFailure } : {}),
    });
    const proveProcessGroupReaped = () => {
      if (probeProcessGroup() === "absent" && leaderClosed) {
        finishTerminated();
        return;
      }
      reapTimer = setTimeout(proveProcessGroupReaped, 5);
    };
    const terminate = (reason: string) => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      stderr = `${stderr}${stderr ? "\n" : ""}${reason}`;
      try {
        killGroup("SIGTERM");
      } catch (error) {
        recordCleanupFailure("signal", error, "SIGTERM");
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          killGroup("SIGKILL");
        } catch (error) {
          recordCleanupFailure("signal", error, "SIGKILL");
          child.kill("SIGKILL");
        }
        // A group member can retain the inherited stdout/stderr descriptors.
        // Close our copies so close means that the leader was actually
        // reaped, rather than allowing a pipe holder to manufacture a
        // terminal result before process cleanup completes.
        child.stdout?.destroy();
        child.stderr?.destroy();
        proveProcessGroupReaped();
      }, IMMUTABLE_INGRESS_RECEIVER_KILL_GRACE_MS);
    };
    const onAbort = () => terminate("receiver execution aborted");
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout, "utf8") > MAX_RECEIVER_OUTPUT_BYTES) terminate("receiver stdout exceeds limit");
      if (Buffer.byteLength(stderr, "utf8") > MAX_RECEIVER_OUTPUT_BYTES) terminate("receiver stderr exceeds limit");
    };
    child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
    child.once("error", (error) => {
      stderr = `${stderr}${stderr ? "\n" : ""}${error.message}`;
      if (!terminationRequested || typeof child.pid !== "number") finish({ exitCode: 1, stdout, stderr });
    });
    child.once("close", (code) => {
      if (!terminationRequested) {
        finish({ exitCode: code ?? 1, stdout, stderr });
        return;
      }
      leaderClosed = true;
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
  });
}

export function createImmutableIngressBridge(options: {
  runtimeRoot?: string;
  runReceiver?: ImmutableIngressReceiver;
} = {}): ImmutableIngressBridge {
  const runtimeRoot = options.runtimeRoot ?? process.env.SM_RUNTIME_ROOT ?? "/Users/LOCAL_USER/SuperMatrixRuntime";
  const runReceiver = options.runReceiver ?? defaultReceiver;

  return {
    async admit(input) {
      const declarationError = validateDeclaration(input.declaration);
      if (declarationError) return { accepted: false, reason: declarationError };
      const found = findCarrier(input.prompt, input.declaration);
      if ("error" in found) return { accepted: false, reason: found.error };

      const promptBytes = Buffer.from(input.prompt, "utf8");
      let artifact: Awaited<ReturnType<typeof persistImmutablePrompt>>;
      try {
        artifact = await persistImmutablePrompt(runtimeRoot, input.clientRequestId, promptBytes);
      } catch (error) {
        return { accepted: false, reason: `immutable ingress artifact failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      const receiverArgs = input.declaration.args.map((arg) => arg.replace(PLACEHOLDER, artifact.path));
      let result: ImmutableIngressReceiverResult;
      const receiverAbort = new AbortController();
      const receiverTimeoutMs = input.receiverDeadlineAt !== undefined
        ? Math.floor(
          input.receiverDeadlineAt - Date.now() -
          IMMUTABLE_INGRESS_RECEIVER_KILL_GRACE_MS -
          IMMUTABLE_INGRESS_RESPONSE_OVERHEAD_MS,
        )
        : Number.isFinite(input.receiverTimeoutMs) && (input.receiverTimeoutMs ?? 0) > 0
          ? Math.floor(input.receiverTimeoutMs!)
          : DEFAULT_RECEIVER_TIMEOUT_MS;
      if (input.receiverDeadlineAt !== undefined && receiverTimeoutMs <= 0) {
        return {
          accepted: false,
          reason: "immutable ingress receiver-terminal deadline cannot safely accommodate receiver termination",
        };
      }
      const receiverTimer = setTimeout(() => receiverAbort.abort(), receiverTimeoutMs);
      try {
        result = await runReceiver({
          command: input.declaration.command,
          args: receiverArgs,
          cwd: input.targetWorkdir ?? runtimeRoot,
          env: {
            ...process.env,
            SM_IMMUTABLE_INGRESS_ARTIFACT_ID: artifact.artifactId,
            SM_IMMUTABLE_INGRESS_PROMPT_SHA256: artifact.sha256,
          },
          signal: receiverAbort.signal,
        });
      } catch (error) {
        return { accepted: false, reason: `immutable ingress receiver failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        clearTimeout(receiverTimer);
      }
      if (result.cleanupFailure) {
        return {
          accepted: false,
          reason: cleanupFailureReason(result.cleanupFailure),
          failure: result.cleanupFailure,
        };
      }
      if (input.receiverDeadlineAt !== undefined && Date.now() >= input.receiverDeadlineAt) {
        return {
          accepted: false,
          reason: "immutable ingress receiver-terminal deadline expired before receiver completion",
        };
      }
      if (result.exitCode !== 0) {
        return { accepted: false, reason: `immutable ingress receiver rejected: ${result.stderr.trim() || `exit code ${result.exitCode}`}` };
      }
      let receipt: Record<string, unknown>;
      try {
        if (Buffer.byteLength(result.stdout, "utf8") > MAX_RECEIVER_OUTPUT_BYTES) throw new Error("receipt output exceeds limit");
        const parsed = JSON.parse(result.stdout.trim()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("receipt must be a JSON object");
        receipt = parsed as Record<string, unknown>;
      } catch (error) {
        return { accepted: false, reason: `immutable ingress receipt missing or invalid: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (pointerGet(receipt, input.declaration.receipt.terminalPointer) !== true) {
        return { accepted: false, reason: "immutable ingress receipt is not terminal" };
      }
      if (pointerGet(receipt, input.declaration.receipt.acceptedPointer) !== true) {
        return { accepted: false, reason: "immutable ingress receipt target_accepted is not true" };
      }
      const eventIdentity: Record<string, unknown> = {};
      for (const [name, binding] of Object.entries(input.declaration.receipt.identity)) {
        const receiptValue = pointerGet(receipt, binding.receiptPointer);
        const carrierValue = pointerGet(found.carrier, binding.carrierPointer);
        if (receiptValue === undefined || carrierValue === undefined || !sameValue(receiptValue, carrierValue)) {
          return { accepted: false, reason: `immutable ingress receipt identity mismatch: ${name}` };
        }
        if (!isAdmissionIdentityValue(receiptValue) || !isAdmissionIdentityValue(carrierValue)) {
          return { accepted: false, reason: `immutable ingress receipt identity must be scalar: ${name}` };
        }
        eventIdentity[name] = receiptValue;
      }
      try {
        const afterReceiver = await readFile(artifact.path);
        if (!afterReceiver.equals(promptBytes)) {
          return { accepted: false, reason: "immutable ingress artifact bytes changed during receiver" };
        }
      } catch (error) {
        return { accepted: false, reason: `immutable ingress artifact readback failed: ${error instanceof Error ? error.message : String(error)}` };
      }

      if (input.receiverDeadlineAt !== undefined && Date.now() >= input.receiverDeadlineAt) {
        return {
          accepted: false,
          reason: "immutable ingress receiver-terminal deadline expired before receipt persistence",
        };
      }

      const receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
      const receiptSha256 = sha256(receiptBytes);
      const receiptPath = join(runtimeRoot, "data", "spawn2", "immutable-ingress", `${sha256(input.clientRequestId)}-${artifact.sha256}`, "receipt.json");
      try {
        await writeFile(receiptPath, receiptBytes, { flag: "wx", mode: 0o400 });
        await chmod(receiptPath, 0o400);
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
          return { accepted: false, reason: `immutable ingress receipt persistence failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        const existing = await readFile(receiptPath);
        if (!existing.equals(receiptBytes)) return { accepted: false, reason: "immutable ingress receipt readback mismatch" };
      }
      if (input.receiverDeadlineAt !== undefined && Date.now() >= input.receiverDeadlineAt) {
        return {
          accepted: false,
          reason: "immutable ingress receiver-terminal deadline expired before admission",
        };
      }
      // Never splice any part of the caller-controlled prompt or receiver
      // receipt into the child prompt. The receiver saw the exact immutable
      // artifact above, and the full receipt is retained only in the platform
      // audit artifact. The model gets a freshly constructed admission ticket
      // containing only this fixed protocol shape and declared identities.
      const admissionNotice = JSON.stringify({
        protocol: IMMUTABLE_INGRESS_PROTOCOL,
        artifact_id: artifact.artifactId,
        prompt_sha256: artifact.sha256,
        receipt_sha256: receiptSha256,
        event_identity: eventIdentity,
      });
      const admittedPrompt = `[supermatrix immutable ingress admitted]\n${admissionNotice}`;
      return {
        accepted: true,
        admittedPrompt,
        artifactId: artifact.artifactId,
        promptSha256: artifact.sha256,
        receiptSha256,
        terminalReceiptJson: JSON.stringify(receipt),
        eventIdentity,
      };
    },
  };
}
