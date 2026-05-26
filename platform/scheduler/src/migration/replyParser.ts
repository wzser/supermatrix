import type { MigrationAction } from "./types.js";

const VALID: MigrationAction[] = ["CONFIRM", "MODIFY", "LATER", "DISABLE", "REJECT"];

export type ParsedMigrationReply = {
  action: MigrationAction;
  kv: Record<string, string>;
};

export function parseMigrationReply(text: string): ParsedMigrationReply | null {
  const re = /action\s*:\s*([A-Za-z]+)([^\n\r]*)/gi;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const action = last[1].toUpperCase();
  if (!(VALID as string[]).includes(action)) return null;
  const kv: Record<string, string> = {};
  const kvRe = /(\w+)\s*=\s*(\S+)/g;
  for (const m of last[2].matchAll(kvRe)) {
    kv[m[1]] = m[2];
  }
  return { action: action as MigrationAction, kv };
}
