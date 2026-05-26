import { relative, resolve } from "node:path";

type AttachmentLike = {
  kind: "image" | "file";
  localPath: string;
  originalName: string;
};

function relDisplay(absWorkdir: string, att: AttachmentLike): string {
  const rel = relative(absWorkdir, resolve(att.localPath));
  return rel.startsWith("..") ? att.localPath : "./" + rel;
}

export function buildPromptWithAttachments(
  prompt: string,
  attachments: readonly AttachmentLike[],
  workdir: string
): string {
  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind === "file");
  if (images.length === 0 && files.length === 0) return prompt;

  const absWorkdir = resolve(workdir);
  const sections: string[] = [];

  if (images.length > 0) {
    sections.push(
      "用户附加了图片，请用 Read 工具查看：",
      ...images.map((a) => `- ${relDisplay(absWorkdir, a)}  (原名: ${a.originalName})`),
    );
  }
  if (files.length > 0) {
    sections.push(
      "用户附加了文件，请按需用 Read 工具读取：",
      ...files.map((a) => `- ${relDisplay(absWorkdir, a)}  (原名: ${a.originalName})`),
    );
  }

  return prompt + "\n\n---\n" + sections.join("\n");
}
