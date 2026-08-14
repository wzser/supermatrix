import { UserError } from "../../domain/errors.ts";
import { asTimestamp, type LarkGroupId, type SessionId } from "../../domain/ids.ts";
import type { BackendKind, EffortLevel, Session } from "../../domain/session.ts";
import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";
import {
  codexModelUnknownMessage,
  formatAvailableCodexModels,
  isKnownCodexModel,
  getCodexModelCatalogFingerprint,
  getCodexModelCatalogSnapshot,
  getCodexModelCatalogSource,
} from "../../ports/CodexModelCatalog.ts";
import type { CodexModelAvailability } from "../../ports/CodexModelAvailability.ts";
import type { SessionRuntimeConfigMutation } from "../../ports/BindingStore.ts";
import {
  getConfiguredBackendRuntimeDefaults,
  setConfiguredBackendRuntimeDefaults,
} from "../../ports/BackendRuntimeDefaults.ts";
import { getCodexDefaultModel } from "../../ports/CodexModelCatalog.ts";
import {
  resolveClaudeExecutionModel,
  resolveKimiExecutionModel,
} from "../../ports/RunExecutionConfig.ts";
import { resolveSessionRuntimeConfig } from "../sessionRuntimeConfigPolicy.ts";
import type { SessionRuntimeSettingsSyncScope } from "../sessionRuntimeSettings.ts";
import {
  formatAvailableKimiModels,
  getKimiThinkingCapability,
  isKnownKimiModel,
  kimiModelUnknownMessage,
  KIMI_DEFAULT_MODEL,
  KIMI_HIGHSPEED_MODEL,
  KIMI_K3_MODEL,
} from "../../ports/KimiModelCatalog.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";
import {
  formatChildSessionDefaultsReceipt,
  mutateChildSessionDefaults,
  type ChildSessionDefaultsCommandStore,
} from "./childSessionDefaults.ts";
import { rejectRetiredMainSessionFixed } from "./mainSessionFixed.ts";

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  fable5: "claude-fable-5",
  "fable-5": "claude-fable-5",
  opus: "claude-opus-5",
  opus5: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "opus4.8": "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus4.6": "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  sonnet: "claude-sonnet-5",
  sonnet5: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet4.6": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku4.5": "claude-haiku-4-5-20251001",
  "haiku-4.5": "claude-haiku-4-5-20251001",
};

const AVAILABLE_CLAUDE_MODEL_IDS = new Set(Object.values(CLAUDE_MODEL_ALIASES));

export const CODEX_MODEL_ALIASES: Record<string, string> = {
  "gpt5.6-sol": "gpt-5.6-sol",
  sol: "gpt-5.6-sol",
  "5.6-sol": "gpt-5.6-sol",
  "gpt5.6-terra": "gpt-5.6-terra",
  terra: "gpt-5.6-terra",
  "5.6-terra": "gpt-5.6-terra",
  "gpt5.6-luna": "gpt-5.6-luna",
  luna: "gpt-5.6-luna",
  "5.6-luna": "gpt-5.6-luna",
  "gpt5.5": "gpt-5.5",
  "5.5": "gpt-5.5",
};

const CODEX_DEPRECATED_MODEL_TOKENS: Record<
  string,
  { successorName: "Terra" | "Luna"; successorModel: string }
> = {
  "gpt5.4": { successorName: "Terra", successorModel: "gpt-5.6-terra" },
  "5.4": { successorName: "Terra", successorModel: "gpt-5.6-terra" },
  "gpt-5.4": { successorName: "Terra", successorModel: "gpt-5.6-terra" },
  "gpt5.4-mini": { successorName: "Luna", successorModel: "gpt-5.6-luna" },
  "5.4-mini": { successorName: "Luna", successorModel: "gpt-5.6-luna" },
  mini: { successorName: "Luna", successorModel: "gpt-5.6-luna" },
  "gpt-5.4-mini": { successorName: "Luna", successorModel: "gpt-5.6-luna" },
};

export const KIMI_MODEL_ALIASES: Record<string, string> = {
  kimi: KIMI_DEFAULT_MODEL,
  k2: KIMI_DEFAULT_MODEL,
  "k2.7": KIMI_DEFAULT_MODEL,
  k27: KIMI_DEFAULT_MODEL,
  coding: KIMI_DEFAULT_MODEL,
  "kimi-for-coding": KIMI_DEFAULT_MODEL,
  highspeed: KIMI_HIGHSPEED_MODEL,
  fast: KIMI_HIGHSPEED_MODEL,
  "kimi-for-coding-highspeed": KIMI_HIGHSPEED_MODEL,
  k3: KIMI_K3_MODEL,
};

