import { errorMessage } from "../errorMessage.ts";
import type { BackendRegistry } from "../../ports/AgentBackend.ts";
import { SteerWindowClosedError } from "../../ports/AgentBackend.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { CommandHandler } from "../commandRegistry.ts";

const IDLE_REPLY = "❌ 当前 session 不忙，/now 只能注入正在执行的任务";
const ENDED_REPLY = "❌ 当前任务已结束或已切换，未注入；请重试或使用 /next";
// Distinct from ENDED_REPLY: the run really is still active, but its injection
// window has closed, so "请重试" would be wrong advice — /now can never land on
// this run again. Distinct from UNCONFIRMED_REPLY too: nothing was written, so
// re-sending the text elsewhere is safe.
const WINDOW_CLOSED_REPLY =
  "❌ 本轮已无法注入：当前任务的输入窗口已关闭，指令未进入任务；请用 /next 排到下一轮，或 /cancel 叫停";
const KIMI_UNSUPPORTED_REPLY = "❌ kimi 暂不支持 /now，请使用 /next 或 /cancel";
const ACCEPTED_REPLY = "✓ 已注入当前正在执行的任务";
// Deliberately NOT "注入失败": the outcome is genuinely unknown. claude CLI
// ≥2.1.228 queues mid-turn messages (transcript `queued_command`) and then
// either consumes them — possibly only at the next tool boundary, 15s+ after
// the write — or silently drops them (observed enqueue→remove with the text
// never reaching the model). So neither "已注入" nor "请勿重发" would be
// honest; tell the user how to verify and give the reliable fallback.
const UNCONFIRMED_REPLY =
  "❌ 注入未确认：60 秒内未收到 backend 回执。指令可能已排队、延迟生效，也可能被丢弃；" +
  "请观察任务是否按新指令调整，若无变化，用 /cancel 叫停后重新下达";
const MAX_REASON_LENGTH = 160;
// Sized for CLI ≥2.1.228 queue-then-consume: the replay ack can lag until the
// current tool call finishes (measured 15s on a 30s tool step). Still bounded
// so a dropped message cannot hold the user until the turn's own timeout.
const STEER_ACK_TIMEOUT_MS = 60_000;

export type NowHandlerDeps = {
  store: Pick<
    BindingStore,
    "findByGroup" | "findSessionById" | "findRunningMessageRunBySession"
  >;
  backendRegistry: BackendRegistry;
};

function boundedReason(err: unknown): string {
  return errorMessage(err, "backend 未确认接收")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}

export function createNowHandler(deps: NowHandlerDeps): CommandHandler {
  return async ({ args, msg }) => {
    if (msg.origin !== "lark_user") return { handled: true };

    const binding = await deps.store.findByGroup(msg.groupId);
    if (!binding) return { replyText: "❌ 当前群未绑定 session" };

    const session = await deps.store.findSessionById(binding.sessionId);
    if (!session || session.status === "deleted") {
      return { replyText: "❌ session 不存在或已删除" };
    }
    if (session.status === "error") {
      return { replyText: "❌ session 处于 error 状态，无法使用 /now" };
    }
    if (session.status !== "busy") return { replyText: IDLE_REPLY };

    const running = await deps.store.findRunningMessageRunBySession(session.id);
    if (!running) return { replyText: ENDED_REPLY };
    if (session.backend === "kimi") return { replyText: KIMI_UNSUPPORTED_REPLY };

    const selectedBackend = deps.backendRegistry.get(session.backend);
    if (!selectedBackend.steer) {
      return {
        replyText: `❌ 注入失败：${session.backend} backend 当前运行不支持 /now`,
      };
    }

    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The race only bounds the wait; a late rejection of the losing steer
      // promise is still consumed by the race's own handlers.
      const outcome = await Promise.race([
        selectedBackend
          .steer({
            sessionId: session.id,
            expectedMessageRunId: running.id,
            text: args.text,
          })
          .then(() => "accepted" as const),
        new Promise<"timeout">((resolve) => {
          ackTimer = setTimeout(() => resolve("timeout"), STEER_ACK_TIMEOUT_MS);
        }),
      ]);
      if (outcome === "timeout") return { replyText: UNCONFIRMED_REPLY };
      return { replyText: ACCEPTED_REPLY };
    } catch (err) {
      // Checked before the run-row comparison: the window can close while the
      // row still reads `running`, so that comparison cannot detect this case.
      if (err instanceof SteerWindowClosedError) {
        return { replyText: WINDOW_CLOSED_REPLY };
      }
      const current = await deps.store.findRunningMessageRunBySession(session.id);
      if (!current || current.id !== running.id) return { replyText: ENDED_REPLY };
      return { replyText: `❌ 注入失败：${boundedReason(err)}` };
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
    }
  };
}
