import { UserError } from "../../domain/errors.ts";
import type { Session } from "../../domain/session.ts";
import type {
  ChildSessionDefaults,
  ChildSessionDefaultsPatch,
} from "../../ports/ChildSessionDefaults.ts";

export type ChildSessionDefaultsCommandStore = {
  getChildSessionDefaults?: () => Promise<ChildSessionDefaults>;
  updateChildSessionDefaults?: (patch: ChildSessionDefaultsPatch) => Promise<void>;
  compareAndSetChildSessionDefaults?: (
    expected: ChildSessionDefaults,
    patch: ChildSessionDefaultsPatch,
  ) => Promise<boolean>;
  listActiveSessions?: () => Promise<Session[]>;
};

function formatConfiguredValue<T>(value: { configured: boolean; value: T | null }): string {
  if (!value.configured) return "inherit";
  return value.value === null ? "default" : String(value.value);
}

export function formatChildSessionDefaults(defaults: ChildSessionDefaults): string {
  return [
    "后续所有系统入口新建 child 默认：",
    `backend: ${formatConfiguredValue(defaults.backend)}`,
    `model: ${formatConfiguredValue(defaults.model)}`,
    `effort: ${formatConfiguredValue(defaults.effort)}`,
  ].join("\n");
}

export function formatUnaffectedChildLocks(
  sessions: readonly Session[],
): string {
  const model = sessions
    .filter((session) => session.scope === "child" && session.modelLocked)
    .map((session) => session.name);
  const effort = sessions
    .filter((session) => session.scope === "child" && session.effortLocked)
    .map((session) => session.name);
  return [
    "已有 child 均未调整（仅影响后续新建 child）。",
    `🔒 单独锁定未调整：model: ${model.join(", ") || "无"}; effort: ${effort.join(", ") || "无"}`,
  ].join("\n");
}

export async function readChildSessionDefaults(
  store: ChildSessionDefaultsCommandStore,
): Promise<ChildSessionDefaults> {
  if (!store.getChildSessionDefaults) {
    throw new Error("child session defaults store is not configured");
  }
  return store.getChildSessionDefaults();
}

export async function writeChildSessionDefaults(
  store: ChildSessionDefaultsCommandStore,
  patch: ChildSessionDefaultsPatch,
): Promise<void> {
  if (!store.updateChildSessionDefaults) {
    throw new Error("child session defaults store is not configured");
  }
  await store.updateChildSessionDefaults(patch);
}

export async function compareAndSetChildSessionDefaults(
  store: ChildSessionDefaultsCommandStore,
  expected: ChildSessionDefaults,
  patch: ChildSessionDefaultsPatch,
): Promise<boolean> {
  if (!store.compareAndSetChildSessionDefaults) {
    throw new Error("child session defaults compare-and-set store is not configured");
  }
  return store.compareAndSetChildSessionDefaults(expected, patch);
}

export async function mutateChildSessionDefaults(
  store: ChildSessionDefaultsCommandStore,
  createPatch: (defaults: ChildSessionDefaults) => ChildSessionDefaultsPatch,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expected = await readChildSessionDefaults(store);
    const patch = createPatch(expected);
    if (await compareAndSetChildSessionDefaults(store, expected, patch)) return;
  }
  throw new UserError("child 默认配置刚被并发更新，请重试");
}

export async function formatChildSessionDefaultsReceipt(
  store: ChildSessionDefaultsCommandStore,
): Promise<string> {
  const [defaults, sessions] = await Promise.all([
    readChildSessionDefaults(store),
    store.listActiveSessions ? store.listActiveSessions() : Promise.resolve([]),
  ]);
  return [
    formatChildSessionDefaults(defaults),
    formatUnaffectedChildLocks(sessions),
  ].join("\n");
}
