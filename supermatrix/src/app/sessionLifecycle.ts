import { execFile } from "node:child_process";
import { join } from "node:path";
import { createSessionCatalogService } from "./sessionCatalog.ts";
import { UserError, SystemError } from "../domain/errors.ts";
import {
  asAbsolutePath,
  asSessionId,
  type AbsolutePath,
} from "../domain/ids.ts";
import type { SessionEvent } from "../domain/events/sessionEvent.ts";
import type { BackendKind, Session } from "../domain/session.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { LarkGateway } from "../ports/LarkGateway.ts";
import type { WorkspaceFs } from "../ports/WorkspaceFs.ts";
import { errorMessage } from "./errorMessage.ts";

const PRINCIPLES_FILES = [
  "console-principles.md",
  "coding-principles.md",
  "business-principles.md",
] as const;

export type SessionLifecycleDeps = {
  store: BindingStore;
  fs: WorkspaceFs;
  lark: LarkGateway;
  clock: Clock;
  workspaceRoot: AbsolutePath;
  // Absolute path of the single global session-catalog.json. Every workspace
  // gets a symlink pointing here; one regeneration updates the whole fleet.
  catalogPath: AbsolutePath;
  principlesTemplatesDir: AbsolutePath;
  claudeMdTemplatePath: AbsolutePath;
  agentsMdTemplatePath: AbsolutePath;
  gitignorePath: AbsolutePath;
  ownerUserId: string;
  idFactory?: () => string;
  cancelBackend?: (sessionId: string) => Promise<void>;
  eventBus?: EventBus;
};

