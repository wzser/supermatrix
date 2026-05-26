import type { Command } from "../domain/command.ts";
import type { Scope } from "../domain/scope.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import { formatAvailableCodexModels } from "../ports/CodexModelCatalog.ts";

export type HandlerContext = {
  msg: InboundMessage;
  scope: Scope;
  args: Record<string, string>;
};

export type CommandResult =
  | { replyText: string }
  | { replyCard: { title: string; body: string } }
  | { handled: true };

export type CommandHandler = (ctx: HandlerContext) => Promise<CommandResult>;

export type CommandEntry = {
  command: Command;
  handler: CommandHandler;
};

export type CommandRegistry = Record<string, CommandEntry>;

const placeholderHandler: CommandHandler = async () => {
  throw new Error("handler not yet bound");
};

export function buildCommandRegistry(): CommandRegistry {
  const base: Array<{ name: string; command: Command }> = [
    {
      name: "new",
      command: {
        name: "new",
        description: "新建一个 session 并自动建群、绑定",
        notes:
          "操作顺序：\n" +
          "  1. 校验名称合法性（a-z0-9_-，首字符字母或数字，≤40字符）\n" +
          "  2. 创建工作区目录并 git init\n" +
          "  3. 复制 .gitignore、提交 initial commit\n" +
          "  4. 创建飞书群并邀请 owner 入群\n" +
          "  5. 在数据库中插入 session 记录和 binding 记录\n" +
          "  6. symlink principles 文件与 session-catalog.json、写入 CLAUDE.md\n" +
          "  7. 重新生成全局 session-catalog.json\n" +
          "  8. session 状态从 initializing 切换到 idle\n\n" +
          "影响的资源：\n" +
          "  • 文件系统：新建工作区目录（含 git repo、session-catalog.json symlink、principles symlink、CLAUDE.md）\n" +
          "  • 飞书：创建新群、邀请 owner\n" +
          "  • 数据库：插入 sessions 表 + bindings 表记录\n" +
          "  • 兄弟 session：全局 session-catalog.json 被重新生成\n\n" +
          "可逆性：步骤 1-4 中任一失败会自动回滚（删目录、解散群）。\n" +
          "创建完成后需用 /delete 删除；/delete 不删工作区目录，需手动清理。\n\n" +
          "可选 --model 参数指定模型（如 claude-sonnet-4-6），不指定则用默认模型。\n" +
          "可选 --chat-name <name> 指定群名前缀；群名按 `{chat-name}-{session}-{backend}` 生成，不传则为 `{session}-{backend}`。",
        scope: ["root"],
        params: [
          { name: "backend", type: "enum", required: true, kind: "positional", enum: ["claude", "codex", "kimi"] },
          { name: "name", type: "string", required: true, kind: "positional" },
          { name: "model", type: "string", required: false, kind: "named" },
          { name: "workdir", type: "string", required: false, kind: "named" },
          { name: "chat-name", type: "string", required: false, kind: "named" },
          { name: "purpose", type: "string", required: false, kind: "rest" },
        ],
      },
    },
    {
      name: "delete",
      command: {
        name: "delete",
        description: "解绑指定 session 并解散对应飞书群",
        notes:
          "操作顺序：\n" +
          "  1. 检查 session 是否存在\n" +
          "  2. 检查 session 是否为 busy 状态（busy 时拒绝，需先 /cancel 或等待完成）\n" +
          "  3. 解散对应飞书群（群内成员立即失去访问）\n" +
          "  4. 数据库：物理删除 bindings 记录，session 记录标记为 deleted（软删除，记录保留）\n" +
          "  5. 重新生成全局 session-catalog.json\n\n" +
          "影响的资源：\n" +
          "  • 飞书：群被解散，所有成员失去访问\n" +
          "  • 数据库：binding 记录物理删除；session 记录保留（status='deleted'）\n" +
          "  • 兄弟 session：全局 session-catalog.json 被重新生成（移除该 session）\n" +
          "  • 文件系统：工作区目录不会被删除，需手动清理\n" +
          "  • 进程：不涉及进程操作（busy 时直接拒绝，不会 kill 进程）\n\n" +
          "可逆性：不可逆。飞书群一旦解散无法恢复，binding 记录被物理删除。\n" +
          "session 记录虽保留但无法重新激活。如需恢复，只能用 /new 重新创建。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: true, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "list",
      command: {
        name: "list",
        description: "列出当前所有 active session",
        notes:
          "操作：查询数据库中所有 status ≠ deleted 的 session 并格式化输出。\n" +
          "显示内容：名称、backend 类型、当前状态、创建时间（相对）。\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root"],
        params: [],
      },
    },
    {
      name: "tokens",
      command: {
        name: "tokens",
        description: "按 session 列出 token 使用与 cache 命中（今日 / 7 日 / 累计）并汇总合计",
        notes:
          "操作：对每个 active session 查询 token_usage 表，汇总三个时间窗口（今日 / 最近 7 天 / 累计）。\n" +
          "显示为一张表：每个 session 展示 in/out/all，以及 cache/miss/hit%（cache 命中输入、未命中或新写输入、命中率），末尾合计。\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root"],
        params: [],
      },
    },
    {
      name: "cancel",
      command: {
        name: "cancel",
        description: "取消指定 session 正在进行的运行，或只清空 /next 排队消息",
        notes:
          "操作顺序：\n" +
          "  1. /cancel：解析目标 session（session 群内自动绑定当前群），清空未消化的 /next 排队消息\n" +
          "  2. 向 backend 进程组发送 SIGTERM 信号（含所有子进程）\n" +
          "  3. 等待 3 秒优雅退出，超时后 SIGKILL 强制终止\n" +
          "  4. session 状态回到 idle\n" +
          "  5. /cancel next：只清空未消化的 /next 排队消息，不取消正在运行的任务\n\n" +
          "影响的资源：\n" +
          "  • 进程：/cancel 会终止 backend 进程组；/cancel next 不影响进程\n" +
          "  • 数据库：/cancel 会把 session 状态更新为 idle；backendSessionId 保留\n" +
          "  • 内存：/cancel 和 /cancel next 都会清空该 session 未消化的 /next 排队消息\n" +
          "  • 文件系统：不影响（backend 可能有未完成的文件写入）\n" +
          "  • 飞书：不影响\n\n" +
          "用法：session 群内用 /cancel 或 /cancel next；Console 群用 /cancel <name> 或 /cancel next <name>。\n\n" +
          "可逆性：/cancel 对话上下文保留（backendSessionId 不清除），下次消息仍可 resume。\n" +
          "如果 backend 在写文件中途被终止，可能留下不完整的更改，需在工作区手动检查。",
        scope: ["root", "user"],
        params: [{ name: "target", type: "string", required: false, kind: "rest" }],
      },
    },
    {
      name: "reset",
      command: {
        name: "reset",
        description: "清空指定 session 的对话上下文（不动文件，busy 时拒绝）",
        notes:
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群）\n" +
          "  2. 检查 session 状态（busy 时拒绝，需先 /cancel）\n" +
          "  3. 清除 backendSessionId\n" +
          "  4. 设置 session 状态为 idle\n\n" +
          "影响的资源：\n" +
          "  • 数据库：backendSessionId 清空，status 设为 idle\n" +
          "  • 文件系统：不影响（工作区文件完全不动）\n" +
          "  • 飞书：不影响\n" +
          "  • 进程：不涉及进程操作（busy 时直接拒绝）\n\n" +
          "可逆性：不可逆——对话上下文永久丢失，无法恢复之前的对话。\n" +
          "下次消息将开启全新对话（不 resume），但工作区中已有的代码更改不受影响。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "restart",
      command: {
        name: "restart",
        description: "强制重启：打断 busy 运行后清空上下文",
        notes:
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群）\n" +
          "  2. 若 session 为 busy：向 backend 进程组发送 SIGTERM 终止\n" +
          "  3. 清除 backendSessionId\n" +
          "  4. 设置 session 状态为 idle\n\n" +
          "影响的资源：\n" +
          "  • 进程：busy 时 backend 进程组被 SIGTERM 终止\n" +
          "  • 数据库：backendSessionId 清空，status 设为 idle\n" +
          "  • 文件系统：不影响（backend 可能有未完成的文件写入，需手动检查）\n" +
          "  • 飞书：不影响\n\n" +
          "可逆性：不可逆——等同于 /cancel + /reset。\n" +
          "进程被终止且对话上下文永久丢失。与 /cancel 不同，无法 resume 之前的对话。\n" +
          "即使 session 正在 busy 也可以执行（/reset 单独使用时会拒绝 busy session）。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "status",
      command: {
        name: "status",
        description: "显示 console 或某 session 的状态",
        notes:
          "操作：\n" +
          "  • root 群无参数：查询所有 active session，显示总数和 busy 数\n" +
          "  • root 群指定 name：显示该 session 的详细信息\n" +
          "  • session 群：显示当前绑定 session 的详细信息\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "log",
      command: {
        name: "log",
        description: "查看当前 session 最近 10 条注入信息",
        notes:
          "操作：\n" +
          "  • session 群：列出当前绑定 session 最近 10 条被跨 session 注入的信息\n" +
          "  • Console 群：/log <session> 查看指定 session 最近 10 条被注入的信息\n" +
          "  • 数据来自 cross_session_log 中 to_session_id 指向该 session 的记录，按创建时间倒序\n" +
          "  • 每条显示来源、类型、时间和内容预览；内容预览超过 150 个字符会截断\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "sta-writeback",
      command: {
        name: "sta-writeback",
        description: "按 task_id 手动触发 shipment-creater STA 货件写回",
        notes:
          "用法：/sta-writeback task_id=<id> 或 /sta-writeback task_id=\"<id>\"。\n" +
          "运行时解析当前群绑定的 session，在该 session 工作区执行 scripts/sta_writeback.py --message <原始消息>，并把脚本 JSON 摘要回复到当前群。\n\n" +
          "影响的资源：shipment-creater 脚本会按 task_id 查找持久化工作流任务，并执行该脚本定义的 STA 写回逻辑。\n\n" +
          "可逆性：命令本身不可撤销；重复执行是否幂等由 shipment-creater 写回脚本负责。",
        scope: ["user"],
        params: [{ name: "payload", type: "string", required: true, kind: "rest" }],
      },
    },
    {
      name: "heartbeat",
      command: {
        name: "heartbeat",
        description: "关闭、暂停、恢复或查看当前 session 的 heartbeat 巡检",
        notes:
          "操作：\n" +
          "  • Session 群：/heartbeat on|off|status|stop|resume [minutes|permanent]\n" +
          "  • Session 群快捷：stop heartbeat [minutes|permanent] / resume heartbeat\n" +
          "  • Console 群：/heartbeat <session-name> on|off|status|stop|resume [minutes|permanent]\n\n" +
          "影响的资源：\n" +
          "  • 数据库：sessions.heartbeat_enabled\n" +
          "  • heartbeat 本地库：heartbeat_pauses + heartbeat_events 暂停/恢复日志\n" +
          "  • 后续 heartbeat 巡检：默认开启；临时暂停到期自动恢复，永久关闭后忽略\n" +
          "  • 飞书：本命令只回复当前命令结果，不主动通知其他群\n\n" +
          "可逆性：可逆，可以随时 resume/on。child session、deleted session 和 heartbeat 自身不能开启。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: true, kind: "positional", scope: ["root"] },
          { name: "state", type: "enum", required: true, kind: "positional", enum: ["on", "off", "status", "stop", "resume"] },
          { name: "duration", type: "string", required: false, kind: "positional" },
        ],
      },
    },
    {
      name: "help",
      command: {
        name: "help",
        description: "显示当前 scope 可用的命令",
        notes:
          "操作：\n" +
          "  • 无参数：列出当前 scope 下所有可用命令及简要说明\n" +
          "  • 指定 command：显示该命令的完整参数说明和影响面详情\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional" }],
      },
    },
    {
      name: "rank",
      command: {
        name: "rank",
        description: "消息排行榜。Console 群显示全局排行（含 TOP3 session），其他群显示本群统计",
        notes:
          "无参数。\n" +
          "Console 群（root scope）：全系统用户累计消息数排行，每人附 TOP3 活跃 session。\n" +
          "其他群（user scope）：仅显示当前群的用户发言统计，无 TOP3。\n" +
          "统计从 sender_id 字段首次有值的时间起算，部署前的历史消息不计入。",
        scope: ["root", "user"],
        params: [],
      },
    },
    {
      name: "reload",
      command: {
        name: "reload",
        description: "热更新：干净退出由 supervisor 重启。有 busy session 时拒绝，--force 强制",
        notes:
          "有 busy session 时返回阻塞原因。--force 跳过检查直接重启。" +
          "--source <name> 标记触发来源（默认 user (console)）。重启后 console 群会收到恢复通知并显示来源。",
        scope: ["root"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional" },
          { name: "source", type: "string", required: false, kind: "named" },
        ],
      },
    },
    {
      name: "model",
      command: {
        name: "model",
        description: "切换 session 使用的模型（/model default 恢复默认）",
        notes:
          "可选模型值（按 session backend 区分）：\n" +
          "  • Claude: opus / sonnet / haiku\n" +
          "      - opus   — Claude Opus 4.7 (claude-opus-4-7)\n" +
          "      - sonnet — Claude Sonnet 4.6 (claude-sonnet-4-6)\n" +
          "      - haiku  — Claude Haiku 4.5 (claude-haiku-4-5-20251001)\n" +
          `  • Codex: ${formatAvailableCodexModels()}\n` +
          "  • default — 恢复为系统默认模型\n" +
          "  • 也可以传完整 model ID，如 claude-opus-4-7、gpt-5.5、gpt-5.3-codex\n" +
          "  • 注意：Codex 模型是否可用取决于当前 Codex 登录方式和账号放量；若 gpt-5.5 不可用，可改用 gpt-5.4\n\n" +
          "用法示例：\n" +
          "  • Console 群（Claude）：/model my-session opus\n" +
          "  • Console 群（Codex）：/model my-session gpt-5.5\n" +
          "  • Session 群：/model gpt-5.5\n" +
          "  • Codex 历史稳定项：/model gpt-5.3-codex\n" +
          "  • 恢复默认：/model default\n\n" +
          "批量模式（仅 Console 群）：\n" +
          "  • /model all <model>         — 所有 user scope session\n" +
          "  • /model all-claude <model>  — 所有 backend=claude 的 user scope session\n" +
          "  • /model all-codex <model>   — 所有 backend=codex 的 user scope session\n" +
          "  • 过滤条件：scope=user 且 status!=deleted\n" +
          "  • 单个 session 更新失败不会中断整体，失败列表会附在回复末尾\n\n" +
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群，直接 /model <model>）\n" +
          "  2. 更新数据库中 session 的 model 字段（\"default\" 存为 null）\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 model 字段更新\n" +
          "  • 后续对话：下一条消息开始使用新模型\n" +
          "  • 进程：不影响当前运行中的进程\n" +
          "  • 文件系统：不影响\n" +
          "  • 飞书：不影响\n\n" +
          "可逆性：可逆——随时可以再次 /model 切换回原模型，或 /model default 恢复默认。\n" +
          "注意：backendSessionId 保留但新模型可能无法 resume 旧会话。\n" +
          "建议切换模型后执行 /reset 清空上下文，确保新模型从干净状态开始。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "model", type: "string", required: false, kind: "positional" },
        ],
      },
    },
    {
      name: "backend",
      command: {
        name: "backend",
        description: "切换 session 使用的后端（claude ↔ codex）",
        notes:
          "用法示例：\n" +
          "  • Console 群：/backend my-session codex\n" +
          "  • Session 群：/backend codex\n\n" +
          "操作顺序：\n" +
          "  1. 检查 session 状态（busy 时拒绝操作）\n" +
          "  2. 清空 backendSessionId（旧 backend 的 resume token 不兼容）\n" +
          "  3. 重置 model 为默认（跨 backend model ID 不通用）\n" +
          "  4. 更新 backend 字段\n" +
          "  5. 更新飞书群名后缀\n" +
          "  6. 列出该 session 下 enabled 的定时任务（只展示，不修改）\n" +
          "  7. 重新生成全局 session-catalog.json（失败仅告警，不回滚）\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 backend、backendSessionId、model 字段更新\n" +
          "  • 对话上下文：清空（等同于 /reset + 切换 backend）\n" +
          "  • 飞书：群名后缀更新为新 backend\n" +
          "  • sibling session：全局 session-catalog.json 被重新生成\n" +
          "  • 进程：不影响当前运行中的进程\n" +
          "  • 文件系统：session-catalog.json 会被重新生成\n\n" +
          "可逆性：可逆——随时可以再次 /backend 切换回来，但对话上下文无法恢复。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "backend", type: "string", required: false, kind: "positional" },
        ],
      },
    },
    {
      name: "effort",
      command: {
        name: "effort",
        description: "调整 session 的推理强度（/effort default 恢复默认）",
        notes:
          "可选值：\n" +
          "  • low     — 快速响应，适合简单任务\n" +
          "  • medium  — 默认平衡\n" +
          "  • high    — 深度思考，适合复杂任务\n" +
          "  • xhigh   — 超高强度（介于 high 与 max 之间）\n" +
          "  • max     — 最高强度，极致推理\n" +
          "  • default — 恢复为系统默认\n\n" +
          "用法示例：\n" +
          "  • Console 群：/effort my-session high\n" +
          "  • Session 群：/effort high\n" +
          "  • 恢复默认：/effort default\n\n" +
          "批量模式（仅 Console 群）：\n" +
          "  • /effort all <level>         — 所有 user scope session\n" +
          "  • /effort all-claude <level>  — 所有 backend=claude 的 user scope session\n" +
          "  • /effort all-codex <level>   — 所有 backend=codex 的 user scope session\n" +
          "  • 过滤条件：scope=user 且 status!=deleted\n" +
          "  • 单个 session 更新失败不会中断整体，失败列表会附在回复末尾\n\n" +
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群，直接 /effort <level>）\n" +
          "  2. 更新数据库中 session 的 effort 字段（\"default\" 存为 null）\n\n" +
          "后端行为：\n" +
          "  • Claude 后端：映射为 --reasoning-effort 参数\n" +
          "  • Codex 后端：映射为 --reasoning-effort 参数\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 effort 字段更新\n" +
          "  • 后续对话：下一条消息开始使用新的推理强度\n" +
          "  • 进程：不影响当前运行中的进程\n\n" +
          "可逆性：可逆——随时可以再次 /effort 切换，或 /effort default 恢复默认。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "level", type: "string", required: false, kind: "positional" },
        ],
      },
    },
    {
      name: "timeout",
      command: {
        name: "timeout",
        description: "设置 session 不活动超时和最大运行时间",
        notes:
          "操作：\n" +
          "  • 无超时参数：显示当前超时配置\n" +
          "  • <seconds>：设置不活动超时（秒），0 禁用，default 恢复默认\n" +
          "  • --maxrun <seconds>：设置最大运行时间（秒），off 或 0 表示无限制\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 inactivityTimeoutS / maxRuntimeS 字段更新\n" +
          "  • 进程：不影响当前运行中的进程\n\n" +
          "可逆性：可逆——随时可以再次 /timeout 修改，或 /timeout default 恢复默认。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "timeout", type: "string", required: false, kind: "positional" },
          { name: "maxrun", type: "string", required: false, kind: "named" },
        ],
      },
    },
    {
      name: "skills",
      command: {
        name: "skills",
        description: "列出 session 可调用的所有 skill（插件、自定义命令等）",
        notes:
          "操作：扫描三处 skill 来源：\n" +
          "  • ~/.claude/skills/ → canonical skill 池（skill-master 软链 + superpowers）\n" +
          "  • ~/.claude/commands/ + <workdir>/.claude/commands/ → 自定义命令\n" +
          "  • <workdir>/.claude/settings.json → mcpServers\n\n" +
          "影响的资源：无，只读操作。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root", "user"],
        params: [{ name: "name", type: "string", required: false, kind: "positional", scope: ["root"] }],
      },
    },
    {
      name: "next",
      command: {
        name: "next",
        description: "排队多条消息，在当前任务完成后按 FIFO 顺序自动执行",
        notes:
          "操作：\n" +
          "  • session 空闲时：直接投递，等同于直接发消息\n" +
          "  • session 忙碌时：排队多条消息，任务完成后按提交顺序自动投递\n" +
          "  • 已有排队消息时：继续入队，不拒绝第二条及后续消息\n\n" +
          "影响的资源：\n" +
          "  • 内存：排队消息存储在进程内存中，重启后丢失\n\n" +
          "可逆性：可通过 /cancel next 清空尚未消化的排队消息；进程重启也会清除未消化的排队。",
        scope: ["user"],
        params: [{ name: "text", type: "string", required: true, kind: "rest" }],
      },
    },
    {
      name: "todo",
      command: {
        name: "todo",
        description: "记录一条 To-do；明确负责人和内容时直接写表，否则转交 todomaster",
        notes:
          "支持：/todo 或 /todo <自然语言补充>。\n" +
          "运行时要求当前群绑定到一个 session；Console 或未绑定群会明确失败。\n" +
          "处理流程：如果补充内容能解析出唯一负责人和非空任务内容，直接调用 todomaster 写表脚本并回复最终结果；否则读取来源 session 最近 5 条 completed message_runs，启动 todomaster 子 session，立即回复已转交；最终成功/失败由子 session 回发到原群。\n\n" +
          "影响的资源：\n" +
          "  • 数据库：只读 sessions/bindings；兜底路径会读取 message_runs 并创建 todomaster child session 和一条 child message_run\n" +
          "  • 飞书：todomaster 写入随时大小记1.0/todolist 一条记录\n" +
          "  • 原群：直接路径收到最终结果；兜底路径收到立即转交提示和最终结果\n\n" +
          "可逆性：命令本身不删除数据。重复同一 command_message_id 时由 todomaster 本地幂等表避免重复写行。",
        scope: ["root", "user"],
        params: [{ name: "text", type: "string", required: false, kind: "rest" }],
      },
    },
    {
      name: "spawn",
      command: {
        name: "spawn",
        description: "在目标 session 的工作区 spawn 一个子 session 执行任务",
        notes:
          "操作顺序：\n" +
          "  1. 校验目标 session 存在\n" +
          "  2. 检查嵌套深度（最大 3 层）和并发数（单 parent 最多 5 个子 session）\n" +
          "  3. 在数据库创建子 session 记录（scope=child，status=busy）\n" +
          "  4. 在目标 session 的工作区中启动 backend 执行 prompt\n" +
          "  5. 收集 backend 最终输出\n" +
          "  6. 子 session 状态设为 idle\n" +
          "  7. 将结果发送到指定群（--reply-to）或目标 session 的绑定群\n\n" +
          "影响的资源：\n" +
          "  • 数据库：创建子 session 记录（空闲 60 分钟后自动清理）\n" +
          "  • 进程：启动独立 backend 进程\n" +
          "  • 文件系统：在目标 session 的工作区中操作（非子 session 自有目录）\n" +
          "  • 飞书：结果消息发送到指定群或 parent 绑定群\n" +
          "  • 目标 session：不影响其正在进行的对话（子 session 有独立 backend 会话）\n\n" +
          "可逆性：子 session 本身会自动清理（60 分钟空闲后删除）。\n" +
          "但子 session 对工作区文件的修改是持久的，需手动回滚（如 git revert）。\n\n" +
          "可用 --backend claude|codex 指定子 session 使用的后端（默认继承父 session）。\n" +
          "可用 --model <model|default> 指定子 session 使用的模型；不传时同 backend 继承 parent model，跨 backend 使用默认模型。\n" +
          "可用 --from <session-name> 标记发起方 session，用于跨 session 通讯日志记录。\n" +
          "可用 --reply-to <chat_id> 指定结果发送到哪个群。\n" +
          "推荐通过 HTTP API 调用：POST http://localhost:3501/api/spawn",
        scope: ["root"],
        params: [
          { name: "name", type: "string", required: true, kind: "positional" },
          { name: "prompt", type: "string", required: true, kind: "rest" },
        ],
      },
    },
    {
      name: "btw",
      command: {
        name: "btw",
        description: "在当前 session 群内开一条侧线对话（by the way），不污染主会话上下文",
        notes:
          "操作：\n" +
          "  • 在 session 群内使用 /btw <prompt>\n" +
          "  • 首次使用：spawn 一个绑定到本群的子 session，保持 idle 状态\n" +
          "  • 后续使用：自动 resume 同一子 session，延续对话上下文\n" +
          "  • 父 session 的 backendSessionId 完全不受影响\n\n" +
          "自动清理：\n" +
          "  • 10 分钟无 /btw 活动 → backend 进程取消 + 子 session 标记 deleted\n" +
          "  • 下一次 /btw 会 spawn 一个全新的侧线\n\n" +
          "影响的资源：\n" +
          "  • 数据库：新建子 session 记录（scope=child，keepAlive=true 保持 idle）\n" +
          "  • 进程：启动独立 backend 进程，10 分钟空闲后自动清理\n" +
          "  • 文件系统：在父 session 的工作区中操作\n" +
          "  • 飞书：回复直接返回当前群\n" +
          "  • 父 session：对话上下文完全不被污染\n\n" +
          "可逆性：子 session 本身自动清理；工作区文件的修改是持久的（如需回滚用 git）。",
        scope: ["user"],
        params: [{ name: "text", type: "string", required: true, kind: "rest" }],
      },
    },
    {
      name: "selfcheck",
      command: {
        name: "selfcheck",
        description: "在 observe 模式下运行 boot self-check 并返回报告",
        notes:
          "操作：\n" +
          "  • 跑完 local-deps、supervisor-presence、scheduler-health、reconcile-backend-processes 四个 check\n" +
          "  • observe 模式下不会杀进程、不会改数据库\n" +
          "  • 如需实际清理孤儿 backend，请使用 /reload force\n\n" +
          "影响的资源：无（只读）。\n\n" +
          "可逆性：不适用（只读）。",
        scope: ["root"],
        params: [],
      },
    },
  ];

  const registry: CommandRegistry = {};
  for (const { name, command } of base) {
    registry[name] = { command, handler: placeholderHandler };
  }
  return registry;
}
