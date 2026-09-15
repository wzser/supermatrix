import { UserError } from "../../domain/errors.ts";
import { asTimestamp, type LarkGroupId, type SessionId } from "../../domain/ids.ts";
import { isVerifiedClaudeFableModel, type BackendKind, type EffortLevel, type Session } from "../../domain/session.ts";
import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";
import {
  getCodexModelCatalogFingerprint, getCodexModelCatalogSnapshot, getCodexModelCatalogSource,
  getCodexDefaultModel, normalizeCodexReasoningEffortForCli,
} from "../../ports/CodexModelCatalog.ts";
import {
  KIMI_DEFAULT_MODEL,
  getKimiThinkingCapability,
  resolveKimiThinkingLevel,
} from "../../ports/KimiModelCatalog.ts";
import { resolveKimiExecutionModel } from "../../ports/RunExecutionConfig.ts";
import {
  getConfiguredBackendRuntimeDefaults,
  setConfiguredBackendRuntimeDefaults,
} from "../../ports/BackendRuntimeDefaults.ts";
import type { SessionRuntimeConfigMutation } from "../../ports/BindingStore.ts";
import { resolveSessionRuntimeConfig } from "../sessionRuntimeConfigPolicy.ts";
import type { SessionRuntimeSettingsSyncScope } from "../sessionRuntimeSettings.ts";
import type { CommandHandler } from "../commandRegistry.ts";
import { errorMessage } from "../errorMessage.ts";
import {
  formatChildSessionDefaultsReceipt,
  mutateChildSessionDefaults,
  type ChildSessionDefaultsCommandStore,
} from "./childSessionDefaults.ts";
import { rejectRetiredMainSessionFixed } from "./mainSessionFixed.ts";

const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const EFFORT_DEFAULT_ALIASES: ReadonlySet<string> = new Set(["default", "默认"]);
const KNOWN_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);

const CODEX_ULTRACODE_ERROR = "Codex 不支持 effort「ultracode」；请使用当前模型支持的 low / medium / high / xhigh / max / ultra。";

const BATCH_TARGETS: Record<string, BackendKind | undefined> = {
  all: undefined,
  "all-claude": "claude",
  "all-codex": "codex",
  "all-kimi": "kimi",
};

export type SetEffortHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<Session | null>;
    updateSessionEffort(id: SessionId, effort: string | null): Promise<void>;
    getBackendRuntimeDefaults(backend: BackendKind): Promise<{ effort: EffortLevel | null } | null>;
    updateBackendRuntimeDefaults(backend: BackendKind, patch: { effort?: EffortLevel | null }): Promise<void>;
    listActiveSessionsByBackend(backend?: BackendKind): Promise<Session[]>;
    applySessionRuntimeConfigMutations(mutations: readonly SessionRuntimeConfigMutation[]): Promise<{ updated: number }>;
    getPendingSessionRuntimeConfig(sessionId: SessionId): Promise<{ projected: ReturnType<typeof tuple> } | null>;
    queueSessionRuntimeConfigMutation(mutation: SessionRuntimeConfigMutation): Promise<void>;
  } & ChildSessionDefaultsCommandStore;
  resolveUserGroupSession?: (groupId: LarkGroupId) => Promise<{ name: string; id: SessionId } | null>;
  syncSessionTable?: (scope: SessionRuntimeSettingsSyncScope) => void;
};

