import type { Timestamp } from "../domain/ids.ts";
import type { BackendKind, EffortLevel } from "../domain/session.ts";

export type ChildSessionDefault<T> = {
  configured: boolean;
  value: T | null;
};

export type ChildSessionDefaults = {
  backend: ChildSessionDefault<BackendKind>;
  model: ChildSessionDefault<string>;
  effort: ChildSessionDefault<EffortLevel>;
  updatedAt: Timestamp | null;
};

export type ChildSessionDefaultsPatch = Partial<
  Pick<ChildSessionDefaults, "backend" | "model" | "effort">
>;