// Cross-backend rejection matches both a backend's typed aliases AND its
// canonical model ids, so a canonical id typed verbatim into the wrong backend
// (e.g. `/model gpt-5.5` on a kimi session) is identified as that backend's
// model instead of falling through to a generic "unknown" message. Built from
// the static curated alias maps only — deliberately NOT the dynamic codex
// catalog, to keep the message stable regardless of catalog load order.
const ownedKeysAndIds = (aliases: Record<string, string>): Set<string> =>
  new Set([...Object.keys(aliases), ...Object.values(aliases)]);

// The 5.6 family has three co-equal variants (sol/terra/luna) and no base
// model, so a bare 5.6 token cannot resolve. Fail closed (spec 7.1).
export const CODEX_5_6_AMBIGUOUS = new Set(["5.6", "gpt5.6", "gpt-5.6"]);

const CLAUDE_OWNED = ownedKeysAndIds(CLAUDE_MODEL_ALIASES);
const CODEX_OWNED = new Set([
  ...ownedKeysAndIds(CODEX_MODEL_ALIASES),
  ...Object.keys(CODEX_DEPRECATED_MODEL_TOKENS),
  ...CODEX_5_6_AMBIGUOUS,
]);
const KIMI_OWNED = ownedKeysAndIds(KIMI_MODEL_ALIASES);

export function resolveModelAlias(input: string, backend: BackendKind): string {
  const key = canonicalizeToken(input);
  // When nothing curated matches, each branch returns this canonicalized `key`
  // (never the raw `input`) so a mixed-case canonical id (GPT-5.5,
  // CLAUDE-OPUS-4-8) folds to its catalog id; resolveAndValidateModel's catalog
  // check then accepts it or rejects a genuine unknown. Errors below echo `input`.
  if (backend === "claude") {
    if (CODEX_OWNED.has(key))
      throw new UserError(`模型别名「${input}」是 codex 模型，不能用于 claude session`);
    if (KIMI_OWNED.has(key))
      throw new UserError(`模型别名「${input}」是 kimi 模型，不能用于 claude session`);
    return CLAUDE_MODEL_ALIASES[key] ?? key;
  }
  if (backend === "codex") {
    if (CLAUDE_OWNED.has(key))
      throw new UserError(`模型别名「${input}」是 claude 模型，不能用于 codex session`);
    if (KIMI_OWNED.has(key))
      throw new UserError(`模型别名「${input}」是 kimi 模型，不能用于 codex session`);
    const deprecated = CODEX_DEPRECATED_MODEL_TOKENS[key];
    if (deprecated) {
      throw new UserError(
        `Codex 模型「${input}」在 SuperMatrix 中已 hidden/deprecated；` +
        `successor: ${deprecated.successorName} (${deprecated.successorModel})。` +
        "不会自动改写；hidden/deprecated 仅表示该 token 不再作为 SuperMatrix 可选项，" +
        "不代表当前账号必然无法直接执行原模型。",
      );
    }
    if (CODEX_5_6_AMBIGUOUS.has(key))
      throw new UserError("gpt-5.6 有多个候选：sol / terra / luna，请指明具体型号");
    return CODEX_MODEL_ALIASES[key] ?? key;
  }
  // kimi
  if (CLAUDE_OWNED.has(key))
    throw new UserError(`模型别名「${input}」是 claude 模型，不能用于 kimi session`);
  if (CODEX_OWNED.has(key))
    throw new UserError(`模型别名「${input}」是 codex 模型，不能用于 kimi session`);
  return KIMI_MODEL_ALIASES[key] ?? key;
}

export function resolveAndValidateModel(input: string, backend: BackendKind): string {
  const resolved = resolveModelAlias(input, backend);
  if (backend === "claude" && !AVAILABLE_CLAUDE_MODEL_IDS.has(resolved)) {
    throw new UserError(
      `未知或不可用 claude 模型 "${input}"。当前可用：fable / opus / sonnet / haiku / default；当前 opus=claude-opus-5，sonnet=claude-sonnet-5。`,
    );
  }
  if (backend === "codex" && !isKnownCodexModel(resolved)) {
    throw new UserError(codexModelUnknownMessage(resolved));
  }
  if (backend === "kimi" && !isKnownKimiModel(resolved)) {
    throw new UserError(kimiModelUnknownMessage(resolved));
  }
  return resolved;
}

