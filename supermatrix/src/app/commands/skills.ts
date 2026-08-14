import { UserError } from "../../domain/errors.ts";
import type { AbsolutePath, LarkGroupId, SessionId } from "../../domain/ids.ts";
import type { CommandHandler } from "../commandRegistry.ts";

export type SkillsHandlerDeps = {
  store: {
    findSessionByName(name: string): Promise<{ id: SessionId; workdir: string } | null>;
  };
  fs: {
    exists(path: AbsolutePath): Promise<boolean>;
    readFile(path: AbsolutePath): Promise<string>;
    listDir(path: AbsolutePath): Promise<string[]>;
  };
  userHome: string;
  resolveUserGroupSession?: (
    groupId: LarkGroupId,
  ) => Promise<{ name: string; id: SessionId } | null>;
};

type SkillEntry = {
  name: string;
  source: "skill" | "plugin" | "command";
  description?: string;
};

export function createSkillsHandler(deps: SkillsHandlerDeps): CommandHandler {
  return async ({ args, scope, msg }) => {
    let sessionName = args.name;

    if (scope === "user" && deps.resolveUserGroupSession) {
      const resolved = await deps.resolveUserGroupSession(msg.groupId);
      if (!resolved) throw new UserError("当前群未绑定 session。");
      sessionName = resolved.name;
    }

    if (!sessionName) {
      throw new UserError(
        scope === "root" ? "用法：/skills <session-name>" : "用法：/skills",
      );
    }

    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);

    const skills = await collectSkills(deps.fs, deps.userHome, session.workdir as AbsolutePath);

    if (skills.length === 0) {
      return { replyText: `session「${sessionName}」当前没有注册任何 skill。` };
    }

    return { replyText: formatSkills(sessionName, skills) };
  };
}

async function collectSkills(
  fs: SkillsHandlerDeps["fs"],
  userHome: string,
  workdir: AbsolutePath,
): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = [];

  // 1. Scan ~/.claude/skills/ — canonical skill pool (skill-master symlinks + superpowers)
  const skillsDir = `${userHome}/.claude/skills` as AbsolutePath;
  if (await fs.exists(skillsDir)) {
    try {
      const entries = await fs.listDir(skillsDir);
      for (const entry of entries) {
        try {
          const skillMdPath = `${skillsDir}/${entry}/SKILL.md` as AbsolutePath;
          if (!(await fs.exists(skillMdPath))) continue;
          const content = await fs.readFile(skillMdPath);
          const fm = extractFrontmatter(content);
          const name = fm.name ?? entry;
          const skillEntry: SkillEntry = { name, source: "skill" };
          if (fm.description) skillEntry.description = fm.description;
          skills.push(skillEntry);
        } catch {
          // skip unreadable or broken symlinks
        }
      }
    } catch {
      // ignore listDir failures
    }
  }

  // 2. Scan workdir/.claude/settings.json → mcpServers
  const settingsPath = `${workdir}/.claude/settings.json` as AbsolutePath;
  if (await fs.exists(settingsPath)) {
    try {
      const content = await fs.readFile(settingsPath);
      const settings = JSON.parse(content) as Record<string, unknown>;
      if (settings["mcpServers"] && typeof settings["mcpServers"] === "object") {
        for (const name of Object.keys(settings["mcpServers"] as object)) {
          skills.push({ name, source: "plugin" });
        }
      }
    } catch {
      // ignore malformed JSON
    }
  }

  // 3. Scan workdir/.claude/commands/ + ~/.claude/commands/ → custom commands
  const commandDirs = [
    `${workdir}/.claude/commands` as AbsolutePath,
    `${userHome}/.claude/commands` as AbsolutePath,
  ];
  const seen = new Set<string>();
  for (const commandsDir of commandDirs) {
    if (!(await fs.exists(commandsDir))) continue;
    try {
      const files = await fs.listDir(commandsDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const name = file.replace(/\.md$/, "");
        if (seen.has(name)) continue;
        seen.add(name);
        let description: string | undefined;
        try {
          const content = await fs.readFile(`${commandsDir}/${file}` as AbsolutePath);
          const fm = extractFrontmatter(content);
          description = fm.description;
        } catch {
          // ignore unreadable files
        }
        const entry: SkillEntry = { name: `/${name}`, source: "command" };
        if (description) entry.description = description;
        skills.push(entry);
      }
    } catch {
      // ignore listDir failures
    }
  }

  return skills;
}

function extractFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = match[1];
  const result: { name?: string; description?: string } = {};

  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const descMatch = fm.match(/^description:\s*(?:(.+)|>\s*\n\s+(.+))/m);
  if (descMatch) {
    let desc = (descMatch[1] ?? descMatch[2] ?? "").trim();
    if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
      desc = desc.slice(1, -1);
    }
    if (desc) result.description = desc;
  }

  return result;
}

function formatSkills(sessionName: string, skills: SkillEntry[]): string {
  const lines = [`session「${sessionName}」可用 skills：`, ""];

  const skillEntries = skills.filter((s) => s.source === "skill");
  const plugins = skills.filter((s) => s.source === "plugin");
  const commands = skills.filter((s) => s.source === "command");

  if (skillEntries.length > 0) {
    lines.push(`Skills (${skillEntries.length}):`);
    for (const s of skillEntries) {
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push(`  • ${s.name}${desc}`);
    }
  }

  if (plugins.length > 0) {
    if (skillEntries.length > 0) lines.push("");
    lines.push(`MCP servers (${plugins.length}):`);
    for (const s of plugins) {
      lines.push(`  • ${s.name}`);
    }
  }

  if (commands.length > 0) {
    if (skillEntries.length + plugins.length > 0) lines.push("");
    lines.push(`Custom commands (${commands.length}):`);
    for (const s of commands) {
      const desc = s.description ? ` — ${s.description}` : "";
      lines.push(`  • ${s.name}${desc}`);
    }
  }

  return lines.join("\n");
}
