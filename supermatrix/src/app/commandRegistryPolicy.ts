import type { Command } from "../domain/command.ts";
import type { Scope } from "../domain/scope.ts";

export type CommandApproval = {
  owner: string;
  scopes: readonly Scope[];
};

export type CommandRegistryForPolicy = Record<string, { command: Command }>;

const OWNER_RE = /^[a-z0-9][a-z0-9_-]*-[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const APPROVED_COMMAND_REGISTRY: Record<string, CommandApproval> = {
  new: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  clone: { owner: "supermatrix-root-SuperMatrix", scopes: ["user"] },
  delete: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  list: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  tokens: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  usage: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  cancel: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  reset: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  restart: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  branch: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  status: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  lock: { owner: "supermatrix-root-SuperMatrix", scopes: ["user"] },
  unlock: { owner: "supermatrix-root-SuperMatrix", scopes: ["user"] },
  log: { owner: "watchdog-SuperMatrix", scopes: ["root", "user"] },
  heartbeat: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  help: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  rank: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  reload: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  model: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  backend: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  effort: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  timeout: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  skills: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  next: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  now: { owner: "supermatrix-root-SuperMatrix", scopes: ["user"] },
  todo: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  idea: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  spawn: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
  btw: { owner: "supermatrix-root-SuperMatrix", scopes: ["root", "user"] },
  selfcheck: { owner: "supermatrix-root-SuperMatrix", scopes: ["root"] },
};

export function assertCommandRegistryPolicy(
  registry: CommandRegistryForPolicy,
): Record<string, CommandApproval> {
  for (const [name, entry] of Object.entries(registry)) {
    const approval = APPROVED_COMMAND_REGISTRY[name];
    if (!approval) {
      throw new Error(`Command /${name} is not approved by commandRegistryPolicy`);
    }
    if (!OWNER_RE.test(approval.owner)) {
      throw new Error(`Command /${name} owner must be <session>-<repo>, got ${approval.owner}`);
    }
    const approvedScopes = new Set(approval.scopes);
    for (const scope of entry.command.scope) {
      if (!approvedScopes.has(scope)) {
        throw new Error(`Command /${name} scope ${scope} is not approved by commandRegistryPolicy`);
      }
    }
  }

  for (const name of Object.keys(APPROVED_COMMAND_REGISTRY)) {
    if (!registry[name]) {
      throw new Error(`Approved command /${name} is missing from commandRegistry`);
    }
  }

  return APPROVED_COMMAND_REGISTRY;
}
