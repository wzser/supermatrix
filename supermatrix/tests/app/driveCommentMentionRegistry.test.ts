import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createFileDriveCommentMentionRegistryLoader,
  deriveDriveCommentMentionPollWatches,
  persistDriveCommentMentionPollSince,
} from "../../src/app/driveCommentMentionRegistry.ts";

describe("createFileDriveCommentMentionRegistryLoader", () => {
  test("loads registry JSON and SOP frontmatter from files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-"));
    try {
      await mkdir(join(dir, "sop"), { recursive: true });
      await writeFile(join(dir, "mention-routes.json"), JSON.stringify({
        version: 1,
        routes: [
          {
            id: "growth-diagnosis",
            enabled: true,
            owner_session: "amzdata",
            delivery: { type: "session", session_name: "amzdata" },
            ingest: { poll: { interval_sec: 120, since: 1_000 } },
            source: {
              file_token: "base_token",
              file_type: "bitable",
              table_id: "tbl_1",
            },
            triggers: [
              {
                id: "update-status",
                priority: 100,
                ingest_modes: ["mention", "poll_unmentioned"],
                record_field_conditions: [
                  { field: "Todo owner alias", operator: "non_empty_string" },
                ],
                match: { all: ["更新状态"] },
                sop_ref: "sop/update-growth-status.md",
              },
            ],
          },
        ],
      }));
      await writeFile(join(dir, "sop/update-growth-status.md"), [
        "---",
        "name: update-growth-status",
        "target_session: amzdata",
        "reply_template: 状态更新完成：{{result}}",
        "---",
        "把目标记录链接、评论文本、历史评论和关键字段投递给增长天王。",
        "",
      ].join("\n"));

      const loader = createFileDriveCommentMentionRegistryLoader({
        registryPath: join(dir, "mention-routes.json"),
      });

      await expect(loader.load()).resolves.toEqual({
        version: 1,
        routes: [
          {
            id: "growth-diagnosis",
            enabled: true,
            ownerSession: "amzdata",
            delivery: { type: "session", sessionName: "amzdata" },
            ingest: { poll: { intervalSec: 120, since: 1_000 } },
            source: {
              fileToken: "base_token",
              fileType: "bitable",
              tableId: "tbl_1",
            },
            triggers: [
              {
                id: "update-status",
                priority: 100,
                ingestModes: ["mention", "poll_unmentioned"],
                recordFieldConditions: [
                  { field: "Todo owner alias", operator: "non_empty_string" },
                ],
                match: { all: ["更新状态"] },
                sopRef: "sop/update-growth-status.md",
              },
            ],
          },
        ],
      });
      const registry = await loader.load();
      expect(deriveDriveCommentMentionPollWatches(registry)).toEqual([{
        routeId: "growth-diagnosis",
        fileToken: "base_token",
        fileType: "bitable",
        tableId: "tbl_1",
        since: 1_000,
        requireMention: false,
        intervalSec: 120,
      }]);
      await expect(loader.loadSop("sop/update-growth-status.md")).resolves.toEqual({
        name: "update-growth-status",
        targetSession: "amzdata",
        replyTemplate: "状态更新完成：{{result}}",
        body: "把目标记录链接、评论文本、历史评论和关键字段投递给增长天王。",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported route delivery type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-invalid-delivery-"));
    try {
      await writeFile(join(dir, "mention-routes.json"), JSON.stringify({
        version: 1,
        routes: [{
          id: "bad-delivery",
          delivery: { type: "chat", chat_id: "oc_x" },
          source: {},
          triggers: [],
        }],
      }));

      const loader = createFileDriveCommentMentionRegistryLoader({
        registryPath: join(dir, "mention-routes.json"),
      });

      await expect(loader.load()).rejects.toThrow(/delivery\.type is invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects poll intervals below 60 seconds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-invalid-poll-"));
    try {
      await writeFile(join(dir, "mention-routes.json"), JSON.stringify({
        version: 1,
        routes: [{
          id: "too-fast",
          source: { file_token: "base_token", file_type: "bitable" },
          ingest: { poll: { interval_sec: 59 } },
          triggers: [],
        }],
      }));
      const loader = createFileDriveCommentMentionRegistryLoader({
        registryPath: join(dir, "mention-routes.json"),
      });

      await expect(loader.load()).rejects.toThrow(/interval_sec must be an integer >= 60/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the registry file is absent", async () => {
    const loader = createFileDriveCommentMentionRegistryLoader({
      registryPath: join(tmpdir(), "missing-mention-routes.json"),
    });

    await expect(loader.load()).resolves.toBeNull();
  });

  test("resolves workspace-root SOP refs when the registry is under registry/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-layout-"));
    try {
      await mkdir(join(dir, "registry"), { recursive: true });
      await mkdir(join(dir, "sop", "mention"), { recursive: true });
      await writeFile(join(dir, "registry", "mention-routes.json"), JSON.stringify({
        version: 1,
        routes: [],
      }));
      await writeFile(join(dir, "sop", "mention", "todo.md"), [
        "---",
        "name: todolist-agent-todo-comment",
        "target_session: tobedone",
        "---",
        "把评论上下文交给 tobedone。",
        "",
      ].join("\n"));

      const loader = createFileDriveCommentMentionRegistryLoader({
        registryPath: join(dir, "registry", "mention-routes.json"),
      });

      await expect(loader.loadSop("sop/mention/todo.md")).resolves.toMatchObject({
        name: "todolist-agent-todo-comment",
        targetSession: "tobedone",
        body: "把评论上下文交给 tobedone。",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("owns poll cursor persistence and does not revive a disabled route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-poll-cursor-"));
    try {
      const registryPath = join(dir, "mention-routes.json");
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        routes: [{
          id: "consult",
          source: { file_token: "base_token", file_type: "bitable" },
          ingest: { poll: { interval_sec: 60, since: 1_000 } },
          triggers: [{
            id: "consult",
            ingest_modes: ["poll_unmentioned"],
            match: { any: ["优先级"] },
            sop_ref: "sop/mention/consult.md",
          }],
        }],
      }));

      await persistDriveCommentMentionPollSince(registryPath, "consult", 2_000);
      let persisted = JSON.parse(await readFile(registryPath, "utf8"));
      expect(persisted.routes[0].ingest.poll.since).toBe(2_000);

      persisted.routes[0].enabled = false;
      await writeFile(registryPath, `${JSON.stringify(persisted)}\n`);
      await persistDriveCommentMentionPollSince(registryPath, "consult", 3_000);
      persisted = JSON.parse(await readFile(registryPath, "utf8"));
      expect(persisted.routes[0].ingest.poll.since).toBe(2_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("[451] ingest loader fail-closed contract", () => {
  async function withRegistry<T>(
    routes: unknown[],
    fn: (registryPath: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "supermatrix-mention-registry-451-"));
    try {
      const registryPath = join(dir, "mention-routes.json");
      await writeFile(registryPath, JSON.stringify({ version: 1, routes }));
      return await fn(registryPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("[451] a non-integer ingest.poll.interval_sec fails closed instead of being ignored", async () => {
    await withRegistry([{
      id: "bad-interval",
      source: { file_token: "base_token", file_type: "bitable" },
      ingest: { poll: { interval_sec: "120" } },
      triggers: [],
    }], async (registryPath) => {
      const loader = createFileDriveCommentMentionRegistryLoader({ registryPath });
      await expect(loader.load()).rejects.toThrow(/interval_sec must be an integer >= 60/);
    });
  });

  test("[451] an unknown ingest_modes value fails closed", async () => {
    await withRegistry([{
      id: "bad-ingest-mode",
      source: { file_token: "base_token", file_type: "bitable" },
      triggers: [{
        id: "t1",
        match: { all: ["x"] },
        ingest_modes: ["poll_all"],
        sop_ref: "sop/mention/x.md",
      }],
    }], async (registryPath) => {
      const loader = createFileDriveCommentMentionRegistryLoader({ registryPath });
      await expect(loader.load()).rejects.toThrow(/ingest_modes\[0\] is invalid: poll_all/);
    });
  });

  test("[451] triggers without ingest_modes default to mention-only watches", async () => {
    await withRegistry([{
      id: "legacy-route",
      source: { file_token: "base_token", file_type: "bitable" },
      ingest: { poll: { interval_sec: 120 } },
      triggers: [{ id: "t1", match: { all: ["x"] }, sop_ref: "sop/mention/x.md" }],
    }], async (registryPath) => {
      const loader = createFileDriveCommentMentionRegistryLoader({ registryPath });
      const registry = await loader.load();
      expect(registry?.routes[0]?.triggers[0]?.ingestModes).toBeUndefined();
      expect(deriveDriveCommentMentionPollWatches(registry)).toEqual([{
        routeId: "legacy-route",
        fileToken: "base_token",
        fileType: "bitable",
        requireMention: true,
        intervalSec: 120,
      }]);
    });
  });
});