export function createSetEffortHandler(deps: SetEffortHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;
    const level = args.level;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session");
      sessionName = resolved.name;
    }

    if (
      scope === "root" &&
      sessionName === "global" &&
      canonicalizeToken(level ?? "") === "child"
    ) {
      const result = await setChildEffortDefaults(deps.store, args.value);
      if (args.value) deps.syncSessionTable?.("current");
      return result;
    }

    if (scope === "root" && sessionName === "global") {
      const backendInput = level ? canonicalizeToken(level) : undefined;
      const value = args.value;
      if (!backendInput) {
        const claude = getConfiguredBackendRuntimeDefaults("claude").effort;
        const codex = getConfiguredBackendRuntimeDefaults("codex").effort;
        const codexEffective = codex
          ? normalizeCodexReasoningEffortForCli(codex, getCodexDefaultModel())
          : null;
        const kimi = getConfiguredBackendRuntimeDefaults("kimi").effort;
        const kimiModel = resolveKimiExecutionModel(null);
        const kimiCapability = getKimiThinkingCapability(kimiModel);
        const kimiEffective = kimiCapability?.kind === "levels"
          ? resolveKimiThinkingLevel(kimiModel, kimi)
          : kimiCapability?.kind === "fixed-on"
            ? "fixed-on (thinking on)"
            : "unresolved (model capability unavailable)";
        return {
          replyText:
            `全局默认 effort：\n` +
            `claude: configured=${claude ?? "default"}, effective=${claude ?? "backend default"}\n` +
            `codex: configured=${codex ?? "default"}, effective=${codexEffective ?? "backend default"}\n` +
            `kimi: model=${kimiModel}, configured=${kimi ?? "default"}, effective=${kimiEffective}`,
        };
      }
      if (backendInput !== "claude" && backendInput !== "codex" && backendInput !== "kimi") {
        throw new UserError("global effort 当前支持 backend：claude / codex / kimi");
      }
      if (!value) throw new UserError("用法：/effort global <claude|codex|kimi> <level|default>");
      const backend = backendInput as BackendKind;
      const normalized = normalizeEffortLevelToken(value);
      if (normalized !== "default" && !KNOWN_EFFORTS.has(normalized)) {
        throw new UserError(`无效的 effort level：${value}`);
      }
      let effective: EffortLevel | null = null;
      if (normalized !== "default") {
        if (backend === "kimi") {
          const model = resolveKimiExecutionModel(null);
          if (!getKimiThinkingCapability(model)) {
            throw new UserError(`无法确认 kimi 全局模型「${model}」的 thinking 能力；已拒绝设置 effort，请先设置已验证的 Kimi 模型`);
          }
          const requested = resolveAndValidateEffort(normalized, { backend, model });
          effective = resolveKimiThinkingLevel(model, requested);
        } else {
          const requested = resolveAndValidateEffort(normalized, { backend, model: null });
          effective = backend === "claude"
            ? requested
            : normalizeCodexReasoningEffortForCli(requested, getCodexDefaultModel()) as EffortLevel;
        }
      }
      await deps.store.updateBackendRuntimeDefaults(backend, { effort: effective });
      setConfiguredBackendRuntimeDefaults(backend, { effort: effective });
      deps.syncSessionTable?.("current");
      const adjusted = normalized !== "default" && effective !== normalized ? `（${normalized}→${effective}）` : "";
      return { replyText: `✓ ${backend} 全局默认 effort 已设置为 ${effective ?? "default"}${adjusted}` };
    }

    if (!sessionName || !level) {
      throw new UserError(
        scope === "root"
          ? "用法：/effort <session-name|all|all-claude|all-codex|all-kimi> <low|medium|high|xhigh|max|ultra|ultracode|default>；或 /effort global <claude|codex|kimi> <level|default>"
          : "用法：/effort <low|medium|high|xhigh|max|ultra|ultracode|default>",
      );
    }

    rejectRetiredMainSessionFixed(level);

    const normalizedLevel = normalizeEffortLevelToken(level);

    if (normalizedLevel !== "default" && !KNOWN_EFFORTS.has(normalizedLevel)) {
      throw new UserError(
        `无效的 effort level：${level}，可选值：low / medium / high / xhigh / max / ultra / ultracode / default`,
      );
    }

    if (scope === "root" && sessionName in BATCH_TARGETS) {
      const backend = BATCH_TARGETS[sessionName];
      if (backend === "codex" && normalizedLevel === "ultracode") {
        throw new UserError(CODEX_ULTRACODE_ERROR);
      }
      const targets = await deps.store.listActiveSessionsByBackend(backend);
      const failures: string[] = [];
      const kimiSkipped: string[] = [];
      const decisions: Array<{ session: Session; decision: ReturnType<typeof resolveSessionRuntimeConfig> }> = [];
      for (const s of targets) {
        // K2.7 kimi models are fixed-on (thinking has no level dimension):
        // skip them instead of failing the whole batch so a mixed-fleet
        // `/effort all <level>` still lands on K3 kimi and other backends.
        if (s.backend === "kimi" && normalizedLevel !== "default") {
          const capabilityModel = s.model?.trim() || KIMI_DEFAULT_MODEL;
          if (getKimiThinkingCapability(capabilityModel)?.kind !== "levels") {
            kimiSkipped.push(s.name);
            continue;
          }
        }
        try {
          const newEffort = resolveAndValidateEffort(normalizedLevel, s);
          decisions.push({ session: s, decision: resolveSessionRuntimeConfig({ current: tuple(s), intent: { kind: "set-effort", effort: newEffort }, catalog: getCodexModelCatalogSnapshot() }) });
        } catch (err) {
          failures.push(`${s.name}: ${errorMessage(err)}`);
        }
      }
      if (failures.length) return { replyText: `✗ 未更新任何 session；失败 ${failures.length} 个：\n${failures.join("\n")}` };
      await deps.store.applySessionRuntimeConfigMutations(decisions.map(({ session, decision }) => effortMutation(session, decision.after, normalizedLevel === "default" ? null : normalizedLevel as EffortLevel, decision.action, decision.reason)));
      deps.syncSessionTable?.("current");
      const succeeded = decisions.length;
      const backendTag = backend ? `backend=${backend}` : "all user scope";
      const effortTag = normalizedLevel === "default" ? "default" : normalizedLevel;
      const head = `✓ 已更新 ${succeeded} 个 session（${backendTag}）→ ${effortTag}`;
      const clamps = decisions.filter((x) => x.decision.action === "clamp").map((x) => `${x.session.name}: ${normalizedLevel}→${x.decision.after.effort}`);
      const tail = clamps.length ? `\n实际 effort：${clamps.join(", ")}` : "";
      const kimiTail = kimiSkipped.length ? `\n跳过 ${kimiSkipped.length} 个 kimi K2.7 session（thinking 固定 on，无 effort 档位）: ${kimiSkipped.join(", ")}` : "";
      return { replyText: head + tail + kimiTail };
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    const pending = session.status === "busy"
      ? await deps.store.getPendingSessionRuntimeConfig(session.id)
      : null;
    const current = pending?.projected ?? tuple(session);
    const newEffort = resolveAndValidateEffort(normalizedLevel, current);
    const decision = resolveSessionRuntimeConfig({ current, intent: { kind: "set-effort", effort: newEffort }, catalog: getCodexModelCatalogSnapshot() });
    if (session.status === "busy") {
      await deps.store.queueSessionRuntimeConfigMutation(
        queuedEffortMutation(session, current, decision.after, newEffort, decision.action, decision.reason),
      );
      return {
        replyText: `✓ session「${sessionName}」effort 变更已排队，将在当前 run 结束后生效`,
      };
    }
    await deps.store.applySessionRuntimeConfigMutations([effortMutation(session, decision.after, newEffort, decision.action, decision.reason)]);
    deps.syncSessionTable?.("current");

    return {
      replyText: newEffort
        ? decision.action === "clamp"
          ? `✓ session「${sessionName}」effort 已调整：${newEffort}→${decision.after.effort}`
          : `✓ session「${sessionName}」effort 已切换为 ${decision.after.effort}`
        : `✓ session「${sessionName}」已恢复默认 effort`,
    };
  };
}

