const STA_WRITEBACK_COMMAND_RE =
  /^\s*(?<verb>\/sta-writeback|货件写回)\s+task_id\s*=\s*(?:"(?<double>[A-Za-z0-9_-]+)"|'(?<single>[A-Za-z0-9_-]+)'|(?<bare>[A-Za-z0-9_-]+))\s*$/u;

export function parseStaWritebackTaskId(message: string): string | null {
  const match = STA_WRITEBACK_COMMAND_RE.exec(message.normalize("NFKC"));
  if (!match?.groups) return null;
  return match.groups.double ?? match.groups.single ?? match.groups.bare ?? null;
}

export function extractStaWritebackCommandText(content: string): string | undefined {
  const normalized = content.normalize("NFKC").trim();
  const direct = canonicalStaWritebackCommand(normalized);
  if (direct) return direct;

  const card = /^<card(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/card>\s*$/u.exec(normalized);
  if (!card) return undefined;
  for (const line of (card[1] ?? "").split(/\r?\n/u)) {
    const command = canonicalStaWritebackCommand(line.trim());
    if (command) return command;
  }
  return undefined;
}

function canonicalStaWritebackCommand(message: string): string | undefined {
  const taskId = parseStaWritebackTaskId(message);
  if (!taskId) return undefined;
  if (message.trimStart().startsWith("/sta-writeback")) return message;
  return `/sta-writeback task_id="${taskId}"`;
}
