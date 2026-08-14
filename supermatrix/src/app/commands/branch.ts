import { randomUUID } from "node:crypto";
import { UserError } from "../../domain/errors.ts";
import { asTimestamp, type AbsolutePath, type LarkGroupId, type SessionId, type Timestamp } from "../../domain/ids.ts";
import type { BackendKind, EffortLevel, SessionStatus } from "../../domain/session.ts";
import type { SessionBranchRecord } from "../../domain/sessionBranch.ts";
import type { BindingStore } from "../../ports/BindingStore.ts";
import type { Clock } from "../../ports/Clock.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { getCodexModelCatalogFingerprint, getCodexModelCatalogSnapshot, getCodexModelCatalogSource } from "../../ports/CodexModelCatalog.ts";
import { resolveSessionRuntimeConfig } from "../sessionRuntimeConfigPolicy.ts";

export type BranchHandlerDeps = {
  store: Pick<
    BindingStore,
    | "findByGroup"
    | "findSessionById"
    | "findSessionByName"
    | "findSessionBranch"
    | "getActiveBranch"
    | "applySessionRuntimeConfigMutations"
    | "guardIdleSessionRuntimeConfig"
  >;
  branchService: {
    createBranchFromActive(input: {
      sessionId: SessionId;
      name: string;
      preparedBackendSessionId?: string | null;
      now: Timestamp;
    }): Promise<Pick<SessionBranchRecord, "name" | "sourceBranchName">>;
    switchBranch(input: {
      sessionId: SessionId;
      name: string;
      now: Timestamp;
    }): Promise<Pick<SessionBranchRecord, "name">>;
    listBranches(sessionId: SessionId): Promise<Array<Pick<
      SessionBranchRecord,
      "name" | "forkPending" | "backendSessionId"
    >>>;
  };
  clock: Clock;
  codexForkInitializer?: CodexBranchForkInitializer;
};

export type CodexBranchForkInitializer = (input: {
  sourceBackendSessionId: string;
  sessionName: string;
  branchName: string;
  workdir: AbsolutePath;
  model: string | null;
  effort: EffortLevel | null;
}) => Promise<string>;

type BranchCommandSession = {
  id: SessionId;
  name: string;
  backend: BackendKind;
  status: SessionStatus;
  workdir: AbsolutePath;
  model: string | null;
  effort: EffortLevel | null;
  backendSessionId: string | null;
};

export function createBranchHandler(deps: BranchHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    const session = await resolveCommandSession(deps.store, scope, msg.groupId, args.session);
    if (!session) throw new UserError(scope === "root" ? "用法：/branch <session> [name]" : "此群未绑定 session");
    if (session.status === "busy") throw new UserError("session 正在运行，请等待完成或先 /cancel");

    const branchName = args.name;
    if (!branchName) {
      const active = await deps.store.getActiveBranch(session.id);
      const branches = await deps.branchService.listBranches(session.id);
      const lines = branches.map((b) => {
        const marker = b.name === active.name ? "* " : "- ";
        const state = b.forkPending ? "pending fork" : b.backendSessionId ? "ready" : "fresh";
        return `${marker}${b.name} (${state})`;
      });
      return { replyText: ["branches:", ...lines].join("\n") };
    }

    const active = await deps.store.getActiveBranch(session.id);
    const existing = await deps.store.findSessionBranch(session.id, branchName);
    if (existing) {
      const branch =
        active.name === existing.name
          ? existing
          : await deps.branchService.switchBranch({
              sessionId: session.id,
              name: branchName,
              now: deps.clock.now(),
            });
      return { replyText: `✓ 已切换到 branch「${branch.name}」` };
    }
    let preparedBackendSessionId: string | null = null;
    const sourceBackendSessionId = active.backendSessionId ?? active.sourceBackendSessionId;
    if (session.backend === "kimi" && sourceBackendSessionId) {
      throw new UserError(
        "Kimi backend 暂不支持基于现有对话的 branch fork（ACP 协议未提供 fork RPC）。" +
        "若要在 kimi session 上启用 branch，请先 /reset 清空当前对话，然后 /branch 创建。",
      );
    }
    if (session.backend === "codex" && sourceBackendSessionId) {
      if (!deps.codexForkInitializer) {
        throw new UserError("Codex branch fork initializer is not configured");
      }
      const current = runtimeTuple(session);
      const decision = resolveSessionRuntimeConfig({
        current,
        intent: { kind: "reconcile" },
        catalog: getCodexModelCatalogSnapshot(),
      });
      if (!sameRuntimeTuple(current, decision.after)) {
        await deps.store.applySessionRuntimeConfigMutations([{
          sessionId: session.id,
          expected: current,
          after: decision.after,
          guard: { kind: "idle" },
          audit: {
            id: `cfg_${randomUUID()}`,
            trigger: "branch",
            requested: {},
            decision: decision.action,
            reason: decision.reason,
            catalogSource: getCodexModelCatalogSource(),
            catalogFingerprint: getCodexModelCatalogFingerprint(),
            createdAt: asTimestamp(deps.clock.now()),
          },
        }]);
      }
      const guarded = await deps.store.guardIdleSessionRuntimeConfig(session.id, decision.after);
      if (!guarded.backendSessionId) {
        throw new UserError(
          "Cannot create Codex branch: guarded Codex snapshot has no backend session id. " +
          "Run a Codex turn to establish a resumable session, then retry /branch.",
        );
      }
      preparedBackendSessionId = await deps.codexForkInitializer({
        sourceBackendSessionId: guarded.backendSessionId,
        sessionName: session.name,
        branchName,
        workdir: session.workdir,
        model: guarded.model,
        effort: guarded.effort,
      });
    }
    const branch = await deps.branchService.createBranchFromActive({
      sessionId: session.id,
      name: branchName,
      preparedBackendSessionId,
      now: deps.clock.now(),
    });
    const suffix = preparedBackendSessionId ? ", codex ready" : "";
    return { replyText: `✓ 已创建并切换到 branch「${branch.name}」（from ${branch.sourceBranchName ?? "fresh"}${suffix}）` };
  };
}

function runtimeTuple(session: BranchCommandSession) {
  return {
    backend: session.backend,
    model: session.model,
    effort: session.effort,
    backendSessionId: session.backendSessionId,
  };
}

function sameRuntimeTuple(a: ReturnType<typeof runtimeTuple>, b: ReturnType<typeof runtimeTuple>): boolean {
  return a.backend === b.backend
    && a.model === b.model
    && a.effort === b.effort
    && a.backendSessionId === b.backendSessionId;
}

async function resolveCommandSession(
  store: Pick<BindingStore, "findByGroup" | "findSessionById" | "findSessionByName">,
  scope: "root" | "user" | "child",
  groupId: LarkGroupId,
  rootSessionName?: string,
): Promise<BranchCommandSession | null> {
  if (scope === "user") {
    const binding = await store.findByGroup(groupId);
    if (!binding) return null;
    return await store.findSessionById(binding.sessionId);
  }
  if (!rootSessionName) return null;
  return await store.findSessionByName(rootSessionName);
}