async function setChildEffortDefaults(
  store: ChildSessionDefaultsCommandStore,
  value: string | undefined,
) {
  if (!value) {
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  if (canonicalizeToken(value) === "inherit") {
    await mutateChildSessionDefaults(store, () => ({
      effort: { configured: false, value: null },
    }));
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  const normalized = normalizeEffortLevelToken(value);
  if (normalized !== "default" && !KNOWN_EFFORTS.has(normalized)) {
    throw new UserError(`无效的 effort level：${value}`);
  }
  if (normalized === "default") {
    await mutateChildSessionDefaults(store, () => ({
      effort: { configured: true, value: null },
    }));
    return { replyText: await formatChildSessionDefaultsReceipt(store) };
  }

  await mutateChildSessionDefaults(store, (defaults) => {
    if (!defaults.backend.configured || !defaults.backend.value) {
      throw new UserError("请先使用 /backend global child <claude|codex|kimi> 配置 child backend");
    }
    const requested = resolveAndValidateEffort(normalized, {
      backend: defaults.backend.value,
      model: defaults.model.configured ? defaults.model.value : null,
    });
    let effective: EffortLevel | null;
    if (defaults.backend.value === "codex") {
      effective = normalizeCodexReasoningEffortForCli(
        requested!,
        defaults.model.configured && defaults.model.value
          ? defaults.model.value
          : getCodexDefaultModel(),
      ) as EffortLevel;
    } else if (defaults.backend.value === "kimi") {
      // Persist the K3-NATIVE level (low/high/max), not the raw request alias
      // (medium/xhigh/ultra), so the stored child default matches the level
      // execution actually applies. resolveAndValidateEffort already rejected
      // fixed-on (K2.7) models above, so the capability here is always
      // "levels" and the mapping never returns null.
      const capabilityModel =
        defaults.model.configured && defaults.model.value
          ? defaults.model.value
          : KIMI_DEFAULT_MODEL;
      effective = resolveKimiThinkingLevel(capabilityModel, requested!);
    } else {
      effective = requested;
    }
    return { effort: { configured: true, value: effective } };
  });
  return { replyText: await formatChildSessionDefaultsReceipt(store) };
}

function normalizeEffortLevelToken(level: string): string {
  const canonical = canonicalizeToken(level);
  return EFFORT_DEFAULT_ALIASES.has(canonical) ? "default" : canonical;
}

function tuple(session: Session) { return { backend: session.backend, model: session.model, effort: session.effort, backendSessionId: session.backendSessionId }; }
function effortMutation(session: Session, after: ReturnType<typeof tuple>, effort: EffortLevel | null, decision: string, reason: string): SessionRuntimeConfigMutation {
  return { sessionId: session.id, expected: tuple(session), after, guard: { kind: "idle" }, audit: { id: `cfg_${crypto.randomUUID()}`, trigger: "effort", requested: { effort }, decision, reason, catalogSource: getCodexModelCatalogSource(), catalogFingerprint: getCodexModelCatalogFingerprint(), createdAt: asTimestamp(Date.now()) } };
}

function queuedEffortMutation(
  session: Session,
  expected: ReturnType<typeof tuple>,
  after: ReturnType<typeof tuple>,
  effort: EffortLevel | null,
  decision: string,
  reason: string,
): SessionRuntimeConfigMutation {
  return { ...effortMutation(session, after, effort, decision, reason), expected };
}

export function resolveAndValidateEffort(
  level: string,
  session: Pick<Session, "backend" | "model">,
): EffortLevel | null {
  if (level === "default") return null;

  if (session.backend === "claude") {
    if (level === "ultracode") {
      if (isVerifiedClaudeFableModel(session.model)) return "ultracode";
      throw new UserError(claudeUltracodeUnsupportedMessage(session.model));
    }
    if (level === "ultra") {
      if (isVerifiedClaudeFableModel(session.model)) {
        throw new UserError(
          "Claude Fable 5 不支持 effort「ultra」；正确的 Claude token 是「ultracode」。ultra 仅适用于支持该档位的 Codex 模型。",
        );
      }
      throw new UserError(
        "Claude CLI 不支持 effort「ultra」；仅 Claude Fable 5 使用「ultracode」，其他 Claude 模型可选 low / medium / high / xhigh / max；ultra 仅适用于支持该档位的 Codex 模型。",
      );
    }
    if (!CLAUDE_EFFORTS.has(level)) {
      throw new UserError(
        `无效的 claude effort level：${level}，可选值：low / medium / high / xhigh / max / default`,
      );
    }
    return level as EffortLevel;
  }

  if (session.backend === "codex") {
    if (level === "ultracode") throw new UserError(CODEX_ULTRACODE_ERROR);
    // The shared policy owns per-model downward clamping. The command surface
    // admits only KNOWN_EFFORTS above, so single and bulk Codex behavior match.
    return level as EffortLevel;
  }

  // kimi: model-aware thinking capability (kimi-code 0.33.0). K3 accepts a
  // level — the shared policy maps it to the native
  // low/high/max at admission. K2.7 models are fixed-on: an explicit level
  // would persist a value that never controls any run, so reject it instead
  // of silently no-oping. `default` (= clear to null) is handled above and
  // stays valid for every kimi model.
  if (level === "ultracode") {
    throw new UserError(
      "kimi 不支持 effort「ultracode」（仅 Claude Fable 5 使用）；K3 模型可选 low / medium / high / xhigh / max / ultra（映射到 K3 原生 low/high/max）。",
    );
  }
  const capabilityModel = session.model?.trim() || KIMI_DEFAULT_MODEL;
  if (getKimiThinkingCapability(capabilityModel)?.kind !== "levels") {
    throw new UserError(
      `kimi 模型「${capabilityModel}」的 thinking 固定为 on，不支持设置 effort「${level}」；K3 模型（k3）才支持档位，或用 default 清除已存值`,
    );
  }
  return level as EffortLevel;
}

function claudeUltracodeUnsupportedMessage(model: string | null): string {
  if (!model?.trim()) {
    return "Claude 全局默认无法设置 effort「ultracode」：它仅支持已验证的 Claude Fable 5（claude-fable-5；旧记录 fable）。请先为目标 session 设置 /model fable 后重试；全局默认请使用 low / medium / high / xhigh / max。";
  }
  return `Claude effort「ultracode」仅支持已验证的 Claude Fable 5（claude-fable-5；旧记录 fable）；当前模型是「${model}」。请先设置 /model fable，或使用 low / medium / high / xhigh / max。`;
}
