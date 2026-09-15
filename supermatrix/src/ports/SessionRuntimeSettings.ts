import type { SessionId, Timestamp } from "../domain/ids.ts";
import type { BackendKind, EffortLevel } from "../domain/session.ts";

export type FollowMainOrLocked<T> =
  | { configured: false; value: null }
  | { configured: true; value: T };

export type SessionRuntimeSettings = {
  sessionId: SessionId;
  mainModelDefault: string | null;
  mainEffortDefault: EffortLevel | null;
  childBackend: FollowMainOrLocked<BackendKind>;
  childModel: FollowMainOrLocked<string>;
  childEffort: FollowMainOrLocked<EffortLevel>;
  updatedAt: Timestamp;
};

// Legacy fallback only. Normal session-runtime-settings creation and migration
// read backend_runtime_defaults; this map is used when that table or backend
// row is unavailable. Kimi's Base `default` effort sentinel remains local NULL.
export const LEGACY_MAIN_SESSION_DEFAULTS = {
  codex: {
    mainModelDefault: "gpt-5.6-terra",
    mainEffortDefault: "max",
  },
  claude: {
    mainModelDefault: "claude-opus-4-8",
    mainEffortDefault: "xhigh",
  },
  kimi: {
    mainModelDefault: "kimi-code/k3",
    mainEffortDefault: null,
  },
} as const satisfies Readonly<
  Record<
    BackendKind,
    Pick<SessionRuntimeSettings, "mainModelDefault" | "mainEffortDefault">
  >
>;

export type SessionRuntimeSettingsPatch = Partial<
  Pick<
    SessionRuntimeSettings,
    | "mainModelDefault"
    | "mainEffortDefault"
    | "childBackend"
    | "childModel"
    | "childEffort"
  >
>;
