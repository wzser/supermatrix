import { randomUUID } from "node:crypto";
import { UserError } from "../domain/errors.ts";
import type { Timestamp } from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type {
  ChildSessionDefault,
  ChildSessionDefaults,
} from "../ports/ChildSessionDefaults.ts";
import {
  getCodexModelCatalogSnapshot,
  getCodexModelCatalogFingerprint,
  getCodexModelCatalogSource,
} from "../ports/CodexModelCatalog.ts";
import {
  RuntimeConfigConflictError,
  type BindingStore,
  type SessionRuntimeConfigMutation,
} from "../ports/BindingStore.ts";
import { resolveSessionRuntimeConfig } from "./sessionRuntimeConfigPolicy.ts";
import { resolveAndValidateModel } from "./commands/setModel.ts";
import { resolveAndValidateEffort } from "./commands/setEffort.ts";

export type RuntimeDefaultsResetSummary = {
  outcome: "applied" | "noop" | "dry-run";
  eligibleCount: number;
  updatedSessions: number;
  modelResetCount: number;
  effortResetCount: number;
  busySkipped: string[];
  invalidDefaults: Array<{
    sessionName: string;
    error: string;
  }>;
};

export type ChangedRuntimeDefaultsSyncSummary = RuntimeDefaultsResetSummary & {
  changedMainDefaultSessions: string[];
  childDefaultsChanged: boolean;
  currentValuesPushedAfterReset: boolean;
  diffs: RuntimeDefaultFieldDiff[];
  truncated: number;
};

export type RuntimeDefaultFieldDiff = {
  session: string;
  field: "主model默认值" | "主effort默认值" | "子backend" | "子model" | "子effort";
  from: string;
  to: string;
};

const RUNTIME_DEFAULT_DIFF_LIMIT = 50;
const CHILD_DEFAULT_DIFF_SESSION = "全局子session默认值";

type RuntimeDefaultsSnapshot = {
  main: Record<string, { model: string | null; effort: Session["effort"] }>;
  child: Pick<ChildSessionDefaults, "backend" | "model" | "effort">;
};