export type CodexModelAliasCatalogDrift = {
  alias: string;
  target: string;
};

export function getCodexModelAliasCatalogDrift(): CodexModelAliasCatalogDrift[] {
  return Object.entries(CODEX_MODEL_ALIASES).filter(
    ([, target]) => !isKnownCodexModel(target),
  ).map(([alias, target]) => ({ alias, target }));
}

export function assertCodexModelAliasesInCatalog(): void {
  const invalid = getCodexModelAliasCatalogDrift();
  if (invalid.length === 0) return;
  const aliases = invalid.map(({ alias, target }) => `${alias}->${target}`).join(", ");
  throw new Error(
    `codex model aliases outside bundled catalog: ${aliases}; available: ${formatAvailableCodexModels()}`,
  );
}

export function assertKimiModelAliasesInCatalog(): void {
  const invalid = Object.entries(KIMI_MODEL_ALIASES).filter(
    ([, target]) => !isKnownKimiModel(target),
  );
  if (invalid.length === 0) return;
  const aliases = invalid.map(([alias, target]) => `${alias}->${target}`).join(", ");
  throw new Error(
    `kimi model aliases outside catalog: ${aliases}; available: ${formatAvailableKimiModels()}`,
  );
}

const BATCH_TARGETS: Record<string, BackendKind | undefined> = {
  all: undefined,
  "all-claude": "claude",
  "all-codex": "codex",
  "all-kimi": "kimi",
};

const DEFAULT_ALIASES = new Set(["default", "默认"]);

function isDefaultToken(token: string): boolean {
  return DEFAULT_ALIASES.has(canonicalizeToken(token));
}

// Route-state awareness for the codex read view. The app layer must not import
// adapters (scripts/check-deps.ts), so the sm-switch route-state/v1 consumer
// (src/adapters/backend-codex/routeState.ts — the same one the dispatch path
// uses) is injected from src/cli/bootstrap.ts. Returning null means "no
// override": passthrough route, unreadable route-state (fail open), or an
// intent model the route already serves.
export type CodexRouteOverrideView = { route: string; model: string };
export type CodexRouteOverrideResolver = (
  intendedModel: string,
) => CodexRouteOverrideView | null;

// Read-only default views. `effective` is read from the same resolvers the run
// path uses (resolveClaudeExecutionModel / getCodexDefaultModel /
// resolveKimiExecutionModel), so this can never drift from what a session
// without an explicit model would actually execute. For codex, the run path
// then passes that model through resolveCodexRouteModel, so the view applies
// the same route override to stay honest while a route is active.
function formatBackendDefaultLine(
  backend: BackendKind,
  resolveCodexRouteOverride?: CodexRouteOverrideResolver,
): string {
  const configured = getConfiguredBackendRuntimeDefaults(backend).model;
  const intended = backend === "claude"
    ? resolveClaudeExecutionModel(null)
    : backend === "codex"
      ? getCodexDefaultModel()
      : resolveKimiExecutionModel(null);
  const override = backend === "codex"
    ? resolveCodexRouteOverride?.(intended) ?? null
    : null;
  const effective = override
    ? `${override.model}（${override.route} 路由覆盖，切回自动恢复；意图 model=${intended}）`
    : intended;
  return `${backend}: configured=${configured ?? "default"}, effective=${effective}`;
}

const GLOBAL_MODEL_SYNTAX = "/model global <claude|codex|kimi> <model-id|default>";

function formatDefaultModelOverview(
  resolveCodexRouteOverride?: CodexRouteOverrideResolver,
): string {
  return [
    "当前默认 model（只读，未做任何写入 / 同步）：",
    formatBackendDefaultLine("claude"),
    formatBackendDefaultLine("codex", resolveCodexRouteOverride),
    formatBackendDefaultLine("kimi"),
    "",
    `修改全局默认：${GLOBAL_MODEL_SYNTAX}；修改单个 session：/model <session-name> <model-id>`,
  ].join("\n");
}

