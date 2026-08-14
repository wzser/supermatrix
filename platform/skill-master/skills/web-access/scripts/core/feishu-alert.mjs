import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCallback);

export async function sendFeishuMessage({
  chatId,
  text,
  markdown,
  profile,
  execFileImpl = defaultExecFile
} = {}) {
  if (!chatId) {
    throw new Error("chatId is required");
  }

  if (text == null && markdown == null) {
    throw new Error("text or markdown is required");
  }

  const args = [];

  if (profile) {
    args.push("--profile", profile);
  }

  args.push("im", "+messages-send", "--as", "bot", "--chat-id", chatId);

  if (markdown != null) {
    args.push("--markdown", markdown);
    return execFileImpl("lark-cli", args).then(() => ({
      chatId,
      content: markdown,
      messageType: "markdown"
    }));
  }

  args.push("--text", text);

  return execFileImpl("lark-cli", args).then(() => ({
    chatId,
    content: text,
    messageType: "text"
  }));
}