export async function resetSessionRuntimeDefaults(input: {
  store: Pick<
    BindingStore,
    "listActiveSessions" | "getSessionRuntimeSettings" | "applySessionRuntimeConfigMutations"
  >;
  now: Timestamp;
  dryRun?: boolean;
  targetSessionNames?: readonly string[];
  auditTrigger?: string;
  auditReason?: string;
}): Promise<RuntimeDefaultsResetSummary> {
  const targetSessionNames = input.targetSessionNames
    ? new Set(input.targetSessionNames)
    : null;
  const sessions = (await input.store.listActiveSessions()).filter(
    (session) => session.scope !== "child"
      && session.status !== "deleted"
      && (targetSessionNames === null || targetSessionNames.has(session.name)),
  );
  const busySkipped: string[] = [];
  const invalidDefaults: RuntimeDefaultsResetSummary["invalidDefaults"] = [];
  const candidates: Array<{
    session: Session;
    mutation: SessionRuntimeConfigMutation;
  }> = [];

  for (const session of sessions) {
    const settings = await input.store.getSessionRuntimeSettings(session.id);
    const requestedModel = settings?.mainModelDefault ?? null;
    const requestedEffort = settings?.mainEffortDefault ?? null;
    // Values originate from the editable Bitable control row.
    // Reject cross-backend model ids and unsupported effort values before the
    // reset transaction, so a bad table edit cannot become a runtime setting.
    try {
      if (settings?.mainModelDefault) {
        resolveAndValidateModel(settings.mainModelDefault, session.backend);
      }
      if (settings?.mainEffortDefault) {
        resolveAndValidateEffort(settings.mainEffortDefault, {
          backend: session.backend,
          model: requestedModel,
        });
      }
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      invalidDefaults.push({
        sessionName: session.name,
        error: err.message,
      });
      continue;
    }
    const decision = resolveSessionRuntimeConfig({
      current: {
        backend: session.backend,
        model: session.model,
        effort: session.effort,
        backendSessionId: session.backendSessionId,
      },
      intent: {
        kind: "inherit",
        backend: session.backend,
        model: requestedModel,
        effort: requestedEffort,
      },
      catalog: getCodexModelCatalogSnapshot(),
    });
    if (decision.action === "reject") {
      invalidDefaults.push({
        sessionName: session.name,
        error: `invalid runtime defaults: ${decision.reason}`,
      });
      continue;
    }
    const nextModel = decision.after.model;
    const nextEffort = decision.after.effort;
    if (nextModel === session.model && nextEffort === session.effort) continue;
    if (session.status === "busy") {
      busySkipped.push(session.name);
      continue;
    }
    candidates.push({
      session,
      mutation: resetMutation(
        session,
        nextModel,
        nextEffort,
        input.now,
        input.auditTrigger ?? "daily-runtime-default-reset",
        input.auditReason ?? "daily reset to configured backend defaults",
      ),
    });
  }

  const applied = input.dryRun ? candidates : [];
  if (!input.dryRun) {
    for (const candidate of candidates) {
      try {
        await input.store.applySessionRuntimeConfigMutations([candidate.mutation]);
        applied.push(candidate);
      } catch (err) {
        if (!(err instanceof RuntimeConfigConflictError)) throw err;
        busySkipped.push(candidate.session.name);
      }
    }
  }
  const modelResetCount = applied.filter(
    ({ session, mutation }) => mutation.after.model !== session.model,
  ).length;
  const effortResetCount = applied.filter(
    ({ session, mutation }) => mutation.after.effort !== session.effort,
  ).length;
  return {
    outcome: input.dryRun ? "dry-run" : applied.length > 0 ? "applied" : "noop",
    eligibleCount: sessions.length,
    updatedSessions: applied.length,
    modelResetCount,
    effortResetCount,
    busySkipped,
    invalidDefaults,
  };
}

export async function syncChangedSessionRuntimeDefaults(input: {
  store: Pick<
    BindingStore,
    | "listActiveSessions"
    | "getSessionRuntimeSettings"
    | "getChildSessionDefaults"
    | "applySessionRuntimeConfigMutations"
  >;
  now: Timestamp;
  pull(): Promise<void>;
  pushCurrent(): Promise<void>;
}): Promise<ChangedRuntimeDefaultsSyncSummary> {
  const before = await runtimeDefaultsSnapshot(input.store);
  await input.pull();
  const after = await runtimeDefaultsSnapshot(input.store);
  const changedMainDefaultSessions = Object.keys(after.main)
    .filter((name) => !sameMainDefaults(before.main[name], after.main[name]))
    .sort();
  const childDefaultsChanged = !sameChildDefaults(before.child, after.child);
  const allDiffs = runtimeDefaultDiffs(before, after, changedMainDefaultSessions);
  const diffs = allDiffs.slice(0, RUNTIME_DEFAULT_DIFF_LIMIT);
  const truncated = allDiffs.length - diffs.length;
  const resetSummary = await resetSessionRuntimeDefaults({
    store: input.store,
    now: input.now,
    targetSessionNames: changedMainDefaultSessions,
    auditTrigger: "bitable-runtime-settings-change",
    auditReason: "Bitable runtime defaults changed",
  });
  const currentValuesPushedAfterReset = resetSummary.updatedSessions > 0 || childDefaultsChanged;
  if (currentValuesPushedAfterReset) await input.pushCurrent();
  return {
    ...resetSummary,
    changedMainDefaultSessions,
    childDefaultsChanged,
    currentValuesPushedAfterReset,
    diffs,
    truncated,
  };
}

