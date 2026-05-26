import type { NotifyRule } from "../../classes/types.js";
import type { ChannelImpls, NotifyContext } from "./types.js";

export function createNotifyRouter(impls: ChannelImpls) {
  return {
    async route(rule: NotifyRule, ctx: NotifyContext): Promise<void> {
      if (rule.channel === "none") return;
      if (rule.channel === "ownerDM") {
        return impls.ownerDM(ctx);
      }
      if (rule.channel === "userDM") {
        return impls.userDM(ctx);
      }
      if (rule.channel === "customChat") {
        if (!rule.target) {
          throw new Error("customChat channel requires a target (chat_id)");
        }
        return impls.customChat(ctx, rule.target);
      }
    },
  };
}

export type { ChannelImpls, NotifyContext };
