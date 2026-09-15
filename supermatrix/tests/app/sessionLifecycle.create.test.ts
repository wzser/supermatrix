import { describe, expect, test } from "vitest";
import {
  createSessionLifecycle,
  type SessionTableSyncMode,
} from "../../src/app/sessionLifecycle.ts";
import type { SessionRuntimeSettingsSyncResult } from "../../src/app/sessionRuntimeSettings.ts";
import { asAbsolutePath, asTimestamp } from "../../src/domain/ids.ts";
import { UserError } from "../../src/domain/errors.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeWorkspaceFs } from "../fakes/fakeWorkspaceFs.ts";

function mkDeps(overrides: {
  failCreateGroup?: boolean;
  idFactory?: () => string;
  requestSessionTableSync?: (
    mode?: SessionTableSyncMode,
    sessionNames?: readonly string[],
  ) => void | Promise<SessionRuntimeSettingsSyncResult>;
  provisioningRoot?: string;
  assertProvisioningRootReady?: () => Promise<void>;
} = {}) {
  const store = createFakeBindingStore();
  const fs = createFakeWorkspaceFs({
    "/tpl/gitignore.default": "node_modules\n",
    "/tpl/claude-md-base.md": "# {{name}}\n\ntest claude md\n",
    "/tpl/agents-md-base.md": "# {{name}}\n\ntest agents md\n",
  });
  const lark = createFakeLarkGateway({ ...overrides });
  const eventBus = createFakeEventBus();
  const clock = { now: () => asTimestamp(1_700_000_000_000) };
  const lifecycle = createSessionLifecycle({
    store,
    fs,
    lark,
    clock,
    workspaceRoot: asAbsolutePath("/ws"),
    catalogPath: asAbsolutePath("/ws/session-catalog.json"),
    principlesTemplatesDir: asAbsolutePath("/ws/first-principle/templates"),
    claudeMdTemplatePath: asAbsolutePath("/tpl/claude-md-base.md"),
    agentsMdTemplatePath: asAbsolutePath("/tpl/agents-md-base.md"),
    gitignorePath: asAbsolutePath("/tpl/gitignore.default"),
    ownerUserId: "u-owner",
    idFactory: overrides.idFactory ?? (() => "sess_test"),
    eventBus,
    requestSessionTableSync: overrides.requestSessionTableSync ?? (() => {}),
    // Both are optional deps: omitted entirely unless a test opts in, so the
    // default fixture keeps exercising the legacy single-root path.
    ...(overrides.provisioningRoot !== undefined
      ? { provisioningRoot: asAbsolutePath(overrides.provisioningRoot) }
      : {}),
    ...(overrides.assertProvisioningRootReady !== undefined
      ? { assertProvisioningRootReady: overrides.assertProvisioningRootReady }
      : {}),
  });
  return { store, fs, lark, eventBus, lifecycle };
}

