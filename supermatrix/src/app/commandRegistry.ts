import type { Command } from "../domain/command.ts";
import type { Scope } from "../domain/scope.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import {
  formatAvailableCodexModels,
  formatCodexEffortMatrix,
} from "../ports/CodexModelCatalog.ts";
import { formatAvailableKimiModels } from "../ports/KimiModelCatalog.ts";
import { assertCommandRegistryPolicy } from "./commandRegistryPolicy.ts";
import { BACKEND_ALIASES } from "./commands/backendAliases.ts";

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
          "Clone 用法：`/new clone <来源session> <backend> <新session名> [purpose...]`。\n" +
          "Clone 复制来源的工作目录、purpose、category、thinking、timeout/maxrun 与 heartbeat；显式 purpose 可覆盖来源 purpose。\n" +
          "新 session 的「附属于」标记为来源 session；该治理归属不使用 runtime parent_id。\n" +
          "新 session、飞书群、binding 与 backend context 均独立创建；avatar、alias、model、effort 及锁定状态不复制。\n" +
          "可选 --model 参数指定目标 backend 模型（如 claude-sonnet-5），不指定则用目标 backend 默认模型。\n" +
          "可选 --chat-name <name> 指定群名前缀；群名按 `{chat-name}-{session}-{backend}` 生成，不传则为 `{session}-{backend}`。",
        scope: ["root"],
        params: [
          { name: "backend", type: "enum", required: true, kind: "positional", enum: ["claude", "codex", "kimi", "clone"], enumAliases: BACKEND_ALIASES },
          { name: "name", type: "string", required: true, kind: "positional" },
          { name: "model", type: "string", required: false, kind: "named" },
          { name: "workdir", type: "string", required: false, kind: "named" },
          { name: "chat-name", type: "string", required: false, kind: "named" },
          { name: "purpose", type: "string", required: false, kind: "rest" },
        ],
      },
    },
    {
      name: "clone",
      command: {
        name: "clone",
        description: "以当前 session 为来源创建独立 backend session",
        notes:
          "用法：`/clone <backend> <新session名>`，仅在已绑定的 session 群内使用。\n" +
          "来源 session 自动取当前群 binding，无需再填写。\n" +
          "复制规则与 `/new clone` 完全一致：复制工作目录、purpose、category、thinking、timeout/maxrun 与 heartbeat；backend、avatar、alias、model、effort、锁定状态和 backend context 使用新 session 值。\n" +
          "新 session 的「附属于」标记为当前来源 session；该治理归属不使用 runtime parent_id。\n" +
          "新 session 会创建独立飞书群和 binding；来源 session 与工作区文件不被修改。",
        scope: ["user"],
        params: [
          { name: "backend", type: "enum", required: true, kind: "positional", enum: ["claude", "codex", "kimi"], enumAliases: BACKEND_ALIASES },
          { name: "name", type: "string", required: true, kind: "positional" },
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
      name: "usage",
      command: {
        name: "usage",
        description: "查看各订阅账号（Codex / Claude / Kimi）的剩余额度与重置时间",
        notes:
          "操作：只读 sm-switch 生成的额度快照（契约 sm-switch.quota-snapshot/v1），按厂商 → 账号 → 窗口渲染剩余百分比与重置时间。\n" +
          "本命令不触发任何额度采集或账号刷新，也不会触发登录；数值新鲜度完全取决于 sm-switch 的快照。\n\n" +
          "标注含义：\n" +
          "  • 当前账号 / 非当前账号 — 该厂商下是否为正在使用的账号\n" +
          "  • 实时 — 快照写入时该账号刚采集成功\n" +
          "  • 旧值（观测于 …） — 该账号本次未采集（例如非活跃账号），展示的是上次观测值\n" +
          "  • 不可用 — 该账号无法采集，附带原因\n" +
          "  • 快照本身超过 staleAfterSeconds 未刷新时，顶部会提示全部按旧值看待\n\n" +
          "影响的资源：无，只读操作（不含也不展示 token、账号邮箱或配置路径）。\n\n" +
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
          "如果 backend 在写文件中途被终止，可能留下不完整的更改，需在工作区手动检查。\n" +
          "\nnext 关键字大小写不敏感（NEXT / Next 均可）；session 名保持原样。",
        scope: ["root", "user"],
        params: [
          { name: "target", type: "string", required: false, kind: "rest", scope: ["root"] },
          { name: "next", type: "enum", required: false, kind: "positional", enum: ["next"], scope: ["user"] },
        ],
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
          "  3. 清除当前 active branch 的 backendSessionId\n" +
          "  4. 设置 session 状态为 idle\n\n" +
          "影响的资源：\n" +
          "  • 数据库：当前 active branch 的 backendSessionId 清空，status 设为 idle\n" +
          "  • 文件系统：不影响（工作区文件完全不动）\n" +
          "  • 飞书：不影响\n" +
          "  • 进程：不涉及进程操作（busy 时直接拒绝）\n\n" +
          "可逆性：不可逆——对话上下文永久丢失，无法恢复之前的对话。\n" +
          "下次消息将在当前 active branch 开启全新对话（不 resume），但工作区中已有的代码更改不受影响。",
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
          "  3. 清除当前 active branch 的 backendSessionId\n" +
          "  4. 设置 session 状态为 idle\n\n" +
          "影响的资源：\n" +
          "  • 进程：busy 时 backend 进程组被 SIGTERM 终止\n" +
          "  • 数据库：当前 active branch 的 backendSessionId 清空，status 设为 idle\n" +
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
      name: "branch",
      command: {
        name: "branch",
        description: "创建或查看当前 session 的对话分支",
        notes:
          "操作：\n" +
          "  • /branch：列出当前 session 的所有 branch，并用 * 标记 active branch\n" +
          "  • /branch <name>：如果 branch 已存在则切换；不存在则从当前 active branch 创建新 branch，并立即切换过去\n" +
          "  • /branch main：切回默认 main branch\n" +
          "  • Console 群：/branch <session> [name]\n\n" +
          "影响的资源：\n" +
          "  • 数据库：写入 session_branches / session_branch_state\n" +
          "  • 工作区：不创建 git branch、不创建 worktree，文件系统不变\n" +
          "  • 飞书：不新建群，不改 binding\n\n" +
          "后端行为：Claude 首次 inherited branch 运行会用 --resume <source> --fork-session。\n" +
          "Codex 会通过 codex exec resume + fork_context 立即准备 branch，准备失败则不创建 branch。",
        scope: ["root", "user"],
        params: [
          { name: "session", type: "string", required: true, kind: "positional", scope: ["root"] },
          { name: "name", type: "string", required: false, kind: "positional" },
        ],
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
      name: "lock",
      command: {
        name: "lock",
        description: "锁定当前 session 的普通 prompt，向非 owner 消息追加只执行提示",
        notes:
          "操作：将当前群绑定 session 的 workspace lock 持久化为开启。\n" +
          "锁定后，非配置 owner 发送的普通飞书 prompt 会在进入 Agent 前追加锁定提示；slash command 不受影响。\n" +
          "当前版本不新增 owner-only 校验；命令仍遵循所在群已有的 slash-command 边界。\n\n" +
          "影响的资源：数据库 sessions.workspace_locked。\n\n" +
          "可逆性：可逆，使用 /unlock 解锁。",
        scope: ["user"],
        params: [],
      },
    },
    {
      name: "unlock",
      command: {
        name: "unlock",
        description: "解除当前 session 的普通 prompt 锁定状态",
        notes:
          "操作：将当前群绑定 session 的 workspace lock 持久化为关闭。\n" +
          "解锁后，普通飞书 prompt 不再追加锁定提示；slash command 始终不受 workspace lock 影响。\n" +
          "当前版本不新增 owner-only 校验；命令仍遵循所在群已有的 slash-command 边界。\n\n" +
          "影响的资源：数据库 sessions.workspace_locked。\n\n" +
          "可逆性：可逆，使用 /lock 重新锁定。",
        scope: ["user"],
        params: [],
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
      name: "heartbeat",
      command: {
        name: "heartbeat",
        description: "开启、临时暂停、永久停止、恢复或查看当前 session 的 heartbeat 巡检",
        notes:
          "状态语义（关键区分：临时暂停 vs 永久停止）：\n" +
          "  • on               — 永久开启：sessions.heartbeat_enabled=1，并清除当前所有暂停记录\n" +
          "  • off              — 永久停止：sessions.heartbeat_enabled=0，记录 permanent pause；与 stop permanent 等价\n" +
          "  • stop             — 临时暂停 60 分钟：保持 heartbeat_enabled=1，到期自动恢复\n" +
          "  • stop <minutes>   — 临时暂停指定分钟数：保持 heartbeat_enabled=1，到期自动恢复\n" +
          "  • stop permanent   — 永久停止：等价 off（也可写 stop 永久 / stop forever）\n" +
          "  • resume           — 取消临时暂停并重新开启：sessions.heartbeat_enabled=1，清除暂停记录\n" +
          "  • status           — 只读查询：返回 on/off 以及（若临时暂停中）到期时间\n\n" +
          "记忆口诀：on / off / resume / stop permanent 改 heartbeat_enabled 标志；stop [minutes] 只改暂停表，不动标志。\n\n" +
          "使用范围（哪些形态在哪种群可用）：\n" +
          "  • Session 群（user scope）：/heartbeat on|off|status|stop|resume [minutes|permanent]，目标自动绑定本群 session\n" +
          "  • Session 群快捷：stop heartbeat [minutes|permanent] / resume heartbeat（等价于 /heartbeat stop|resume）\n" +
          "  • Console 群（root scope）：/heartbeat <session-name> on|off|status|stop|resume [minutes|permanent]，必须显式给出目标 session 名\n\n" +
          "影响的资源：\n" +
          "  • 数据库 sessions.heartbeat_enabled：on / resume 置 1；off / stop permanent 置 0；stop [minutes] 不改\n" +
          "  • heartbeat 本地库：heartbeat_pauses 写入或清空暂停记录，heartbeat_events 写入操作日志\n" +
          "  • 后续 heartbeat 巡检：临时暂停到期自动恢复；off / stop permanent 后巡检忽略该 session，直到再次 on / resume\n" +
          "  • 飞书：本命令只回复当前命令结果，不主动通知其他群\n\n" +
          "可逆性：可逆——临时暂停到期自动恢复；off / stop permanent 之后任意时刻 /heartbeat on 或 /heartbeat resume 即可重新开启。\n" +
          "child session、deleted session 和 heartbeat 自身不能开启 heartbeat。\n" +
          "\n输入别名（大小写与全角不敏感）：enable/开启=on，disable/关闭=off，pause/暂停=stop，continue/恢复=resume，show/状态=status。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: true, kind: "positional", scope: ["root"] },
          {
            name: "state",
            type: "enum",
            required: true,
            kind: "positional",
            enum: ["on", "off", "status", "stop", "resume"],
            enumAliases: {
              enable: "on",
              "开启": "on",
              disable: "off",
              "关闭": "off",
              pause: "stop",
              "暂停": "stop",
              continue: "resume",
              "恢复": "resume",
              show: "status",
              "状态": "status",
            },
          },
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
          "用法：\n" +
          "  • /rank：显示当前 scope 的消息排行榜。\n" +
          "  • /rank <完整姓名>：仅 Console 群可用，显示该用户近 7 天的个人基础详情。\n" +
          "  • 姓名按完整名称精确匹配；发生重名时可改用 /rank <open_id>。\n\n" +
          "Console 群（root scope）：全系统用户消息数排行，每人附 TOP3 活跃 session。\n" +
          "其他群（user scope）：仅显示当前群的用户发言统计，无 TOP3。\n" +
          "个人详情包含：全局名次、消息数、输入字数、平均每条字数和全部 session 分布。\n" +
          "统计窗口：滚动近 7 天；部署前没有 sender_id 的历史消息不计入。\n\n" +
          "影响的资源：无，只读操作。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
        ],
      },
    },
    {
      name: "reload",
      command: {
        name: "reload",
        description: "热更新：干净退出由 supervisor 重启。有 busy session 时拒绝，--force 强制",
        notes:
          "有 busy session 时返回阻塞原因。--force 跳过检查直接重启。" +
          "--source <name> 标记触发来源（默认 user (console)）。重启后 console 群会收到恢复通知并显示来源。" +
          " 也接受显式 force / 强制 / --强制（大小写与全角不敏感），效果同 --force。",
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
          "  • Claude: fable / opus / sonnet / haiku\n" +
          "      - fable  — Claude Fable 5 (claude-fable-5)\n" +
          "      - opus   — Claude Opus 5 (claude-opus-5)\n" +
          "      - sonnet — Claude Sonnet 5 (claude-sonnet-5)\n" +
          "      - haiku  — Claude Haiku 4.5 (claude-haiku-4-5-20251001)\n" +
          `  • Codex: ${formatAvailableCodexModels()}\n` +
          `  • Kimi: ${formatAvailableKimiModels()}\n` +
          "      - kimi-code/kimi-for-coding — K2.7 默认编码模型；K2.7 thinking 固定 on，无 effort 档位\n" +
          "      - kimi-code/kimi-for-coding-highspeed — K2.7 高速版；thinking 同样固定 on\n" +
          "      - kimi-code/k3 — K3；支持 effort 档位（low/medium/high/xhigh/max/ultra 映射 K3 原生 low/high/max）\n" +
          "  • default — 恢复为系统默认模型\n" +
          "  • 也可以传完整 model ID，如 claude-fable-5、claude-opus-5、claude-sonnet-5、gpt-5.6-sol、gpt-5.5\n" +
          "  • 注意：fable（Claude Fable 5）能力最强但定价 $10/$50 per MTok（约 opus 的 2 倍），部分敏感主题会自动回退到 Opus 4.8\n" +
          "  • 注意：Codex 模型是否可用取决于当前 Codex 登录方式和账号放量；若 5.6 系列不可用，可改用 gpt-5.5 / gpt-5.4\n\n" +
          "用法示例：\n" +
          "  • /model                                # 只读查看 Claude/Codex/Kimi 当前默认模型\n" +
          "  • /model global                         # 查看 Claude/Codex/Kimi 全局默认模型\n" +
          "  • /model global claude sonnet          # 设置 Claude 全局默认模型\n" +
          "  • /model global codex gpt-5.4          # 设置 Codex 全局默认模型\n" +
          "  • /model global kimi k3                # 设置 Kimi 全局默认模型\n" +
          "  • /model global <backend> default      # 清除该 backend 的全局默认（Kimi 回落 kimi-code/kimi-for-coding）\n" +
          "  • /model global child gpt-5.5          # 设置后续所有系统入口新建 child 的模型\n" +
          "  • /model global child default|inherit  # 显式 backend 默认 / 清除 child 覆盖\n" +
          "  • /model amz-sql gpt-5.5  # max/ultra becomes xhigh when necessary\n" +
          "  • /model all-codex gpt-5.6-luna  # all selected sessions update atomically\n" +
          "  • Console 群（Claude）：/model my-session opus\n" +
          "  • Console 群（Codex）：/model my-session gpt-5.6-sol\n" +
          "  • Console 群（Kimi）：/model my-kimi-session k3\n" +
          "  • Session 群：/model gpt-5.6-sol\n" +
          "  • Codex 兼容候选：/model gpt-5.5\n" +
          "  • 恢复默认：/model default\n\n" +
          "批量模式（仅 Console 群）：\n" +
          "  • /model all <model>         — 所有 user scope session\n" +
          "  • /model all-claude <model>  — 所有 backend=claude 的 user scope session\n" +
          "  • /model all-codex <model>   — 所有 backend=codex 的 user scope session\n" +
          "  • 过滤条件：scope=user 且 status!=deleted\n" +
          "  • included targets 先统一校验、再原子提交，任一失败则全部不写\n\n" +
          "主 session 每日回落值由飞书多维表格「主model默认值」控制；旧 Fixed/Unfixed 功能已退役。\n\n" +
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群，直接 /model <model>）\n" +
          "  2. 更新数据库中 session 的 model 字段（\"default\" 存为 null）\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 model 字段更新\n" +
          "  • 后续对话：下一条消息开始使用新模型\n" +
          "  • 进程：不影响当前运行中的进程\n" +
          "  • 文件系统：不影响\n" +
          "  • 飞书：同步主model当前\n\n" +
          "可逆性：可逆——随时可以再次 /model 切换回原模型，或 /model default 恢复默认。\n" +
          "现有 conversation context 和 backendSessionId 会保留；receipt 展示实际 effective model / effort。\n" +
          "若新模型与旧 resume context 不兼容，必须手动执行 /reset。\n" +
          "\n输入别名（大小写与全角不敏感）：\n" +
          "  • 默认：default / 默认\n" +
          "  • Claude 简写：opus / opus5 / opus-5；sonnet / sonnet5 / sonnet-5；旧版本可用 opus4.8 / opus-4.8、sonnet4.6 / sonnet-4.6\n" +
          "  • child 默认：仅 Console 群可用；/model global child <model|default|inherit> 影响后续所有系统入口新建 child，并将 child effort 重置为 inherit，不改已有 child\n" +
          "  • Codex 简写：sol / terra / luna / 5.5 / 5.4 / mini（= gpt-5.4-mini）；5.6 需指明 sol / terra / luna\n" +
          "  • Kimi 简写：kimi / k2 / k2.7 / k27 / coding（= kimi-for-coding）；highspeed / fast（= kimi-for-coding-highspeed）；k3\n",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "model", type: "string", required: false, kind: "positional" },
          { name: "value", type: "string", required: false, kind: "positional", scope: ["root"] },
        ],
      },
    },
    {
      name: "backend",
      command: {
        name: "backend",
        description: "切换 session 使用的后端（claude / codex / kimi）",
        notes:
          "用法示例：\n" +
          "  • Console 群：/backend my-session codex\n" +
          "  • Console 群：/backend global child codex  # 设置后续所有系统入口新建 child\n" +
          "  • 清除 child tuple：/backend global child inherit\n" +
          "  • Session 群：/backend codex\n\n" +
          "操作顺序：\n" +
          "  1. 检查 session 状态（busy 时拒绝操作）\n" +
          "  2. 将 backend / backendSessionId / model / effort tuple 一次原子提交（切换 backend，同时清空 resume token，并将 model / effort 重置为默认）\n" +
          "  3. 更新飞书群名后缀\n" +
          "  4. 列出该 session 下 enabled 的定时任务（只展示，不修改）\n" +
          "  5. 重新生成全局 session-catalog.json（失败仅告警，不回滚）\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 backend / backendSessionId / model / effort tuple 一次原子提交\n" +
          "  • 对话上下文：清空（等同于 /reset + 切换 backend）\n" +
          "  • 飞书：群名后缀更新为新 backend\n" +
          "  • sibling session：全局 session-catalog.json 被重新生成\n" +
          "  • 进程：不影响当前运行中的进程\n" +
          "  • 文件系统：session-catalog.json 会被重新生成\n\n" +
          "可逆性：可逆——随时可以再次 /backend 切换回来，但对话上下文无法恢复。\n" +
          "child 默认仅 Console 群可用；设置或清除 backend 会清除 child 的 model / effort 覆盖，影响后续所有系统入口新建 child，且不会改已有 child。\n" +
          "\n输入别名（大小写与全角不敏感）：claude-code→claude、codex-cli→codex、k2→kimi。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "backend", type: "string", required: false, kind: "positional" },
          { name: "value", type: "string", required: false, kind: "positional", scope: ["root"] },
        ],
      },
    },
    {
      name: "effort",
      command: {
        name: "effort",
        description: "调整 session 的推理强度（/effort default 恢复默认）",
        notes:
          "可选值按 session backend 区分：\n" +
          "  • Claude: low / medium / high / xhigh / max\n" +
          "      - Claude Fable 5（claude-fable-5）还支持 ultracode（仅显式 Fable session；旧记录 fable 兼容）。Claude 全局默认与其他 Claude 模型均拒绝 ultracode。\n" +
          `  • Codex: 按 model 区分\n${formatCodexEffortMatrix().split("\n").map((line) => `      - ${line}`).join("\n")}\n` +
          "  • Kimi: 按 model 区分——K3 模型（k3）支持 low / medium / high / xhigh / max / ultra（映射到 K3 原生 low/high/max）；K2.7 模型（kimi-for-coding / -highspeed）thinking 固定 on，不支持具体档位，仅可省略或使用 default\n" +
          "  • default — 恢复为系统默认\n\n" +
          "用法示例：\n" +
          "  • /effort global                       # 查看 Claude/Codex/Kimi 全局默认 effort\n" +
          "  • /effort global claude high           # 设置 Claude 全局默认 effort\n" +
          "  • /effort global codex high            # 设置 Codex 全局默认 effort\n" +
          "  • /effort global kimi high             # 设置 Kimi K3 全局默认 effort\n" +
          "  • /effort global child high            # 设置后续所有系统入口新建 child 的 effort\n" +
          "  • /effort global child default|inherit # 显式 backend 默认 / 清除 child 覆盖\n" +
          "  • /effort all-codex ultra  # sol/terra=ultra, luna=max, 5.5/5.4=xhigh\n" +
          "  • Console 群（Claude）：/effort my-session high\n" +
          "  • Console 群（Codex）：/effort my-codex-session xhigh\n" +
          "  • Session 群：/effort high\n" +
          "  • 恢复默认：/effort default\n\n" +
          "批量模式（仅 Console 群）：\n" +
          "  • /effort all <level>         — 所有 user scope session\n" +
          "  • /effort all-claude <level>  — 所有 backend=claude 的 user scope session\n" +
          "  • /effort all-codex <level>   — 所有 backend=codex 的 user scope session\n" +
          "  • /effort all-kimi <level>    — 所有 backend=kimi 的 user scope session\n" +
          "  • 过滤条件：scope=user 且 status!=deleted\n" +
          "  • included targets 先统一计算 actual effective effort，再原子提交；任一冲突则全部不写\n\n" +
          "主 session 每日回落值由飞书多维表格「主effort默认值」控制；旧 Fixed/Unfixed 功能已退役。\n\n" +
          "操作顺序：\n" +
          "  1. 解析目标 session（session 群内自动绑定当前群，直接 /effort <level>）\n" +
          "  2. 更新数据库中 session 的 effort 字段（\"default\" 存为 null）\n\n" +
          "后端行为：\n" +
          "  • Claude 后端：原样传给 --effort 参数\n" +
          "  • Codex 后端：写入 model_reasoning_effort；selected model 支持的 effort 原样传递，不支持的历史 max / ultra 降级为 xhigh\n" +
          "  • Kimi 后端：K3 的 effort 映射为原生 low / high / max；K2.7 thinking 固定 on\n\n" +
          "影响的资源：\n" +
          "  • 数据库：session 的 effort 字段更新\n" +
          "  • 后续对话：下一条消息开始使用 receipt 中的 actual effective 推理强度\n" +
          "  • 进程：不影响当前运行中的进程\n\n" +
          "可逆性：可逆——随时可以再次 /effort 切换，或 /effort default 恢复默认。\n" +
          "\n输入别名（大小写与全角不敏感）：默认 = default。\n" +
          "child 默认仅 Console 群可用；/effort global child <level|default|inherit> 影响后续所有系统入口新建 child，不改已有 child。",
        scope: ["root", "user"],
        params: [
          { name: "name", type: "string", required: false, kind: "positional", scope: ["root"] },
          { name: "level", type: "string", required: false, kind: "positional" },
          { name: "value", type: "string", required: false, kind: "positional", scope: ["root"] },
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
          "可逆性：可逆——随时可以再次 /timeout 修改，或 /timeout default 恢复默认。\n" +
          "\n输入别名（大小写与全角不敏感）：default/默认 恢复默认；--maxrun off/关闭 表示无限制。",
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
      name: "now",
      command: {
        name: "now",
        description: "向当前正在执行的任务注入补充说明",
        notes:
          "仅用于当前群已绑定且正在运行的 Claude/Codex session。\n" +
          "注入严格绑定当前 message_run；只有 backend 确认同一 run 已接收才返回成功。\n" +
          "session 空闲时不会启动新任务；Kimi 当前不支持。",
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
          "处理流程：如果补充内容能解析出唯一负责人和非空任务内容，直接调用 todomaster 写表脚本并回复最终结果；否则读取来源 session 最近 5 条 completed message_runs，启动 todomaster 子 session，立即回复已转交；若本条消息是对另一条飞书消息的回复，引用消息的 id、发送者/时间、内容或获取/解析错误会以有界数据交给该 fallback，用于补全上下文但不会作为指令执行；最终成功/失败由子 session 回发到原群。\n\n" +
          "影响的资源：\n" +
          "  • 数据库：只读 sessions/bindings；兜底路径会读取 message_runs 并创建 todomaster child session 和一条 child message_run\n" +
          "  • 飞书：todomaster 写入PRODUCT_REDACTED/todolist 一条记录\n" +
          "  • 原群：直接路径收到最终结果；兜底路径收到立即转交提示和最终结果\n\n" +
          "可逆性：命令本身不删除数据。重复同一 command_message_id 时由 todomaster 本地幂等表避免重复写行。",
        scope: ["root", "user"],
        params: [{ name: "text", type: "string", required: false, kind: "rest" }],
      },
    },
    {
      name: "idea",
      command: {
        name: "idea",
        description: "记录一条 Idea（非紧急想法/后续项，人类写入 for 人-进展状态=idea）；行为镜像 /todo，只是进展状态不同",
        notes:
          "支持：/idea 或 /idea <自然语言补充>。\n" +
          "与 /todo 走完全相同的入库链路：解析当前群绑定 session、尝试同样的 direct fast path、否则读取来源 session 最近 5 条 completed message_runs 并转交 todomaster；" +
          "若本条消息是对另一条飞书消息的回复，引用消息的 id、发送者/时间、内容或获取/解析错误会以有界数据交给 fallback，用于补全上下文但不会作为指令执行；唯一区别是 command_text 保留 /idea 开头，todomaster 写入器据此在人类记录的 for 人-进展状态字段写入 idea（/todo 写 未开始），表示这是可挂在看板上的想法而非需立即执行的任务。\n" +
          "运行时要求当前群绑定到一个 session；Console 或未绑定群会明确失败。\n\n" +
          "影响的资源：\n" +
          "  • 数据库：只读 sessions/bindings；兜底路径会读取 message_runs 并创建 todomaster child session 和一条 child message_run\n" +
          "  • 飞书：todomaster 向 PRODUCT_REDACTED/todolist 写入一条记录（for 人-进展状态=idea）\n" +
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
          "可用 --backend claude|codex|kimi 指定本次子 session 使用的后端。\n" +
          "可用 --model <model|default>、--effort <low|medium|high|xhigh|max|ultra|ultracode|default> 指定本次模型和推理强度。\n" +
          "未显式指定的字段优先使用 /backend|/model|/effort global child 的已配置默认；全部未配置时保持既有同 backend 继承、跨 backend 默认语义。\n" +
          "可用 --from <session-name> 标记发起方 session，用于跨 session 通讯日志记录。\n" +
          "可用 --reply-to <chat_id> 指定结果发送到哪个群。\n" +
          "推荐通过 HTTP API 调用：POST http://localhost:3501/api/spawn2.0 (body 必须包含 from / target / prompt / client_request_id / closure，其中 closure.kind=\"message\"，closure.target.type=\"inline\" 或 \"todo_pool\")",
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
  assertCommandRegistryPolicy(registry);
  return registry;
}
