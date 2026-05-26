import type { Scope } from "../../domain/scope.ts";
import type { CommandHandler, CommandRegistry } from "../commandRegistry.ts";

export function createHelpHandler(registry: CommandRegistry): CommandHandler {
  return async ({ scope, args }) => {
    if (args.name) {
      return { replyText: renderCommandDetail(registry, args.name, scope) };
    }
    return { replyText: renderHelp(registry, scope) };
  };
}

function renderCommandDetail(registry: CommandRegistry, name: string, scope: Scope): string {
  const entry = registry[name];
  if (!entry) return `未知命令：/${name}。使用 /help 查看可用命令。`;
  if (!entry.command.scope.includes(scope)) {
    return `命令 /${name} 在当前 scope 不可用。`;
  }
  const cmd = entry.command;
  const visibleParams = cmd.params.filter((p) => !p.scope || p.scope.includes(scope));
  const signature = buildSignature(cmd.name, visibleParams, scope);
  const lines = [signature, "", cmd.description];
  if (visibleParams.length > 0) {
    lines.push("", "参数：");
    for (const p of visibleParams) {
      const req = p.required ? "必填" : "可选";
      const label = p.kind === "named" ? `--${p.name}` : p.name;
      if (p.type === "enum" && p.enum) {
        lines.push(`  ${label} (${req}): ${p.enum.join(" | ")}`);
      } else {
        lines.push(`  ${label} (${req})`);
      }
    }
  }
  if (cmd.notes) {
    lines.push("", cmd.notes);
  }
  return lines.join("\n");
}

function renderHelp(registry: CommandRegistry, scope: Scope): string {
  const header = scope === "root" ? "可用命令（root 群）:" : "可用命令（其他群）:";
  const lines = [header];
  for (const entry of Object.values(registry)) {
    if (!entry.command.scope.includes(scope)) continue;
    const visibleParams = entry.command.params.filter((p) => !p.scope || p.scope.includes(scope));
    const signature = buildSignature(entry.command.name, visibleParams, scope);
    lines.push(`  ${signature.padEnd(44)}${entry.command.description}`);
  }
  lines.push("", "使用 /help <command> 查看命令详细说明和影响面。");
  return lines.join("\n");
}

function buildSignature(
  name: string,
  params: import("../../domain/command.ts").Command["params"],
  _scope: Scope
): string {
  const parts = [`/${name}`];
  for (const p of params) {
    if (p.type === "enum" && p.enum) parts.push(`<${p.enum.join("|")}>`);
    else if (p.kind === "named") parts.push(`[--${p.name} <${p.name}>]`);
    else if (p.kind === "rest") parts.push(p.required ? `<${p.name}...>` : `[${p.name}...]`);
    else if (!p.required) parts.push(`[${p.name}]`);
    else parts.push(`<${p.name}>`);
  }
  return parts.join(" ");
}
