import type { Timestamp } from "../domain/ids.ts";

export type Clock = {
  now(): Timestamp;
};
