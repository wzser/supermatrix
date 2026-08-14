import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createWriteLock } from "../../src/api/auth.js";

const TOKEN = "test-admin-token";

function makeApp(adminToken?: string, host = "127.0.0.1") {
  const db = new Database(":memory:");
  applyMigrations(db);
  const store = createTaskStore(db);
  const lock = createWriteLock({ adminToken, host });
  const app = new Hono();
  app.post("/tasks", lock, (c) => c.json({ ok: true, route: "create" }, 201));
  app.patch("/tasks/:id", lock, (c) => c.json({ ok: true, route: "patch" }));
  app.delete("/tasks/:id", lock, (c) => c.json({ ok: true, route: "delete" }));
  app.post("/tasks/:id/run", lock, (c) => c.json({ ok: true, route: "run" }, 202));
  app.get("/tasks", (c) => c.json({ ok: true, route: "list" }));
  return { app, store };
}

function mkOneshot(
  store: ReturnType<typeof createTaskStore>,
  oneshot: boolean,
  type: "script" | "session" = "script",
) {
  return store.createTask({
    name: `t-${Math.random().toString(36).slice(2)}`, description: "", owner: "o",
    createdBy: "", type, config: { command: "echo hi", cwd: "/tmp" },
    cron: "0 9 * * *", enabled: true, oneshot, category: null,
    retryEnabled: false, retryMax: 0, retryDelayMs: 0, alertThreshold: 0, alertChannel: "none",
  } as never);
}

describe("v2 write-lock middleware", () => {
  describe("token not configured → no-op (boot enforces)", () => {
    let ctx: ReturnType<typeof makeApp>;
    beforeEach(() => { ctx = makeApp(undefined); });
    it("POST passes without header", async () => {
      const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oneshot: false }) });
      expect(res.status).toBe(201);
    });
    it("PATCH passes without header", async () => {
      const res = await ctx.app.request("/tasks/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(200);
    });
  });

  describe("token configured", () => {
    let ctx: ReturnType<typeof makeApp>;
    beforeEach(() => { ctx = makeApp(TOKEN); });

    it("valid token unlocks every write", async () => {
      const h = { "content-type": "application/json", "X-Scheduler-Auth": TOKEN };
      expect((await ctx.app.request("/tasks", { method: "POST", headers: h, body: JSON.stringify({ oneshot: false }) })).status).toBe(201);
      expect((await ctx.app.request("/tasks/x", { method: "PATCH", headers: h, body: "{}" })).status).toBe(200);
      expect((await ctx.app.request("/tasks/x", { method: "DELETE", headers: h })).status).toBe(200);
      expect((await ctx.app.request("/tasks/x/run", { method: "POST", headers: h })).status).toBe(202);
    });

    it("wrong token → 403 with locked hint", async () => {
      const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", "X-Scheduler-Auth": "nope" }, body: JSON.stringify({ oneshot: false }) });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("locked");
      expect(body.hint).toContain("spawn2.0");
      expect(body.hint).toContain("oneshot 单次任务仅新建可自助");
    });

    it("length-mismatch token (same prefix, shorter) → 403, no throw", async () => {
      const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json", "X-Scheduler-Auth": TOKEN.slice(0, 4) }, body: JSON.stringify({ oneshot: false }) });
      expect(res.status).toBe(403);
    });

    it("GET stays open without token", async () => {
      expect((await ctx.app.request("/tasks")).status).toBe(200);
    });

    it("POST oneshot:true session is exempt (no token)", async () => {
      const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oneshot: true, type: "session" }) });
      expect(res.status).toBe(201);
    });

    it("POST oneshot:true script is not exempt (no token)", async () => {
      const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oneshot: true, type: "script" }) });
      expect(res.status).toBe(403);
    });

    it("POST oneshot:false / 缺字段 → 403", async () => {
      expect((await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ oneshot: false }) })).status).toBe(403);
      expect((await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    });

    it("DELETE requires an admin token for session and script oneshots, recurring tasks, and missing IDs", async () => {
      const scriptOneshot = mkOneshot(ctx.store, true, "script");
      const sessionOneshot = mkOneshot(ctx.store, true, "session");
      const recurring = mkOneshot(ctx.store, false);
      expect((await ctx.app.request(`/tasks/${scriptOneshot.id}`, { method: "DELETE" })).status).toBe(403);
      expect((await ctx.app.request(`/tasks/${sessionOneshot.id}`, { method: "DELETE" })).status).toBe(403);
      expect((await ctx.app.request(`/tasks/${recurring.id}`, { method: "DELETE" })).status).toBe(403);
      expect((await ctx.app.request(`/tasks/no-such-id`, { method: "DELETE" })).status).toBe(403);
    });

    it("PATCH / run never exempt even on oneshot task", async () => {
      const oneshot = mkOneshot(ctx.store, true);
      expect((await ctx.app.request(`/tasks/${oneshot.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await ctx.app.request(`/tasks/${oneshot.id}/run`, { method: "POST" })).status).toBe(403);
    });
  });
});
