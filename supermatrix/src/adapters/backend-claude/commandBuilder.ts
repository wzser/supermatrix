import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { buildPromptWithAttachments } from "../../domain/promptBuilder.ts";
import type { AttachmentRef, RunInput } from "../../ports/AgentBackend.ts";

const FALLBACK_DEFAULT_MODEL = "claude-opus-4-7";
const MAX_NATIVE_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type ClaudeImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

type ClaudeTextBlock = {
  type: "text";
  text: string;
};

export type ClaudeCommand = {
  args: string[];
  stdin?: string;
};

function buildBaseArgs(input: RunInput): string[] {
  const answerOnly = input.answerOnly === true;
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    // answer-only mode: use default permission mode so tool calls require approval and are
    // effectively denied in non-interactive -p execution, preventing writes and shell access.
    // Residual risk: read-only tool calls (e.g. Bash with safe commands) may still execute;
    // the model cannot write files or run destructive commands without approval.
    answerOnly ? "default" : "bypassPermissions",
  ];
  const model =
    input.session.model ?? process.env["SM_CLAUDE_DEFAULT_MODEL"] ?? FALLBACK_DEFAULT_MODEL;
  args.push("--model", model);
  if (input.session.effort) {
    args.push("--effort", input.session.effort);
  }
  // answer-only mode: no resume — external non-owner gets a fresh ephemeral context
  if (!answerOnly && input.session.backendSessionId) {
    args.push("--resume", input.session.backendSessionId);
  }
  return args;
}

function nativeImagesEnabled(): boolean {
  const raw = process.env["SM_CLAUDE_NATIVE_IMAGE"];
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

function inferImageMediaType(attachment: AttachmentRef): string | undefined {
  const mimeType = attachment.mimeType?.toLowerCase();
  if (mimeType && SUPPORTED_IMAGE_MEDIA_TYPES.has(mimeType)) return mimeType;

  const ext = extname(attachment.originalName || attachment.localPath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

function buildNativeImageBlock(attachment: AttachmentRef): ClaudeImageBlock | undefined {
  const mediaType = inferImageMediaType(attachment);
  if (!mediaType) return undefined;

  try {
    const stat = statSync(attachment.localPath);
    if (!stat.isFile() || stat.size > MAX_NATIVE_IMAGE_BYTES) return undefined;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: readFileSync(attachment.localPath).toString("base64"),
      },
    };
  } catch {
    return undefined;
  }
}

export function buildClaudeCommand(input: RunInput): ClaudeCommand {
  const args = buildBaseArgs(input);
  const attachments = input.attachments ?? [];
  const hintAttachments: AttachmentRef[] = [];
  const nativeImageBlocks: ClaudeImageBlock[] = [];
  const useNativeImages = nativeImagesEnabled();

  for (const attachment of attachments) {
    if (useNativeImages && attachment.kind === "image") {
      const block = buildNativeImageBlock(attachment);
      if (block) {
        nativeImageBlocks.push(block);
        continue;
      }
    }
    hintAttachments.push(attachment);
  }

  const prompt = buildPromptWithAttachments(input.prompt, hintAttachments, input.session.workdir);
  if (nativeImageBlocks.length > 0) {
    args.push("--input-format", "stream-json");
    const stdin = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [...nativeImageBlocks, { type: "text", text: prompt } satisfies ClaudeTextBlock],
      },
    }) + "\n";
    return { args, stdin };
  }

  args.push(prompt);
  return { args };
}

export function buildClaudeArgs(input: RunInput): string[] {
  return buildClaudeCommand(input).args;
}
