import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Binding } from "../../domain/binding.ts";
import { UserError } from "../../domain/errors.ts";
import type { LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { AbsolutePath } from "../../domain/ids.ts";
import { parseStaWritebackTaskId } from "../../domain/staWritebackCommand.ts";
import type { CommandHandler } from "../commandRegistry.ts";

const execFileAsync = promisify(execFile);

export type StaWritebackRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type StaWritebackHandlerDeps = {
  store: {
    findByGroup(groupId: LarkGroupId): Promise<Binding | null>;
    findSessionById(sessionId: SessionId): Promise<{
      id: SessionId;
      name: string;
      workdir: AbsolutePath;
      status: string;
    } | null>;
  };
  runScript?: (
    file: string,
    args: string[],
    options: { cwd: string },
  ) => Promise<StaWritebackRunResult>;
};

export function createStaWritebackHandler(deps: StaWritebackHandlerDeps): CommandHandler {
  const runScript = deps.runScript ?? runStaWritebackScript;
  return async ({ scope, msg }) => {
    if (scope !== "user") {
      throw new UserError("/sta-writeback 只能在绑定的 session 群里使用");
    }

    const taskId = parseStaWritebackTaskId(msg.text);
    if (!taskId) {
      throw new UserError('用法：/sta-writeback task_id="<task_id>"');
    }

    const binding = await deps.store.findByGroup(msg.groupId);
    if (!binding) {
      throw new UserError("当前群未绑定 session，无法执行 STA 写回");
    }

    const session = await deps.store.findSessionById(binding.sessionId);
    if (!session || session.status === "deleted") {
      throw new UserError("当前群绑定的 session 不存在或已删除");
    }

    const scriptPath = join(session.workdir, "scripts", "sta_writeback.py");
    const result = await runScript(scriptPath, ["--message", msg.text], {
      cwd: session.workdir,
    });
    const output = lastNonEmptyLine(result.stdout) ?? lastNonEmptyLine(result.stderr);
    if (output) return { replyText: output };

    return {
      replyText: JSON.stringify({
        ok: false,
        task_id: taskId,
        error: `sta_writeback exited with code ${result.code}`,
      }),
    };
  };
}

async function runStaWritebackScript(
  file: string,
  args: string[],
  options: { cwd: string },
): Promise<StaWritebackRunResult> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      code: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (err) {
    const failure = err as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ? String(failure.stdout) : "",
      stderr: failure.stderr ? String(failure.stderr) : failure.message ?? "",
    };
  }
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1];
}
