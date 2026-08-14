import { randomUUID } from "node:crypto";
import { asTimestamp, type Timestamp } from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type { BindingStore, SessionRuntimeConfigMutation } from "../ports/BindingStore.ts";
import { RuntimeConfigConflictError } from "../ports/BindingStore.ts";
import type { CodexModelAvailability } from "../ports/CodexModelAvailability.ts";
import {
  getCodexBundledModels,
  getCodexModelCatalogFingerprint,
  getCodexModelCatalogSnapshot,
  getCodexModelCatalogSource,
  setCodexEffectiveDefaultModel,
} from "../ports/CodexModelCatalog.ts";
import { resolveSessionRuntimeConfig, type RuntimeConfigTuple } from "./sessionRuntimeConfigPolicy.ts";

export type ReconcileProblemKind = "clamped" | "fallbackModel" | "conflict" | "failed";
export type ReconcileSummary = {
  unchanged: number;
  clamped: number;
  fallbackModel: number;
  conflict: number;
  failed: number;
  verifiedDefault: string | null;
  /**
   * Set when the default-model probe was skipped rather than run — an active
   * sm-switch route serves codex runs, so catalog models cannot be probed (see
   * the `skipped` availability result). Carries the route reason verbatim and
   * stays separate from `verifiedDefault: null` so a skip is never reported as
   * a verification verdict, in either direction.
   */
  defaultVerificationSkipped: string | null;
  problems: Partial<Record<ReconcileProblemKind, string[]>>;
};

export type ReconcileCodexRuntimeConfigDeps = {
  store: BindingStore;
  availability: CodexModelAvailability;
  now?: () => Timestamp;
  idFactory?: () => string;
};

export async function reconcileCodexRuntimeConfigs(
  deps: ReconcileCodexRuntimeConfigDeps,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    unchanged: 0, clamped: 0, fallbackModel: 0, conflict: 0, failed: 0,
    verifiedDefault: null, defaultVerificationSkipped: null, problems: {},
  };
  const verification = await verifyDefault(deps.availability);
  if (verification.kind === "verified") {
    setCodexEffectiveDefaultModel(verification.model);
    summary.verifiedDefault = verification.model;
  } else if (verification.kind === "skipped") {
    summary.defaultVerificationSkipped = verification.reason;
  }
  const verifiedDefault = summary.verifiedDefault;
  const catalog = getCodexModelCatalogSnapshot();
  const knownModels = new Set(catalog.models.map((entry) => entry.slug));
  const sessions = (await deps.store.listAllSessions())
    .filter((session) => session.status !== "deleted" && session.backend === "codex");

  for (const session of sessions) {
    const defaultDependent = session.model === null || !knownModels.has(session.model);
    if (defaultDependent && verifiedDefault === null) {
      record(summary, "failed", session.name);
      continue;
    }
    try {
      const decision = resolveSessionRuntimeConfig({
        current: tuple(session), intent: { kind: "reconcile" }, catalog,
      });
      if (sameTuple(tuple(session), decision.after)) {
        summary.unchanged += 1;
        continue;
      }
      const mutation: SessionRuntimeConfigMutation = {
        sessionId: session.id,
        expected: tuple(session),
        after: decision.after,
        guard: { kind: "idle" },
        audit: {
          id: deps.idFactory?.() ?? `cfg_${randomUUID()}`,
          trigger: "boot",
          requested: { model: session.model, effort: session.effort },
          decision: decision.action,
          reason: decision.reason,
          catalogSource: getCodexModelCatalogSource(),
          catalogFingerprint: getCodexModelCatalogFingerprint(),
          createdAt: deps.now?.() ?? asTimestamp(Date.now()),
        },
      };
      await deps.store.applySessionRuntimeConfigMutations([mutation]);
      record(summary, decision.action === "fallback_model" ? "fallbackModel" : "clamped", session.name);
    } catch (error) {
      if (error instanceof RuntimeConfigConflictError) record(summary, "conflict", session.name);
      else record(summary, "failed", session.name);
    }
  }
  return summary;
}

type DefaultVerification =
  | { kind: "verified"; model: string }
  | { kind: "unverified" }
  | { kind: "skipped"; reason: string };

async function verifyDefault(availability: CodexModelAvailability): Promise<DefaultVerification> {
  const currentDefault = getCodexModelCatalogSnapshot().defaultModel;
  const candidates = [currentDefault, ...getCodexBundledModels().filter((model) => model !== currentDefault)];
  // An active sm-switch route decides which model serves a codex run, so the
  // catalog models it does not serve cannot be probed at all. Those candidates
  // come back `skipped`: keep walking the list (a served candidate would still
  // be probed for real), and if nothing gets verified report the route reason
  // as the outcome instead of an availability verdict nobody measured.
  let skippedReason: string | null = null;
  for (const candidate of candidates) {
    const result = await availability.probe(candidate);
    if (result.kind === "available") return { kind: "verified", model: candidate };
    if (result.kind === "skipped") {
      skippedReason ??= result.reason;
      continue;
    }
    if (result.kind === "transient_failure") return { kind: "unverified" };
  }
  return skippedReason === null ? { kind: "unverified" } : { kind: "skipped", reason: skippedReason };
}

function tuple(session: Session): RuntimeConfigTuple {
  return {
    backend: session.backend, model: session.model, effort: session.effort,
    backendSessionId: session.backendSessionId,
  };
}

function sameTuple(a: RuntimeConfigTuple, b: RuntimeConfigTuple): boolean {
  return a.backend === b.backend && a.model === b.model && a.effort === b.effort
    && a.backendSessionId === b.backendSessionId;
}

function record(summary: ReconcileSummary, kind: ReconcileProblemKind, name: string): void {
  summary[kind] += 1;
  (summary.problems[kind] ??= []).push(name);
}
