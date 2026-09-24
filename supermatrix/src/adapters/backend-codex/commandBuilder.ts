import { buildPromptWithAttachments, prependSystemHint } from "../../domain/promptBuilder.ts";
import type { RunInput } from "../../ports/AgentBackend.ts";
import type { UserInputItem } from "./appServerProtocol.ts";
import {
  getCodexDefaultModel,
  resolveCodexExecutionEffort as resolveCodexExecutionEffortForModel,
} from "../../ports/CodexModelCatalog.ts";
import { resolveRunExecutionConfig } from "../../ports/RunExecutionConfig.ts";
import {
  resolveCodexRouteExecution,
} from "./routeState.ts";
import {
  buildCardAskRuntimeConfig,
  buildCodexCardAskConfigArgs,
} from "../card-ask/config.ts";

export function resolveCodexRunModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Returns the model that will actually execute: the persisted explicit model,
 * or the current verified effective default when the persisted model is null.
 * Persistence intentionally keeps model=null; the pinning to the verified
 * default happens at CLI invocation time.
 */
export function resolveCodexExecutionModel(model: string | null | undefined): string {
  return resolveCodexRunModel(model) ?? getCodexDefaultModel();
}

export function resolveCodexExecutionEffort(
  effort: string | null | undefined,
  model: string,
): string | null {
  return resolveCodexExecutionEffortForModel(effort, model);
}

export type CodexCommandBuilderEvidence = {
  onEffortNormalized?: (evidence: {
    kind: "codex_effort_normalized";
    model: string;
    persistedEffort: string;
    cliEffort: string;
  }) => void;
};

