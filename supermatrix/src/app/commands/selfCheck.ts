import type { CommandHandler } from "../commandRegistry.ts";
import { renderLarkSelfCheckMessage } from "../bootSelfCheck/formatReport.ts";
import type { CheckResult } from "../bootSelfCheck/types.ts";

export type SelfCheckHandlerDeps = {
  runChecks: () => Promise<CheckResult[]>;
};

export function createSelfCheckHandler(deps: SelfCheckHandlerDeps): CommandHandler {
  return async () => {
    const results = await deps.runChecks();
    return { replyText: renderLarkSelfCheckMessage(results) };
  };
}
