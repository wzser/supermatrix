import { describe, expect, test } from "vitest";
import { createSkillsHandler } from "../../../src/app/commands/skills.ts";
import { createFakeWorkspaceFs } from "../../fakes/fakeWorkspaceFs.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

const TEST_HOME = "/home/test";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_test"),
    name: "alpha",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "root",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/alpha"),
    backendSessionId: null,
    chatName: null,
    purpose: "test session",
    status: "idle",
    parentId: null,
    depth: 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(1000),
    updatedAt: asTimestamp(1000),
    ...overrides,
  };
}

function makeCtx(scope: "root" | "user", args: Record<string, string> = {}) {
  return {
    msg: {
      groupId: asLarkGroupId("oc_test"),
      messageId: "m",
      userId: "u",
      text: "/skills",
      attachments: [] as never[],
      receivedAtMs: 0,
    },
    scope: scope as "root" | "user",
    args,
  };
}

describe("skills handler", () => {
  test("lists plugins from settings.json mcpServers", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/settings.json": JSON.stringify({
        mcpServers: {
          superpowers: { command: "npx", args: ["superpowers"] },
          "first-principle": { command: "node", args: ["fp.js"] },
        },
      }),
    });
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("superpowers");
    expect(result.replyText).toContain("first-principle");
    expect(result.replyText).toContain("MCP servers (2):");
  });

  test("lists custom commands from .claude/commands/", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/commands/deploy.md":
        "---\ndescription: Deploy to production\n---\nRun deploy steps",
      "/ws/alpha/.claude/commands/lint.md": "Run lint checks",
    });
    fs.dirs.add(asAbsolutePath("/ws/alpha/.claude/commands"));
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/deploy");
    expect(result.replyText).toContain("Deploy to production");
    expect(result.replyText).toContain("/lint");
    expect(result.replyText).toContain("Custom commands (2):");
  });

  test("shows both plugins and commands", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/settings.json": JSON.stringify({
        mcpServers: { superpowers: {} },
      }),
      "/ws/alpha/.claude/commands/review.md":
        "---\ndescription: Code review\n---\nReview code",
    });
    fs.dirs.add(asAbsolutePath("/ws/alpha/.claude/commands"));
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("MCP servers (1):");
    expect(result.replyText).toContain("superpowers");
    expect(result.replyText).toContain("Custom commands (1):");
    expect(result.replyText).toContain("/review");
  });

  test("returns empty message when no skills found", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs();
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("没有注册任何 skill");
  });

  test("throws UserError for unknown session", async () => {
    const store = createFakeBindingStore();
    const fs = createFakeWorkspaceFs();
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    await expect(handler(makeCtx("root", { name: "nope" }))).rejects.toThrow(
      "session 不存在",
    );
  });

  test("user scope resolves session from group binding", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/settings.json": JSON.stringify({
        mcpServers: { myplugin: {} },
      }),
    });
    const resolve = async () => ({ name: "alpha", id: asSessionId("sess_test") });
    const handler = createSkillsHandler({
      store,
      fs,
      userHome: TEST_HOME,
      resolveUserGroupSession: resolve,
    });
    const result = await handler(makeCtx("user"));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("myplugin");
  });

  test("user scope throws when group not bound", async () => {
    const store = createFakeBindingStore();
    const fs = createFakeWorkspaceFs();
    const resolve = async () => null;
    const handler = createSkillsHandler({
      store,
      fs,
      userHome: TEST_HOME,
      resolveUserGroupSession: resolve,
    });
    await expect(handler(makeCtx("user"))).rejects.toThrow("未绑定 session");
  });

  test("ignores malformed settings.json", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/settings.json": "not json {{{",
    });
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("没有注册任何 skill");
  });

  test("lists skills from ~/.claude/skills/", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/home/test/.claude/skills/weread/SKILL.md":
        "---\nname: weread\ndescription: 微信读书助手\n---\n# WeRead",
      "/home/test/.claude/skills/caveman/SKILL.md":
        "---\nname: caveman\ndescription: Ultra-compressed mode\n---\n# Caveman",
    });
    fs.dirs.add(asAbsolutePath("/home/test/.claude/skills"));
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("Skills (2):");
    expect(result.replyText).toContain("weread");
    expect(result.replyText).toContain("微信读书助手");
    expect(result.replyText).toContain("caveman");
    expect(result.replyText).toContain("Ultra-compressed mode");
  });

  test("skips skill dirs without SKILL.md", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/home/test/.claude/skills/broken/README.md": "just a readme",
      "/home/test/.claude/skills/good/SKILL.md":
        "---\nname: good\ndescription: works\n---\n# Good",
    });
    fs.dirs.add(asAbsolutePath("/home/test/.claude/skills"));
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("good");
    expect(result.replyText).not.toContain("broken");
  });

  test("ignores non-.md files in commands dir", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    const fs = createFakeWorkspaceFs({
      "/ws/alpha/.claude/commands/deploy.md": "Deploy",
      "/ws/alpha/.claude/commands/README.txt": "Ignore me",
    });
    fs.dirs.add(asAbsolutePath("/ws/alpha/.claude/commands"));
    const handler = createSkillsHandler({ store, fs, userHome: TEST_HOME });
    const result = await handler(makeCtx("root", { name: "alpha" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("/deploy");
    expect(result.replyText).not.toContain("README");
  });
});
