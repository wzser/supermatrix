import type { AttachmentRef } from "./attachment.ts";

export type ResolveInput = {
  prompt: string;
  current: AttachmentRef[];
  history: AttachmentRef[];
};

const IMAGE_HINTS = ["图片", "图", "image", "截图", "photo", "picture"];
const FILE_HINTS = ["附件", "文件", "file", "pdf", "word", "excel", "表格", "文档"];

export function resolveAttachments(input: ResolveInput): AttachmentRef[] {
  if (input.current.length > 0) {
    return [...input.current];
  }

  const nameMatches = input.history.filter((att) => {
    const lower = input.prompt.toLowerCase();
    return lower.includes(att.originalName.toLowerCase());
  });
  if (nameMatches.length > 0) return nameMatches;

  const lower = input.prompt.toLowerCase();
  const wantsImage = IMAGE_HINTS.some((h) => lower.includes(h));
  const wantsFile = FILE_HINTS.some((h) => lower.includes(h));

  if (wantsImage) {
    const sorted = [...input.history]
      .filter((a) => a.kind === "image")
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    if (sorted.length > 0) return [sorted[0]];
  }
  if (wantsFile) {
    const sorted = [...input.history]
      .filter((a) => a.kind === "file")
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
    if (sorted.length > 0) return [sorted[0]];
  }

  return [];
}