export type SetModelHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<Session | null>;
    updateSessionModel(id: SessionId, model: string | null): Promise<void>;
    getBackendRuntimeDefaults(backend: BackendKind): Promise<{ model: string | null } | null>;
    updateBackendRuntimeDefaults(backend: BackendKind, patch: { model?: string | null; effort?: EffortLevel | null }): Promise<void>;
    listActiveSessionsByBackend(backend?: BackendKind): Promise<Session[]>;
    applySessionRuntimeConfigMutations(mutations: readonly SessionRuntimeConfigMutation[]): Promise<{ updated: number }>;
    getPendingSessionRuntimeConfig(sessionId: SessionId): Promise<{ projected: ReturnType<typeof tuple> } | null>;
    queueSessionRuntimeConfigMutation(mutation: SessionRuntimeConfigMutation): Promise<void>;
  } & ChildSessionDefaultsCommandStore;
  availability?: CodexModelAvailability;
  resolveCodexRouteOverride?: CodexRouteOverrideResolver;
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
  syncSessionTable?: (scope: SessionRuntimeSettingsSyncScope) => void;
};

export function createSetModelHandler(deps: SetModelHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const model = args.model;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (scope === "root" && !sessionName && !model) {
      return { replyText: formatDefaultModelOverview(deps.resolveCodexRouteOverride) };
    }

    if (
      scope === "root" &&
      sessionName === "global" &&
      canonicalizeToken(model ?? "") === "child"
    ) {
      const result = await setChildModelDefaults(deps.store, args.value);
      if (args.value) deps.syncSessionTable?.("current");
      return result;
    }

    if (scope === "root" && sessionName === "global") {
      const backendInput = model?.toLowerCase();
      const value = args.value;
      if (!backendInput) {
        return {
          replyText:
            `全局默认 model：\n` +
            `${formatBackendDefaultLine("claude")}\n` +
            `${formatBackendDefaultLine("codex", deps.resolveCodexRouteOverride)}\n` +
            `${formatBackendDefaultLine("kimi")}`,
        };
      }
      if (backendInput !== "claude" && backendInput !== "codex" && backendInput !== "kimi") {
        throw new UserError("global model 当前支持 backend：claude / codex / kimi");
      }
      if (!value) throw new UserError(`用法：${GLOBAL_MODEL_SYNTAX}`);
      const backend = backendInput as BackendKind;
      const resolved = isDefaultToken(value) ? null : resolveAndValidateModel(value, backend);
      const clearKimiEffort = backend === "kimi" && (
        resolved === null || getKimiThinkingCapability(resolved)?.kind === "fixed-on"
      );
      const patch = clearKimiEffort
        ? { model: resolved, effort: null }
        : { model: resolved };
      await deps.store.updateBackendRuntimeDefaults(backend, patch);
      setConfiguredBackendRuntimeDefaults(backend, patch);
      deps.syncSessionTable?.("current");
      return { replyText: `✓ ${backend} 全局默认 model 已设置为 ${resolved ?? "default"}` };
    }

    if (!sessionName || !model) {
      throw new UserError(
        scope === "root"
          ? `用法：/model <session-name|all|all-claude|all-codex|all-kimi> <model-id>；或 ${GLOBAL_MODEL_SYNTAX}`
          : "用法：/model <model-id>",
      );
    }

    rejectRetiredMainSessionFixed(model);

    if (scope === "root" && sessionName in BATCH_TARGETS) {
      const backend = BATCH_TARGETS[sessionName];
      const targets = await deps.store.listActiveSessionsByBackend(backend);
      const failures: string[] = [];
      const planned: Array<{ session: Session; resolved: string | null }> = [];
      for (const s of targets) {
        try {
          const resolved = isDefaultToken(model) ? null : resolveAndValidateModel(model, s.backend);
          planned.push({ session: s, resolved });
        } catch (err) {
          failures.push(`${s.name}: ${errorMessage(err)}`);
        }
      }
      if (failures.length > 0) {
        return { replyText: `✗ 未更新任何 session；失败 ${failures.length} 个：\n${failures.join("\n")}` };
      }
      const decisions = planned.map(({ session, resolved }) => ({ session, decision: session.backend === "codex" || session.backend === "kimi"
        ? resolveSessionRuntimeConfig({ current: tuple(session), intent: { kind: "set-model", model: resolved }, catalog: getCodexModelCatalogSnapshot() })
        : { action: "accept" as const, after: { ...tuple(session), model: resolved }, reason: "model changed" } }));
      await deps.store.applySessionRuntimeConfigMutations(decisions.map(({ session, decision }) => mutation(session, decision.after, { model: planned.find((p) => p.session.id === session.id)!.resolved }, "model", decision.action, decision.reason)));
      deps.syncSessionTable?.("current");
      const succeeded = decisions.length;
      const backendTag = backend ? `backend=${backend}` : "all user scope";
      const modelTag = isDefaultToken(model) ? "default" : model;
      const lines = [`✓ 已更新 ${succeeded} 个 session（${backendTag}）→ ${modelTag}`];
      const clamps = decisions.filter(({ decision }) => decision.action === "clamp").map(({ session, decision }) => `${session.name}: ${session.effort}→${decision.after.effort}`);
      if (clamps.length) lines.push(`实际 effort 调整：${clamps.join(", ")}`);
      return { replyText: lines.join("\n") };
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    const resolved = isDefaultToken(model) ? null : resolveAndValidateModel(model, session.backend);
    const pending = session.status === "busy"
      ? await deps.store.getPendingSessionRuntimeConfig(session.id)
      : null;
    const current = pending?.projected ?? tuple(session);
    const decision = session.backend === "codex" || session.backend === "kimi"
      ? resolveSessionRuntimeConfig({ current, intent: { kind: "set-model", model: resolved }, catalog: getCodexModelCatalogSnapshot() })
      : { action: "accept" as const, after: { ...current, model: resolved }, reason: "model changed" };
    if (session.status === "busy") {
      await deps.store.queueSessionRuntimeConfigMutation(
        queuedMutation(session, current, decision.after, { model: resolved }, "model", decision.action, decision.reason),
      );
      return {
        replyText: `✓ session「${sessionName}」模型变更已排队，将在当前 run 结束后生效`,
      };
    }
    await deps.store.applySessionRuntimeConfigMutations([mutation(session, decision.after, { model: resolved }, "model", decision.action, decision.reason)]);
    deps.syncSessionTable?.("current");

    const effortNote = decision.after.effort !== session.effort
      ? `；effort ${session.effort ?? "default"} 与新模型不兼容，已重置为 default`
      : "";
    return {
      replyText: resolved
        ? `✓ session「${sessionName}」模型已切换为 ${resolved}${effortNote}`
        : `✓ session「${sessionName}」已恢复默认模型${effortNote}`,
    };
  };
}

