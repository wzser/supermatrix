// Runtime commands normally mirror only local-authoritative current fields.
// A backend switch additionally asks the Feishu-owner sync to CAS-normalize an
// incompatible main-default tuple, then pull the verified authority back.
export type SessionRuntimeSettingsSyncScope = "current" | "backend-switch";

export type SessionRuntimeSettingsSyncResult =
  | { ok: true }
  | { ok: false; error: unknown };