export function buildCodexArgs(input: RunInput, evidence?: CodexCommandBuilderEvidence): string[] {
  if (input.conversationFork?.sourceBackendSessionId) {
    throw new Error(
      "Codex fork is not available in non-interactive JSON mode; codex fork has no --json support in CLI 0.142.0",
    );
  }
  const args: string[] = ["exec"];
  const answerOnly = input.answerOnly === true;
  // answer-only mode: no resume (ephemeral context, no session continuity for external non-owner)
  const isResume = !answerOnly && Boolean(input.session.backendSessionId);
  if (isResume) {
    args.push("resume", input.session.backendSessionId!);
  }
  args.push("--json");
  if (answerOnly) {
    // Safe mode for 外部 non-owner: sandbox without write access, no session persistence.
    // --sandbox read-only restricts filesystem writes; --ephemeral skips workdir creation.
    // Residual risk: if the installed Codex version predates these flags they are silently
    // ignored; in that case the default sandbox still applies (no --dangerously-bypass-...),
    // which is materially safer than the normal owner path.
    args.push("--sandbox", "read-only", "--ephemeral");
  } else {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  const execution = input.execution ?? resolveRunExecutionConfig(input.session);
  const model = execution.model ?? resolveCodexExecutionModel(input.session.model);
  args.push("--model", model);
  // Normalize effort against the exact model on the CLI: sol/terra keep
  // max/ultra, luna clamps ultra->max, legacy 5.5/5.4 clamp max/ultra->xhigh.
  const effort = execution.effort;
  if (effort && input.session.effort && effort !== input.session.effort) {
    evidence?.onEffortNormalized?.({
      kind: "codex_effort_normalized",
      model,
      persistedEffort: input.session.effort,
      cliEffort: effort,
    });
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort=${effort}`);
  }
  const cardAskConfig = buildCardAskRuntimeConfig(input);
  if (cardAskConfig) {
    args.push(...buildCodexCardAskConfigArgs(cardAskConfig));
  }
  if (!isResume) {
    args.push("--cd", input.session.workdir);
  }
  const attachments = input.attachments ?? [];
  const imageAttachments = attachments.filter((a) => a.kind === "image");
  const promptAttachments = attachments.filter((a) => a.kind !== "image");
  for (const attachment of imageAttachments) {
    args.push("--image", attachment.localPath);
  }
  const prompt = prependSystemHint(
    buildPromptWithAttachments(
      input.prompt,
      promptAttachments,
      input.session.workdir,
    ),
    input.systemHint,
  );
  // `codex exec --image <FILE>...` is variadic in CLI 0.128.0. Without an
  // option terminator, a prompt placed after --image is parsed as another
  // image path, leaving Codex to read an empty stdin prompt.
  args.push("--", prompt);
  return args;
}

/**
 * Everything the production run needs to drive one `codex app-server` child
 * for one SuperMatrix run: the argv to spawn, the thread establishment params
 * (start XOR resume), and the turn/start input. Semantics mirror
 * buildCodexArgs so exec-era behavior (answer-only sandbox, owner bypass,
 * model/effort normalization, attachments, card-ask config) carries over.
 */
export type CodexAppServerRunPlan = {
  /** argv after the codex command, e.g. ["app-server", "--listen", "stdio://", ...]. */
  appServerArgs: string[];
  /** Thread id to resume, or null for a fresh thread/start. */
  resumeThreadId: string | null;
  /** User-visible reason for deliberately starting a fresh thread, if any. */
  routeChangeNotice: string | null;
  /** Params for thread/start (resumeThreadId=null) or thread/resume. */
  threadParams: Record<string, unknown>;
  /** turn/start user input items: prompt text plus image attachments. */
  turnInput: UserInputItem[];
  /** Effort for turn/start, normalized against the exact execution model. */
  turnEffort: string | null;
  /** Model actually passed to the app-server; usage-event fallback. */
  model: string;
};

export function buildCodexAppServerRunPlan(
  input: RunInput,
  evidence?: CodexCommandBuilderEvidence,
): CodexAppServerRunPlan {
  if (input.conversationFork?.sourceBackendSessionId) {
    // Fork stays on its dedicated exec-resume bootstrap (forkBootstrap.ts);
    // do not widen fork behavior through the app-server path.
    throw new Error(
      "Codex fork is not available in non-interactive JSON mode; codex fork has no --json support in CLI 0.142.0",
    );
  }
  const answerOnly = input.answerOnly === true;
  const execution = input.execution ?? resolveRunExecutionConfig(input.session);
  const requestedModel = execution.model ?? resolveCodexExecutionModel(input.session.model);
  // Read the route once so the model and history boundary cannot come from
  // different atomic route-state revisions during a live switch.
  const routeExecution = resolveCodexRouteExecution(requestedModel);
  // Thread continuity is determined by the persisted backend thread id.
  // Route activation and backend activity are independently racing observations,
  // so neither is a correctness gate for thread/resume.
  const resumeThreadId = !answerOnly && input.session.backendSessionId
    ? input.session.backendSessionId
    : null;
  const routeChangeNotice = null;

  // sm-switch route-state resolution: on the deepseek route the served model
  // differs from the catalog default, and it must be pinned here so the plan
  // (thread params + usage fallback) records the model that actually serves
  // the run. Effort was already normalized against the requested model and
  // passes through unchanged.
  const model = routeExecution.model;
  const effort = execution.effort;
  if (effort && input.session.effort && effort !== input.session.effort) {
    evidence?.onEffortNormalized?.({
      kind: "codex_effort_normalized",
      model: requestedModel,
      persistedEffort: input.session.effort,
      cliEffort: effort,
    });
  }

  const appServerArgs = ["app-server", "--listen", "stdio://"];
  const cardAskConfig = buildCardAskRuntimeConfig(input);
  if (cardAskConfig) {
    // Same `-c mcp_servers.askserver.*` overrides as exec; app-server accepts
    // the identical -c syntax and applies it to the (single) thread it hosts.
    appServerArgs.push(...buildCodexCardAskConfigArgs(cardAskConfig));
  }

  // Exec parity: owner runs used --dangerously-bypass-approvals-and-sandbox
  // (approvals off + full access); answer-only used --sandbox read-only
  // --ephemeral. Resume omits cwd like exec omitted --cd on resume.
  const threadParams: Record<string, unknown> = resumeThreadId
    ? { threadId: resumeThreadId }
    : { cwd: input.session.workdir };
  threadParams.model = model;
  threadParams.approvalPolicy = "never";
  threadParams.sandbox = answerOnly ? "read-only" : "danger-full-access";
  if (answerOnly) threadParams.ephemeral = true;

  const attachments = input.attachments ?? [];
  const imageAttachments = attachments.filter((a) => a.kind === "image");
  const promptAttachments = attachments.filter((a) => a.kind !== "image");
  const prompt = prependSystemHint(
    buildPromptWithAttachments(input.prompt, promptAttachments, input.session.workdir),
    input.systemHint,
  );
  const turnInput: UserInputItem[] = [
    { type: "text", text: prompt },
    ...imageAttachments.map((a): UserInputItem => ({ type: "localImage", path: a.localPath })),
  ];

  return {
    appServerArgs,
    resumeThreadId,
    routeChangeNotice,
    threadParams,
    turnInput,
    turnEffort: effort ?? null,
    model,
  };
}
