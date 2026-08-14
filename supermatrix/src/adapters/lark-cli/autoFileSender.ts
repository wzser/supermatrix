import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import type { LarkGroupId } from "../../domain/ids.ts";

const execFileP = promisify(execFile);

export type LarkCliAutoFileSenderConfig = {
  larkCliPath: string;
  noProxy?: boolean;
};

type AutoFileDeliveryFlag = "file" | "image" | "video" | "audio";

type LarkCliAutoFileSendInput = {
  groupId: LarkGroupId;
  absolutePath: string;
  flag: AutoFileDeliveryFlag;
  idempotencyKey: string;
};

type LarkCliEnvelope = {
  ok?: boolean;
};

export function createLarkCliAutoFileSender(
  cfg: LarkCliAutoFileSenderConfig,
): (input: LarkCliAutoFileSendInput) => Promise<boolean> {
  return async (input) => {
    const cwd = dirname(input.absolutePath);
    const filename = `./${basename(input.absolutePath)}`;
    const args = [
      "im", "+messages-send",
      "--as", "bot",
      "--chat-id", input.groupId,
      flagToArg(input.flag), filename,
      "--idempotency-key", input.idempotencyKey,
    ];

    let stdout = "";
    try {
      const result = await execFileP(cfg.larkCliPath, args, {
        cwd,
        env: resolveEnv(cfg),
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string };
      stdout = e.stdout ?? "";
      if (!stdout) return false;
    }

    try {
      const parsed = JSON.parse(stdout) as LarkCliEnvelope;
      return parsed.ok === true;
    } catch {
      return false;
    }
  };
}

function flagToArg(flag: AutoFileDeliveryFlag): "--file" | "--image" | "--video" | "--audio" {
  switch (flag) {
    case "image":
      return "--image";
    case "video":
      return "--video";
    case "audio":
      return "--audio";
    case "file":
      return "--file";
  }
}

function resolveEnv(cfg: LarkCliAutoFileSenderConfig): NodeJS.ProcessEnv {
  if (cfg.noProxy === false) return process.env;
  return { ...process.env, LARK_CLI_NO_PROXY: "1" };
}