async function setChildModelDefaults(
  store: ChildSessionDefaultsCommandStore,
  value: string | undefined,
) {
  if (!value) {
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  if (canonicalizeToken(value) === "inherit") {
    await mutateChildSessionDefaults(store, () => ({
      model: { configured: false, value: null },
      effort: { configured: false, value: null },
    }));
    return { replyText: await formatChildModelDefaultsReceipt(store) };
  }

  if (isDefaultToken(value)) {
    await mutateChildSessionDefaults(store, () => ({
      model: { configured: true, value: null },
      effort: { configured: false, value: null },
    }));
    return { replyText: await formatChildModelDefaultsReceipt(store) };
  }

  await mutateChildSessionDefaults(store, (defaults) => {
    if (!defaults.backend.configured || !defaults.backend.value) {
      throw new UserError("请先使用 /backend global child <claude|codex|kimi> 配置 child backend");
    }
    const model = resolveAndValidateModel(value, defaults.backend.value);
    return {
      model: { configured: true, value: model },
      effort: { configured: false, value: null },
    };
  });
  return { replyText: await formatChildModelDefaultsReceipt(store) };
}

async function formatChildModelDefaultsReceipt(
  store: ChildSessionDefaultsCommandStore,
): Promise<string> {
  return `${await formatChildSessionDefaultsReceipt(store)}\neffort 已重置为 inherit`;
}

function tuple(session: Session) { return { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backendSessionId }; }
function mutation(session: Session, after: ReturnType<typeof tuple>, requested: { model?: string | null; effort?: EffortLevel | null; backend?: BackendKind }, trigger: string, decision: string, reason: string): SessionRuntimeConfigMutation {
  return { sessionId: session.id, expected: tuple(session), after, guard: { kind: "idle" }, audit: { id: `cfg_${crypto.randomUUID()}`, trigger, requested, decision, reason, catalogSource: getCodexModelCatalogSource(), catalogFingerprint: getCodexModelCatalogFingerprint(), createdAt: asTimestamp(Date.now()) } };
}

function queuedMutation(
  session: Session,
  expected: ReturnType<typeof tuple>,
  after: ReturnType<typeof tuple>,
  requested: { model?: string | null; effort?: EffortLevel | null; backend?: BackendKind },
  trigger: string,
  decision: string,
  reason: string,
): SessionRuntimeConfigMutation {
  return { ...mutation(session, after, requested, trigger, decision, reason), expected };
}
