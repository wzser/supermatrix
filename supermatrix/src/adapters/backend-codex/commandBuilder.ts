import { buildPromptWithAttachments } from "../../domain/promptBuilder.ts";
import type { RunInput } from "../../ports/AgentBackend.ts";
import { resolveCodexEnvDefaultModel } from "../../ports/CodexModelCatalog.ts";

export function resolveCodexRunModel(model: string | null | undefined): string {
  return model ?? resolveCodexEnvDefaultModel(process.env["SM_CODEX_DEFAULT_MODEL"]);
}

export function buildCodexArgs(input: RunInput): string[] {
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
  args.push("--model", resolveCodexRunModel(input.session.model));
  if (input.session.effort) {
    const codexEffort = input.session.effort === "max" ? "xhigh" : input.session.effort;
    args.push("-c", `model_reasoning_effort=${codexEffort}`);
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
  const prompt = buildPromptWithAttachments(
    input.prompt,
    promptAttachments,
    input.session.workdir,
  );
  // `codex exec --image <FILE>...` is variadic in CLI 0.128.0. Without an
  // option terminator, a prompt placed after --image is parsed as another
  // image path, leaving Codex to read an empty stdin prompt.
  args.push("--", prompt);
  return args;
}