describe("sessionLifecycle.create", () => {
  test("preserves a failed backend sync outcome when its error is undefined", async () => {
    const modes: SessionTableSyncMode[] = [];
    const { lifecycle } = mkDeps({
      requestSessionTableSync: async (mode = "full") => {
        modes.push(mode);
        return { ok: false, error: undefined };
      },
    });

    await expect(lifecycle.syncSessionTable("backend-switch")).resolves.toEqual({
      ok: false,
      error: undefined,
    });
    expect(modes).toEqual([
      "runtime-settings-push-current",
      "runtime-settings-normalize-main-defaults",
      "runtime-settings-pull",
    ]);
  });

  test("successful create requests scoped push-current for the created session", async () => {
    const requests: Array<{
      mode: SessionTableSyncMode | undefined;
      sessionNames: readonly string[] | undefined;
    }> = [];
    const { lifecycle } = mkDeps({
      requestSessionTableSync: (mode, sessionNames) => {
        requests.push({ mode, sessionNames });
      },
    });

    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });

    expect(requests).toEqual([
      { mode: "scoped-push-current", sessionNames: ["foo"] },
    ]);
  });

  test("does not return from create before the session-table sync receipt", async () => {
    let release!: () => void;
    const syncFinished = new Promise<void>((resolve) => { release = resolve; });
    let syncCalls = 0;
    const { lifecycle } = mkDeps({
      requestSessionTableSync: async () => {
        syncCalls += 1;
        await syncFinished;
        return { ok: true };
      },
    });
    let created = false;
    const pending = lifecycle.create({ backend: "codex", name: "awaited", purpose: "" }).then(() => { created = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncCalls).toBe(1);
    expect(created).toBe(false);
    release();
    await pending;
    expect(created).toBe(true);
  });

  test("happy path writes workdir, creates group, records session + binding, links catalog", async () => {
    const { store, fs, lark, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    expect(session.name).toBe("foo");
    expect(fs.dirs.has("/ws/foo")).toBe(true);
    // CONSTITUTION.md is retired — no per-session file is written anymore.
    expect(fs.files.has("/ws/foo/CONSTITUTION.md")).toBe(false);
    // The workspace reaches the global catalog through a symlink.
    expect(fs.symlinks.get("/ws/foo/session-catalog.json")).toBe("/ws/session-catalog.json");
    expect(lark.createdGroups).toHaveLength(1);
    expect(await store.findSessionByName("foo")).toBeTruthy();
  });

  test("feishu group name includes backend suffix", async () => {
    const { lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "my-app", purpose: "" });
    expect(lark.createdGroupNames[0]).toBe("my-app-claude");
  });

  test("feishu group name uses codex suffix for codex backend", async () => {
    const { lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "codex", name: "my-app", purpose: "" });
    expect(lark.createdGroupNames[0]).toBe("my-app-codex");
  });

  test("chatName is used as prefix in `{prefix}-{name}-{backend}` group name", async () => {
    const { lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "", chatName: "自定义群名" });
    expect(lark.createdGroupNames[0]).toBe("自定义群名-foo-claude");
  });

  test("blank chatName falls back to default naming", async () => {
    const { lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "", chatName: "   " });
    expect(lark.createdGroupNames[0]).toBe("foo-claude");
  });

  test("happy path creates principles symlinks and commits them", async () => {
    const { fs, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "bar", purpose: "" });
    const expected = [
      "/ws/bar/console-principles.md",
      "/ws/bar/coding-principles.md",
      "/ws/bar/business-principles.md",
    ];
    for (const link of expected) {
      expect(fs.symlinks.has(link)).toBe(true);
      expect(fs.symlinks.get(link)).toBe(
        `/ws/first-principle/templates/${link.split("/").pop()}`
      );
    }
    const principlesCommit = fs.commits.find(
      (c) => c.message === "principles: link for bar"
    );
    expect(principlesCommit).toBeTruthy();
    expect(principlesCommit!.workdir).toBe("/ws/bar");
  });

  test("happy path regenerates the global catalog including the new session", async () => {
    const { fs, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "do foo things" });
    const raw = fs.files.get("/ws/session-catalog.json");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as {
      sessions: Array<{ name: string; status: string; capability: string }>;
    };
    const foo = parsed.sessions.find((s) => s.name === "foo");
    expect(foo).toBeTruthy();
    // Catalog is regenerated after the status flip — the new session shows
    // up as idle, not as the transient initializing state.
    expect(foo!.status).toBe("idle");
    expect(foo!.capability).toBe("do foo things");
  });

  test("create publishes session_created, session_status_changed and catalog_updated events", async () => {
    const { eventBus, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "evt", purpose: "" });

    const kinds = eventBus.published.map((e) => e.kind);
    expect(kinds).toContain("session_created");
    expect(kinds).toContain("session_status_changed");
    expect(kinds).toContain("catalog_updated");

    const created = eventBus.published.find((e) => e.kind === "session_created");
    expect(created!.kind === "session_created" && created!.session.name).toBe("evt");

    const statusChanged = eventBus.published.find((e) => e.kind === "session_status_changed");
    expect(
      statusChanged!.kind === "session_status_changed" &&
        statusChanged!.from === "initializing" &&
        statusChanged!.to === "idle"
    ).toBe(true);
  });

  test("invalid name throws UserError and touches nothing", async () => {
    const { fs, lark, lifecycle } = mkDeps();
    await expect(lifecycle.create({ backend: "claude", name: "FOO!", purpose: "" })).rejects.toThrow(UserError);
    expect(fs.dirs.size).toBe(0);
    expect(lark.createdGroups).toHaveLength(0);
  });

  test("duplicate name rejects and does not create workdir", async () => {
    const { fs, lark, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    const before = fs.dirs.size;
    await expect(lifecycle.create({ backend: "claude", name: "foo", purpose: "" })).rejects.toThrow(UserError);
    expect(fs.dirs.size).toBe(before);
    expect(lark.createdGroups).toHaveLength(1);
  });

  test("createGroup failure rolls back workdir creation", async () => {
    const { store, fs, lark, lifecycle } = mkDeps({ failCreateGroup: true });
    await expect(lifecycle.create({ backend: "claude", name: "foo", purpose: "" })).rejects.toThrow();
    expect(fs.dirs.has("/ws/foo")).toBe(false);
    expect(lark.createdGroups).toHaveLength(0);
    expect(await store.findSessionByName("foo")).toBeNull();
  });

  test("gitCommit calls only stage framework-written paths (never `git add -A`)", async () => {
    // Regression for the deepsearch sibling-rerender failure: every
    // housekeeping commit must enumerate the exact files it touched, so a
    // stray nested repo in the workdir can't get swept in.
    const { fs, lifecycle } = mkDeps();
    await lifecycle.create({ backend: "claude", name: "foo", purpose: "" });
    expect(fs.commits.length).toBeGreaterThan(0);
    for (const c of fs.commits) {
      // Empty paths are allowed (an `--allow-empty` no-op sync), but every
      // path that is staged must live under that commit's workdir.
      for (const p of c.paths) {
        expect(p.startsWith(c.workdir + "/")).toBe(true);
      }
    }
    const initCommit = fs.commits.find((c) => c.message.startsWith("init: scaffold"));
    expect(initCommit?.paths).toEqual(["/ws/foo/.gitignore"]);
    const principlesCommit = fs.commits.find((c) => c.message.startsWith("principles: link"));
    expect(principlesCommit?.paths).toEqual([
      "/ws/foo/console-principles.md",
      "/ws/foo/coding-principles.md",
      "/ws/foo/business-principles.md",
    ]);
    const catalogCommit = fs.commits.find((c) => c.message.startsWith("catalog: link"));
    expect(catalogCommit?.paths).toEqual(["/ws/foo/session-catalog.json"]);
    const sopCommit = fs.commits.find((c) => c.message.startsWith("sop: init directory"));
    expect(sopCommit?.paths).toEqual([
      "/ws/foo/sop/INDEX.md",
      "/ws/foo/sop/TEMPLATE.md",
    ]);
    const agentMdCommit = fs.commits.find((c) => c.message.startsWith("agent-md:"));
    expect(agentMdCommit?.paths).toEqual([
      "/ws/foo/CLAUDE.md",
      "/ws/foo/AGENTS.md",
    ]);
  });

  test("provisions new workspace on provisioning root with legacy-root symlink", async () => {
    const { store, fs, lifecycle } = mkDeps({ provisioningRoot: "/smc" });
    const { session } = await lifecycle.create({
      backend: "claude",
      name: "foo",
      purpose: "",
    });

    // Entity lives on the provisioning root; the legacy root only gets a link.
    // (The fake's gitInit also registers the workdir in `dirs`, so `dirs` says
    // nothing about /ws/foo here — the symlink map is the real evidence.)
    expect(fs.dirs.has("/smc/foo")).toBe(true);
    expect(fs.symlinks.get("/ws/foo")).toBe("/smc/foo");
    // What lands in the DB is still the legacy-root path.
    expect(session.workdir).toBe("/ws/foo");
    expect((await store.findSessionByName("foo"))!.workdir).toBe("/ws/foo");
    // Scaffold keeps using the legacy path, so the catalog link is unchanged.
    expect(fs.symlinks.get("/ws/foo/session-catalog.json")).toBe(
      "/ws/session-catalog.json",
    );
  });

  test("rejects a dangling symlink occupying the legacy-root path before mkdir or group creation", async () => {
    const { fs, lark, lifecycle } = mkDeps({ provisioningRoot: "/smc" });
    fs.symlinks.set("/ws/foo", "/missing/legacy-target");

    await expect(
      lifecycle.create({ backend: "claude", name: "foo", purpose: "" }),
    ).rejects.toThrow(new UserError("工作目录已存在：/ws/foo"));

    expect(fs.symlinks.get("/ws/foo")).toBe("/missing/legacy-target");
    expect(fs.dirs.has("/smc/foo")).toBe(false);
    expect(lark.createdGroups).toHaveLength(0);
  });

  test("rejects a dangling symlink occupying the physical path before mkdir or group creation", async () => {
    const { fs, lark, lifecycle } = mkDeps({ provisioningRoot: "/smc" });
    fs.symlinks.set("/smc/foo", "/missing/physical-target");

    await expect(
      lifecycle.create({ backend: "claude", name: "foo", purpose: "" }),
    ).rejects.toThrow(new UserError("工作目录已存在：/smc/foo"));

    expect(fs.symlinks.get("/smc/foo")).toBe("/missing/physical-target");
    expect(fs.dirs.has("/smc/foo")).toBe(false);
    expect(fs.symlinks.has("/ws/foo")).toBe(false);
    expect(lark.createdGroups).toHaveLength(0);
  });

  test("aborts before mkdir and group creation when provisioning root is not ready", async () => {
    const { store, fs, lark, lifecycle } = mkDeps({
      provisioningRoot: "/smc",
      assertProvisioningRootReady: async () => {
        throw new UserError("SMC 卷未挂载");
      },
    });
    const dirsBefore = fs.dirs.size;

    await expect(
      lifecycle.create({ backend: "claude", name: "foo", purpose: "" }),
    ).rejects.toThrow(UserError);

    expect(fs.dirs.size).toBe(dirsBefore);
    expect(fs.symlinks.size).toBe(0);
    expect(lark.createdGroups).toHaveLength(0);
    expect(await store.findSessionByName("foo")).toBeNull();
  });

  test("rollback removes both the legacy-root symlink and the physical directory", async () => {
    const { fs, lifecycle } = mkDeps({
      provisioningRoot: "/smc",
      failCreateGroup: true,
    });

    await expect(
      lifecycle.create({ backend: "claude", name: "foo", purpose: "" }),
    ).rejects.toThrow();

    expect(fs.dirs.has("/smc/foo")).toBe(false);
    expect(fs.symlinks.has("/ws/foo")).toBe(false);
  });

  test("keeps the legacy single-root path when provisioningRoot is not configured", async () => {
    const { fs, lifecycle } = mkDeps();
    const { session } = await lifecycle.create({
      backend: "claude",
      name: "foo",
      purpose: "",
    });

    expect(fs.dirs.has("/ws/foo")).toBe(true);
    expect(session.workdir).toBe("/ws/foo");
    // No legacy-root link and nothing on any provisioning root. (`symlinks` as
    // a whole is non-empty here — the scaffold always links the catalog and
    // the principles files — so the assertion has to be scoped to /ws/foo.)
    expect(fs.symlinks.has("/ws/foo")).toBe(false);
    expect([...fs.dirs].some((d) => !d.startsWith("/ws/"))).toBe(false);
  });
});