export type CreateInput = {
  backend: BackendKind;
  name: string;
  purpose: string;
  model?: string;
  workdir?: AbsolutePath;
  chatName?: string;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;

function syncSessionTableToLark(): void {
  const syncScript = join(
    process.env.SM_WORKSPACE_ROOT || "",
    "first-principle/scripts/sync-session-table.sh",
  );
  execFile("bash", [syncScript], { timeout: 30000 }, (err) => {
    if (err) console.error("session-table sync failed:", err.message);
  });
}

export function createSessionLifecycle(deps: SessionLifecycleDeps) {
  const emit = (event: SessionEvent) =>
    deps.eventBus ? deps.eventBus.publish(event) : Promise.resolve();

  const catalog = createSessionCatalogService({
    store: deps.store,
    fs: deps.fs,
    catalogPath: deps.catalogPath,
    clock: deps.clock,
    ...(deps.eventBus !== undefined ? { eventBus: deps.eventBus } : {}),
  });

  // Ensure the workspace has a symlink to the global catalog. Idempotent: a
  // workspace that already has the link (re-adopted workdir, prior run) is
  // left untouched. Returns the link path, or null when it was already there.
  async function ensureCatalogSymlink(
    workdir: AbsolutePath,
  ): Promise<AbsolutePath | null> {
    const link = asAbsolutePath(`${workdir}/session-catalog.json`);
    if (await deps.fs.exists(link)) return null;
    await deps.fs.symlink(deps.catalogPath, link);
    return link;
  }
  const genId = deps.idFactory ?? (() => "sess_" + Math.random().toString(36).slice(2, 10));

  async function create(input: CreateInput): Promise<{ session: Session }> {
    if (!NAME_RE.test(input.name)) {
      throw new UserError("名称仅限小写字母 a-z、数字 0-9、下划线 _ 和连字符 -，首字符为字母或数字，最多 40 字符");
    }
    const existing = await deps.store.findSessionByName(input.name);
    if (existing) {
      throw new UserError(`名称已存在：${input.name}`);
    }

    const useExistingWorkdir = Boolean(input.workdir);
    const workdir = input.workdir ?? asAbsolutePath(`${deps.workspaceRoot}/${input.name}`);
    const rollback: Array<() => Promise<void>> = [];
    const runRollback = async () => {
      for (const step of rollback.reverse()) {
        try {
          await step();
        } catch {
          // keep going
        }
      }
    };

    try {
      if (useExistingWorkdir) {
        // Existing workdir: must already exist
        if (!(await deps.fs.exists(workdir))) {
          throw new UserError(`工作目录不存在：${workdir}`);
        }
      } else {
        // New workdir: create and scaffold
        if (await deps.fs.exists(workdir)) {
          throw new UserError(`工作目录已存在：${workdir}`);
        }
        await deps.fs.mkdir(workdir);
        rollback.push(() => deps.fs.rmrf(workdir));
        await deps.fs.gitInit(workdir);
        const gitignoreTarget = asAbsolutePath(`${workdir}/.gitignore`);
        await deps.fs.copyFile(deps.gitignorePath, gitignoreTarget);
        await deps.fs.gitCommit(workdir, `init: scaffold session ${input.name}`, [
          gitignoreTarget,
        ]);
      }

      // Step 8: createGroup — pattern: `{prefix}-{name}-{backend}` (prefix = trimmed --chat-name)
      const chatNamePrefix = input.chatName?.trim();
      const groupName = chatNamePrefix
        ? `${chatNamePrefix}-${input.name}-${input.backend}`
        : `${input.name}-${input.backend}`;
      const groupId = await deps.lark.createGroup({
        name: groupName,
        ownerUserId: deps.ownerUserId,
      });
      rollback.push(() => deps.lark.dissolveGroup(groupId));

      // Step 9: inviteUser
      await deps.lark.inviteUser(groupId, deps.ownerUserId);

      // Step 10: createSessionWithBinding
      // FP v1.0 contract §4 chat_name option (a): chatName is no longer
      // persisted. chatNamePrefix above is the only consumer (group naming).
      const { session } = await deps.store.createSessionWithBinding(
        {
          id: asSessionId(genId()),
          name: input.name,
          scope: "user",
          backend: input.backend,
          model: input.model ?? null,
          workdir,
          purpose: input.purpose,
          createdAt: deps.clock.now(),
        },
        groupId
      );

      // Past the rollback cliff — no more rollback from here.
      await emit({ kind: "session_created", session });

      // Steps 12-12c: only for new workdirs (existing workdirs already have these files)
      if (!useExistingWorkdir) {
        try {
          const link = await ensureCatalogSymlink(workdir);
          if (link) {
            await deps.fs.gitCommit(workdir, `catalog: link for ${input.name}`, [link]);
          }
        } catch (err) {
          await deps.lark.sendMessage(
            groupId,
            `⚠ session-catalog symlink 失败：${errorMessage(err)}`,
          );
        }

        try {
          const principleLinks: AbsolutePath[] = [];
          for (const file of PRINCIPLES_FILES) {
            const link = asAbsolutePath(`${workdir}/${file}`);
            await deps.fs.symlink(
              asAbsolutePath(`${deps.principlesTemplatesDir}/${file}`),
              link,
            );
            principleLinks.push(link);
          }
          await deps.fs.gitCommit(workdir, `principles: link for ${input.name}`, principleLinks);
        } catch (err) {
          await deps.lark.sendMessage(
            groupId,
            `⚠ principles symlink 失败：${errorMessage(err)}`,
          );
        }

        try {
          const sopDir = asAbsolutePath(`${workdir}/sop`);
          const sopIndex = asAbsolutePath(`${sopDir}/INDEX.md`);
          const sopTemplate = asAbsolutePath(`${sopDir}/TEMPLATE.md`);
          await deps.fs.mkdir(sopDir);
          await deps.fs.writeFile(
            sopIndex,
            `# SOP Index\n\n| SOP | Description |\n|-----|-------------|\n| (none yet) | |\n`,
          );
          // SOP template lives under workspaceRoot/first-principle/templates/,
          // matching bootstrap.ts's principlesTemplatesDir layout. The earlier
          // `${SM_RUNTIME_ROOT ?? workspaceRoot}/workspaces/...` formula
          // produced dangling `workspaces/workspaces/...` symlinks whenever
          // SM_RUNTIME_ROOT was unset (the common case in production).
          await deps.fs.symlink(
            asAbsolutePath(`${deps.workspaceRoot}/first-principle/templates/sop-template.md`),
            sopTemplate,
          );
          await deps.fs.gitCommit(workdir, `sop: init directory for ${input.name}`, [
            sopIndex,
            sopTemplate,
          ]);
        } catch (err) {
          await deps.lark.sendMessage(
            groupId,
            `⚠ SOP 目录初始化失败：${errorMessage(err)}`,
          );
        }
      }

      if (!useExistingWorkdir) {
        try {
          const agentMdPaths: AbsolutePath[] = [];
          for (const [tplPath, filename] of [
            [deps.claudeMdTemplatePath, "CLAUDE.md"],
            [deps.agentsMdTemplatePath, "AGENTS.md"],
          ] as const) {
            const tpl = await deps.fs.readFile(tplPath);
            const target = asAbsolutePath(`${workdir}/${filename}`);
            await deps.fs.writeFile(target, tpl.replace(/\{\{name\}\}/gu, input.name));
            agentMdPaths.push(target);
          }
          await deps.fs.gitCommit(
            workdir,
            `agent-md: add CLAUDE.md + AGENTS.md for ${input.name}`,
            agentMdPaths,
          );
        } catch (err) {
          await deps.lark.sendMessage(
            groupId,
            `⚠ CLAUDE.md/AGENTS.md 写入失败：${errorMessage(err)}`,
          );
        }
      }

      // Step 13: an adopted (pre-existing) workdir skips the scaffold blocks
      // above, but still needs the catalog symlink so the session can read
      // the fleet directory. No commit — we never inject into a repo we don't
      // own. A workdir that already has the link is left untouched.
      if (useExistingWorkdir) {
        try {
          await ensureCatalogSymlink(workdir);
        } catch (err) {
          await deps.lark.sendMessage(
            groupId,
            `⚠ session-catalog symlink 失败：${errorMessage(err)}`,
          );
        }
      }

      // Step 14: flip status from 'initializing' to 'idle' — session is ready
      // to accept prompts from its bound user group.
      await deps.store.updateSessionStatus(session.id, "idle", deps.clock.now());
      await emit({
        kind: "session_status_changed",
        sessionId: session.id,
        from: "initializing",
        to: "idle",
      });
      const ready: Session = { ...session, status: "idle" };

      // Step 15: regenerate the global catalog so the new session appears.
      // Done after the status flip so the catalog records 'idle', not the
      // transient 'initializing'. One JSON write replaces the old per-sibling
      // catalog regenerated.
      try {
        await catalog.regenerateCatalog(`new session: ${input.name}`);
      } catch (err) {
        await deps.lark.sendMessage(
          groupId,
          `⚠ 已创建 ${input.name}，但 session-catalog 重新生成失败：${errorMessage(err)}`,
        );
      }

      syncSessionTableToLark();

      return { session: ready };
    } catch (err) {
      await runRollback();
      if (err instanceof UserError) throw err;
      throw new SystemError(errorMessage(err, "create failed"), err);
    }
  }

  async function remove(input: { name: string }): Promise<void> {
    const session = await deps.store.findSessionByName(input.name);
    if (!session) throw new UserError(`session 不存在：${input.name}`);
    if (session.status === "busy") {
      throw new UserError("session 正在运行，请等待完成或先 /cancel");
    }
    const binding = await deps.store.findBySession(session.id);
    if (binding) {
      try {
        await deps.lark.dissolveGroup(binding.groupId);
      } catch {
        // log-only in real impl; continue forward-biased
      }
    }
    await deps.store.deleteSessionAndBinding(session.id);
    await emit({ kind: "session_deleted", sessionId: session.id });
    await catalog.regenerateCatalog(`session removed: ${input.name}`);

    syncSessionTableToLark();
  }

  async function clearSessionContext(sessionName: string): Promise<void> {
    const session = await deps.store.findSessionByName(sessionName);
    if (!session) throw new UserError(`session 不存在：${sessionName}`);
    const prev = session.status;
    await deps.store.updateSessionBackendSessionId(session.id, null);
    await deps.store.updateSessionStatus(session.id, "idle", deps.clock.now());
    if (prev !== "idle") {
      await emit({
        kind: "session_status_changed",
        sessionId: session.id,
        from: prev,
        to: "idle",
      });
    }
  }

  async function reset(input: { name: string }): Promise<void> {
    const session = await deps.store.findSessionByName(input.name);
    if (!session) throw new UserError(`session 不存在：${input.name}`);
    if (session.status === "busy") {
      throw new UserError("session 正在运行，请等待完成或先 /cancel");
    }
    await clearSessionContext(input.name);
  }

  async function restart(input: { name: string }): Promise<void> {
    const session = await deps.store.findSessionByName(input.name);
    if (!session) throw new UserError(`session 不存在：${input.name}`);
    if (session.status === "busy" && deps.cancelBackend) {
      await deps.cancelBackend(session.id);
    }
    await clearSessionContext(input.name);
  }

  return {
    create,
    delete: remove,
    reset,
    restart,
    regenerateCatalog: async (reason: string): Promise<void> => {
      await catalog.regenerateCatalog(reason);
    },
  };
}
