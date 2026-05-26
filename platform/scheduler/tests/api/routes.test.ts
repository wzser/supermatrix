import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createCronEngine } from "../../src/cron/engine.js";
import { createApp } from "../../src/api/routes.js";
import { createTestKnownSessionsLoader } from "../helpers/testKnownSessions.js";
import { createCreationReviewStore } from "../../src/review/creationReviewStore.js";

describe("API Routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;
  let engine: ReturnType<typeof createCronEngine>;
  let store: ReturnType<typeof createTaskStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createTaskStore(db);
    engine = createCronEngine();
    app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
  });

  afterEach(() => {
    engine.stopAll();
    db.close();
  });

  describe("POST /tasks", () => {
    it("creates a task", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "fetch-mail",
          description: "中文描述：测试用例 — 创建一个基本的 shell 任务",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("fetch-mail");
      expect(body.id).toBeDefined();
    });

    it("rejects invalid input", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid cron expression", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-cron",
          cron: "not a valid cron",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        }),
      });
      expect(res.status).toBe(400);

      const listRes = await app.request("/tasks");
      const tasks = await listRes.json();
      expect(tasks).toHaveLength(0);
    });

    it("rejects shell task with missing command", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-shell",
          cron: "0 9 * * *",
          executor: "shell",
          config: { url: "http://example.com", timeout: 5000 },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects http task with missing url", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-http",
          cron: "0 9 * * *",
          executor: "http",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects class without expectedDurationMs", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-task-no-duration",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("expectedDurationMs");
    });

    it("rejects invalid class enum", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-class",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "not_a_real_class",
          expectedDurationMs: 60000,
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects POST missing category, hint mentions category enum", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "no-category",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          expectedDurationMs: 60000,
          ownerSession: "tester",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; hint?: string };
      expect(body.hint).toBeDefined();
      expect(body.hint).toContain("category");
      expect(body.hint).toContain("数据采集");
    });

    it("zod failures return structured errors[] (uniform 400 shape)", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; errors?: Array<{ code: string; field: string }> };
      expect(body.errors).toBeDefined();
      expect(body.errors!.length).toBeGreaterThan(0);
      expect(body.errors!.every((e) => e.code === "schema_invalid")).toBe(true);
    });

    it("rejects invalid category enum", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-category",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "不存在的分类",
          expectedDurationMs: 60000,
          ownerSession: "tester",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects override violating hard constraint", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-monitoring-override",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "数据采集",
          expectedDurationMs: 60000,
          ownerSession: "tester",
          overrides: { notify: { receipt_missing: { channel: "ownerDM" } } },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("monitoring");
    });

    it("accepts valid new-class task", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "valid-monitoring",
          description: "中文描述：测试用例 — 接受合法的 monitoring 类任务",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "数据采集",
          expectedDurationMs: 300000,
          ownerSession: "tester",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { class: string; expectedDurationMs: number };
      expect(body.class).toBe("monitoring");
      expect(body.expectedDurationMs).toBe(300000);
    });

    it("rejects legacy task without class (Plan 5 lockout)", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "legacy-task",
          cron: "0 * * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("lint rejects unknown ownerSession with structured errors[]", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "lint-owner-fail",
          description: "中文描述：检验 ownerSession 校验",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "ghost-session",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors?: Array<{ code: string }> };
      expect(body.errors).toBeDefined();
      expect(body.errors!.some((e) => e.code === "owner_unknown")).toBe(true);
    });

    it("lint rejects English-only description", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "lint-desc-fail",
          description: "English only",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors?: Array<{ code: string }> };
      expect(body.errors!.some((e) => e.code === "description_no_chinese")).toBe(true);
    });
  });

  describe("GET /tasks", () => {
    it("lists all tasks", async () => {
      await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — GET /tasks 列表查询",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });

      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
    });
  });

  describe("GET /tasks/:id", () => {
    it("returns a task by id", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — GET /tasks/:id 按 id 查询",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("t1");
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request("/tasks/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /tasks/:id", () => {
    it("updates a task", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — PATCH 更新 cron",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "0 10 * * *" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cron).toBe("0 10 * * *");
    });

    it("rejects invalid cron and preserves existing data", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — 非法 PATCH cron 不应破坏已存数据",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const patchRes = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "not a valid cron" }),
      });
      expect(patchRes.status).toBe(400);

      const getRes = await app.request(`/tasks/${id}`);
      const task = await getRes.json();
      expect(task.cron).toBe("0 9 * * *");
    });

    it("rejects PATCH http config missing timeout", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "patch-validate-http",
          description: "中文描述：测试用例 — PATCH http 配置缺 timeout 应被拒",
          cron: "0 9 * * *",
          executor: "http",
          config: { url: "http://example.com", method: "POST", timeout: 5000 },
          class: "notification", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "跨会话委派",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { url: "http://example.com", method: "POST" } }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/config.*http/i);

      const getRes = await app.request(`/tasks/${id}`);
      const task = await getRes.json();
      expect(task.config.timeout).toBe(5000);
    });

    it("rejects PATCH that switches executor leaving config in wrong shape", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "patch-switch-executor",
          description: "中文描述：测试用例 — PATCH 切换 executor 但 config 形状错应被拒",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executor: "http" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts PATCH http config with all required fields", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "patch-validate-http-ok",
          description: "中文描述：测试用例 — PATCH http 配置字段齐全应通过",
          cron: "0 9 * * *",
          executor: "http",
          config: { url: "http://example.com", method: "POST", timeout: 5000 },
          class: "notification", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "跨会话委派",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { url: "http://other.com", method: "GET", timeout: 9000 } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.timeout).toBe(9000);
    });

    it("updates ownerSession (recovery path for unreachable-owner REJECT)", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "owner-fix-test",
          description: "中文描述：测试用例 — PATCH 修复 ownerSession（unreachable-owner 恢复路径）",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "stale-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerSession: "new-valid-owner" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ownerSession).toBe("new-valid-owner");
    });
  });

  describe("PATCH /tasks/:id — lint + hardConstraints on merged result", () => {
    async function createValidTask() {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "patch-base",
          description: "中文描述：基础任务用于 PATCH 测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      return body.id as string;
    }

    it("rejects PATCH that empties description (lint)", async () => {
      const id = await createValidTask();
      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors?: Array<{ code: string }> };
      expect(body.errors!.some((e) => e.code === "description_empty")).toBe(true);
    });

    it("rejects PATCH that introduces kind_executor_mismatch (lint)", async () => {
      const id = await createValidTask();
      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executor: "http",
          config: { url: "http://x", method: "POST", timeout: 5000 },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { errors?: Array<{ code: string }> };
      expect(body.errors!.some((e) => e.code === "kind_executor_mismatch")).toBe(true);
    });

    it("rejects PATCH that violates hardConstraints (delegation + exit_zero), with structured errors[]", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "patch-delegation",
          description: "中文描述：delegation PATCH 测试",
          cron: "0 9 * * *",
          executor: "http",
          config: {
            url: "http://x", method: "POST", timeout: 30000,
            body: { target: "test-owner", prompt: "do X, reply REPORT:" },
          },
          class: "delegation",
          category: "跨会话委派",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      const id = (await createRes.json() as { id: string }).id;

      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: { receiptProof: { kind: "exit_zero" } },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string; errors?: Array<{ code: string }> };
      expect(body.errors).toBeDefined();
      expect(body.errors!.some((e) => e.code === "hard_constraint_violation")).toBe(true);
      expect(body.error).toMatch(/delegation/);
    });

    it("accepts PATCH that keeps everything valid", async () => {
      const id = await createValidTask();
      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "中文描述：更新后的内容" }),
      });
      expect(res.status).toBe(200);
    });

    it("skips lint when merged result has no class (legacy task PATCH not promoting to classed)", async () => {
      // 直接往 store 里写一个 legacy task (没经过 POST /tasks)，模拟旧 fleet 残留
      const legacy = store.createTask({
        name: "legacy-task",
        description: "",
        cron: "0 9 * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        // class 故意不传：legacy
      } as any);
      const res = await app.request(`/tasks/${legacy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "30 9 * * *" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /tasks/:id", () => {
    it("deletes a task", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — DELETE /tasks/:id 删除任务",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}`, { method: "DELETE" });
      expect(res.status).toBe(204);

      const getRes = await app.request(`/tasks/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe("POST /tasks/:id/run", () => {
    it("returns 202 for manual trigger", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — 手动触发返回 202",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo manual", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}/run`, { method: "POST" });
      expect(res.status).toBe(202);
    });
  });

  describe("GET /tasks/:id/runs", () => {
    it("rejects NaN limit", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — runs 查询 limit=abc 应被拒",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}/runs?limit=abc`);
      expect(res.status).toBe(400);
    });

    it("rejects negative limit", async () => {
      const createRes = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "t1",
          description: "中文描述：测试用例 — runs 查询 limit=-1 应被拒",
          cron: "0 9 * * *", executor: "shell",
          config: { command: "echo 1", cwd: "/tmp", timeout: 5000 },
          class: "monitoring", expectedDurationMs: 60_000, ownerSession: "test-owner",
          category: "业务巡检",
        }),
      });
      const { id } = await createRes.json();

      const res = await app.request(`/tasks/${id}/runs?limit=-1`);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /runs/recent", () => {
    it("rejects NaN limit", async () => {
      const res = await app.request("/runs/recent?limit=abc");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /health", () => {
    it("returns health status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  describe("POST/PATCH writes creation_review record", () => {
    let reviewStore: import("../../src/review/creationReviewStore.js").CreationReviewStore;
    let app2: ReturnType<typeof createApp>;

    beforeEach(() => {
      reviewStore = createCreationReviewStore(db);
      app2 = createApp(
        store, engine,
        undefined, undefined, undefined, undefined, undefined,
        createTestKnownSessionsLoader(),
        reviewStore,
      );
    });

    it("POST classed task writes a pending review record", async () => {
      const res = await app2.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "review-post-1",
          description: "中文描述：review 写入测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      expect(res.status).toBe(201);
      const task = await res.json();
      const pending = reviewStore.listPending();
      expect(pending.length).toBe(1);
      expect(pending[0].taskId).toBe(task.id);
      expect(pending[0].trigger).toBe("post_create");
      expect(pending[0].taskSnapshot.name).toBe("review-post-1");
    });

    it("PATCH classed task writes a post_patch review record", async () => {
      const createRes = await app2.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "review-patch-1",
          description: "中文描述：PATCH review 测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      const { id } = await createRes.json();
      const before = reviewStore.listPending().length;

      const patchRes = await app2.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "中文描述：PATCH 后" }),
      });
      expect(patchRes.status).toBe(200);
      const after = reviewStore.listPending();
      expect(after.length).toBe(before + 1);
      const latest = after[after.length - 1];
      expect(latest.taskId).toBe(id);
      expect(latest.trigger).toBe("post_patch");
    });

    it("POST without class (legacy) does NOT write review", async () => {
      // Direct store insert simulating legacy unclassed task
      // (a real legacy POST would have been rejected by current zod, so we use store directly)
      const legacy = store.createTask({
        name: "legacy-no-review",
        description: "",
        cron: "0 9 * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
      } as any);
      const before = reviewStore.listPending().length;
      const res = await app2.request(`/tasks/${legacy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "30 9 * * *" }),
      });
      expect(res.status).toBe(200);
      // legacy (no class) PATCH should not write a review
      expect(reviewStore.listPending().length).toBe(before);
    });

    it("works without injection (review store optional)", async () => {
      // app (the original, no review store injected) should still accept POSTs
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "no-review-store-test",
          description: "中文描述：无 review store 注入",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe("/proposals/creation decision API", () => {
    let reviewStore: import("../../src/review/creationReviewStore.js").CreationReviewStore;
    let app2: ReturnType<typeof createApp>;

    beforeEach(() => {
      reviewStore = createCreationReviewStore(db);
      app2 = createApp(
        store, engine,
        undefined, undefined, undefined, undefined, undefined,
        createTestKnownSessionsLoader(),
        reviewStore,
      );
    });

    async function createReviewedTask() {
      const res = await app2.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "review-target-" + Math.random().toString(36).slice(2),
          description: "中文描述：决议测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "test-owner",
        }),
      });
      const task = await res.json();
      const pending = reviewStore.listPending();
      const review = pending.find(r => r.taskId === task.id)!;
      return { task, review };
    }

    it("GET /proposals/creation lists pending reviews", async () => {
      await createReviewedTask();
      const res = await app2.request("/proposals/creation?status=pending");
      expect(res.status).toBe(200);
      const list = await res.json() as any[];
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].status).toBe("pending");
    });

    it("GET /proposals/creation rejects invalid status", async () => {
      const res = await app2.request("/proposals/creation?status=yolo");
      expect(res.status).toBe(400);
    });

    it("GET /proposals/creation returns 503 when store not wired", async () => {
      const res = await app.request("/proposals/creation");  // original `app` has no review store
      expect(res.status).toBe(503);
    });

    it("POST .../approve marks status", async () => {
      const { review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "looks fine" }),
      });
      expect(res.status).toBe(200);
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("approved");
      expect(got.decisionReason).toBe("looks fine");
    });

    it("POST .../approve 404 on unknown id", async () => {
      const res = await app2.request("/proposals/creation/nonexistent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("POST .../approve 400 on missing reason", async () => {
      const { review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("POST .../approve 400 on already-decided review", async () => {
      const { review } = await createReviewedTask();
      reviewStore.decide(review.id, { status: "approved", reason: "first" });
      const res = await app2.request(`/proposals/creation/${review.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "again" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST .../patch applies PATCH and records decision", async () => {
      const { task, review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "cron too dense, adjusted",
          patch: { cron: "*/30 * * * *" },
        }),
      });
      expect(res.status).toBe(200);
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("patched");
      expect(got.decisionPatch).toEqual({ cron: "*/30 * * * *" });
      const updated = await app2.request(`/tasks/${task.id}`);
      const taskBody = await updated.json();
      expect(taskBody.cron).toBe("*/30 * * * *");
    });

    it("POST .../patch surfaces inner PATCH failure", async () => {
      const { review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "invalid patch",
          patch: { description: "" },  // empty description fails lint
        }),
      });
      expect(res.status).toBe(400);
      // Inner PATCH failed; review should NOT have been marked patched
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("pending");
    });

    it("POST .../reject disables the task by default", async () => {
      const { task, review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "business work in shell" }),
      });
      expect(res.status).toBe(200);
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("rejected");
      const taskRes = await app2.request(`/tasks/${task.id}`);
      const taskBody = await taskRes.json();
      expect(taskBody.enabled).toBe(false);
    });

    it("POST .../reject with disable=false keeps task enabled", async () => {
      const { task, review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "advisory only", disable: false }),
      });
      expect(res.status).toBe(200);
      const taskRes = await app2.request(`/tasks/${task.id}`);
      const taskBody = await taskRes.json();
      expect(taskBody.enabled).toBe(true);
    });

    it("POST .../escalate marks status without modifying task", async () => {
      const { task, review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "need owner confirmation" }),
      });
      expect(res.status).toBe(200);
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("escalated");
      const taskRes = await app2.request(`/tasks/${task.id}`);
      const taskBody = await taskRes.json();
      expect(taskBody.enabled).toBe(true);  // unchanged
    });

    it("POST /escalate sends ownerDM via injected sender", async () => {
      const sender = vi.fn(async () => ({ ok: true }));
      const app3 = createApp(
        store, engine,
        undefined, undefined, undefined, undefined, undefined,
        createTestKnownSessionsLoader(),
        reviewStore,
        sender,
      );
      // create task + review via the app that has the sender wired
      const taskRes = await app3.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "escalate-dm-target-" + Math.random().toString(36).slice(2),
          description: "中文描述：升级 DM 测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "owner-a",
        }),
      });
      expect(taskRes.status).toBe(201);
      const task = await taskRes.json();
      const review = reviewStore.listPending().find(r => r.taskId === task.id)!;
      const res = await app3.request(`/proposals/creation/${review.id}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "need owner confirmation" }),
      });
      expect(res.status).toBe(200);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender.mock.calls[0][0]).toBe("owner-a");
      const prompt = sender.mock.calls[0][1] as string;
      expect(prompt).toContain("creation_review escalated");
      expect(prompt).toContain(task.id);
      expect(prompt).toContain("need owner confirmation");
    });

    it("POST /reject (disable=true) sends ownerDM", async () => {
      const sender = vi.fn(async () => ({ ok: true }));
      const app3 = createApp(
        store, engine,
        undefined, undefined, undefined, undefined, undefined,
        createTestKnownSessionsLoader(),
        reviewStore,
        sender,
      );
      const taskRes = await app3.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "reject-dm-target-" + Math.random().toString(36).slice(2),
          description: "中文描述：拒绝 DM 测试",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "owner-b",
        }),
      });
      expect(taskRes.status).toBe(201);
      const task = await taskRes.json();
      const review = reviewStore.listPending().find(r => r.taskId === task.id)!;
      const res = await app3.request(`/proposals/creation/${review.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "business work in shell" }),
      });
      expect(res.status).toBe(200);
      expect(sender).toHaveBeenCalledTimes(1);
      expect(sender.mock.calls[0][0]).toBe("owner-b");
      const prompt = sender.mock.calls[0][1] as string;
      expect(prompt).toContain("creation_review rejected");
      expect(prompt).toContain(task.id);
      expect(prompt).toContain("business work in shell");
    });

    it("POST /reject (disable=false) does NOT send ownerDM", async () => {
      const sender = vi.fn(async () => ({ ok: true }));
      const app3 = createApp(
        store, engine,
        undefined, undefined, undefined, undefined, undefined,
        createTestKnownSessionsLoader(),
        reviewStore,
        sender,
      );
      const taskRes = await app3.request("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "reject-nodm-target-" + Math.random().toString(36).slice(2),
          description: "中文描述：拒绝但不停用",
          cron: "0 9 * * *",
          executor: "shell",
          config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
          class: "monitoring",
          category: "业务巡检",
          expectedDurationMs: 60_000,
          ownerSession: "owner-c",
        }),
      });
      expect(taskRes.status).toBe(201);
      const task = await taskRes.json();
      const review = reviewStore.listPending().find(r => r.taskId === task.id)!;
      const res = await app3.request(`/proposals/creation/${review.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "advisory only", disable: false }),
      });
      expect(res.status).toBe(200);
      expect(sender).not.toHaveBeenCalled();
    });

    it("POST /escalate without sender injected does not throw", async () => {
      // app2 has no sender wired
      const { review } = await createReviewedTask();
      const res = await app2.request(`/proposals/creation/${review.id}/escalate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "no sender wired" }),
      });
      expect(res.status).toBe(200);
      const got = reviewStore.get(review.id)!;
      expect(got.status).toBe("escalated");
    });
  });
});

describe("POST /tasks enforces classed-lifecycle fields (Plan 5)", () => {
  it("returns 400 when class is missing", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "legacy-shape",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/class/i);
    db.close();
  });

  it("returns 400 when expectedDurationMs is missing", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-duration",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
        class: "sync_job",
        ownerSession: "owner",
      }),
    });
    expect(res.status).toBe(400);
    db.close();
  });

  it("returns 400 when ownerSession is missing", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-owner",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
        class: "sync_job",
        category: "数据采集",
        expectedDurationMs: 60_000,
      }),
    });
    expect(res.status).toBe(400);
    db.close();
  });

  it("accepts full classed-lifecycle shape (sanity check)", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, undefined, undefined,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "classed-ok",
        description: "中文描述：测试用例 — 完整 classed-lifecycle 必填字段健全",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
        class: "monitoring",
        category: "业务巡检",
        expectedDurationMs: 60_000,
        ownerSession: "owner",
      }),
    });
    expect(res.status).toBe(201);
    db.close();
  });
});
