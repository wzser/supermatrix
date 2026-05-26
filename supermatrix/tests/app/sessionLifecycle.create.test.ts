import { describe, expect, test } from "vitest";
import { createSessionLifecycle } from "../../src/app/sessionLifecycle.ts";
import { asAbsolutePath, asTimestamp } from "../../src/domain/ids.ts";
import { UserError } from "../../src/domain/errors.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeWorkspaceFs } from "../fakes/fakeWorkspaceFs.ts";

function mkDeps(overrides: { failCreateGroup?: boolean; idFactory?: () => string } = {}) {
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
  });
  return { store, fs, lark, eventBus, lifecycle };
}

describe("sessionLifecycle.create", () => {
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
});