async function runtimeDefaultsSnapshot(
  store: Pick<BindingStore, "listActiveSessions" | "getSessionRuntimeSettings" | "getChildSessionDefaults">,
): Promise<RuntimeDefaultsSnapshot> {
  const sessions = (await store.listActiveSessions())
    .filter((session) => session.scope !== "child" && session.status !== "deleted")
    .sort((a, b) => a.name.localeCompare(b.name));
  const main: RuntimeDefaultsSnapshot["main"] = {};
  for (const session of sessions) {
    const settings = await store.getSessionRuntimeSettings(session.id);
    main[session.name] = {
      model: settings?.mainModelDefault ?? null,
      effort: settings?.mainEffortDefault ?? null,
    };
  }
  const child = await store.getChildSessionDefaults();
  return {
    main,
    child: {
      backend: child.backend,
      model: child.model,
      effort: child.effort,
    },
  };
}

function sameMainDefaults(
  before: RuntimeDefaultsSnapshot["main"][string] | undefined,
  after: RuntimeDefaultsSnapshot["main"][string],
): boolean {
  return before?.model === after.model && before?.effort === after.effort;
}

function sameChildDefaults(
  before: RuntimeDefaultsSnapshot["child"],
  after: RuntimeDefaultsSnapshot["child"],
): boolean {
  return before.backend.configured === after.backend.configured
    && before.backend.value === after.backend.value
    && before.model.configured === after.model.configured
    && before.model.value === after.model.value
    && before.effort.configured === after.effort.configured
    && before.effort.value === after.effort.value;
}

function runtimeDefaultDiffs(
  before: RuntimeDefaultsSnapshot,
  after: RuntimeDefaultsSnapshot,
  changedMainDefaultSessions: readonly string[],
): RuntimeDefaultFieldDiff[] {
  const diffs: RuntimeDefaultFieldDiff[] = [];
  for (const session of changedMainDefaultSessions) {
    const beforeDefaults = before.main[session];
    const afterDefaults = after.main[session];
    if (beforeDefaults?.model !== afterDefaults.model) {
      diffs.push({
        session,
        field: "主model默认值",
        from: renderMainDefault(beforeDefaults?.model),
        to: renderMainDefault(afterDefaults.model),
      });
    }
    if (beforeDefaults?.effort !== afterDefaults.effort) {
      diffs.push({
        session,
        field: "主effort默认值",
        from: renderMainDefault(beforeDefaults?.effort),
        to: renderMainDefault(afterDefaults.effort),
      });
    }
  }
  appendChildDefaultDiff(diffs, "子backend", before.child.backend, after.child.backend);
  appendChildDefaultDiff(diffs, "子model", before.child.model, after.child.model);
  appendChildDefaultDiff(diffs, "子effort", before.child.effort, after.child.effort);
  return diffs;
}

function appendChildDefaultDiff<T>(
  diffs: RuntimeDefaultFieldDiff[],
  field: "子backend" | "子model" | "子effort",
  before: ChildSessionDefault<T>,
  after: ChildSessionDefault<T>,
): void {
  if (before.configured === after.configured && before.value === after.value) return;
  diffs.push({
    session: CHILD_DEFAULT_DIFF_SESSION,
    field,
    from: renderChildDefault(before),
    to: renderChildDefault(after),
  });
}

function renderMainDefault(value: string | null | undefined): string {
  return value ?? "空";
}

function renderChildDefault<T>(value: ChildSessionDefault<T>): string {
  if (!value.configured) return "default";
  return value.value === null ? "空" : String(value.value);
}

function resetMutation(
  session: Session,
  model: string | null,
  effort: Session["effort"],
  now: Timestamp,
  trigger: string,
  reason: string,
): SessionRuntimeConfigMutation {
  const before = {
    backend: session.backend,
    model: session.model,
    effort: session.effort,
    backendSessionId: session.backendSessionId,
  };
  return {
    sessionId: session.id,
    expected: before,
    after: { ...before, model, effort },
    guard: { kind: "idle" },
    audit: {
      id: `cfg_${randomUUID()}`,
      trigger,
      requested: { model, effort },
      decision: "accept",
      reason,
      catalogSource: getCodexModelCatalogSource(),
      catalogFingerprint: getCodexModelCatalogFingerprint(),
      createdAt: now,
    },
  };
}
