import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFileDriveCommentMentionRegistryLoader } from "../../src/app/driveCommentMentionRegistry.ts";

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
            source: {
              file_token: "base_token",
              file_type: "bitable",
              table_id: "tbl_1",
            },
            triggers: [
              {
                id: "update-status",
                priority: 100,
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
            source: {
              fileToken: "base_token",
              fileType: "bitable",
              tableId: "tbl_1",
            },
            triggers: [
              {
                id: "update-status",
                priority: 100,
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
});
