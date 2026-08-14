import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createLateBoundDriveCommentHandler,
  createNotifyDefaultChatResolver,
  reconcileDriveCommentSubscriptionAtStartup,
  validateEnv,
} from "../../src/cli/bootstrap.ts";
import { asLarkGroupId, asSessionId } from "../../src/domain/ids.ts";
import type { DriveCommentSubscriptionReconcileResult } from "../../src/adapters/lark-cli/realClient.ts";
import type { DriveCommentSource } from "../../src/ports/LarkGateway.ts";
import type { Logger } from "../../src/ports/Logger.ts";

const bootstrapSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/cli/bootstrap.ts"),
  "utf8",
);
const cliCompatibilityChecksSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/cli/cliCompatibilityChecks.ts"),
  "utf8",
);

describe("bootstrap lark-cli shim wiring", () => {
  it("runs the shim guard after real CLI validation and before dual-instance checks", () => {
    const preChecks = bootstrapSource.match(/const preChecks = \[[\s\S]*?\n  \];/)?.[0] ?? "";

    expect(preChecks).toContain("agentLarkCliShimCheck");
    expect(preChecks.indexOf("localDepsCheck")).toBeLessThan(preChecks.indexOf("agentLarkCliShimCheck"));
    expect(preChecks.indexOf("agentLarkCliShimCheck")).toBeLessThan(preChecks.indexOf("dualInstanceCheck"));
  });

  it("observes the shim guard during runtime self-check", () => {
    const runtimeChecks = bootstrapSource.match(/runChecks\(\s*"runtime"[\s\S]*?\n\s*\],\s*\n\s*\)/)?.[0] ?? "";

    expect(runtimeChecks).toContain("localDepsCheck");
    expect(runtimeChecks).toContain("agentLarkCliShimCheck");
  });
});

describe("bootstrap Drive comment subscription reconciliation", () => {
  it("logs a confirmed final status per identity on success", async () => {
    const info: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      ...silentLogger(),
      info(message: string, fields?: Record<string, unknown>) {
        info.push({ message, ...(fields ? { fields } : {}) });
      },
    } satisfies Logger;
    const result: DriveCommentSubscriptionReconcileResult = {
      eventType: "drive.notice.comment_add_v1",
      identities: [
        { identity: "bot", initialStatus: false, createAttempted: true, finalStatus: true },
        { identity: "user", initialStatus: true, createAttempted: false, finalStatus: true },
      ],
    };

    await reconcileDriveCommentSubscriptionAtStartup({
      reconcile: async () => result,
      logger,
    });

    expect(info).toEqual([
      {
        message: "drive comment subscription reconciled",
        fields: result.identities[0],
      },
      {
        message: "drive comment subscription reconciled",
        fields: result.identities[1],
      },
    ]);
  });

  it("logs structured failure per identity without rejecting startup", async () => {
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      ...silentLogger(),
      error(message: string, fields?: Record<string, unknown>) {
        errors.push({ message, ...(fields ? { fields } : {}) });
      },
    } satisfies Logger;
    const result: DriveCommentSubscriptionReconcileResult = {
      eventType: "drive.notice.comment_add_v1",
      identities: [
        { identity: "bot", initialStatus: true, createAttempted: false, finalStatus: true },
        {
          identity: "user",
          initialStatus: false,
          createAttempted: true,
          finalStatus: false,
          error: "Drive comment subscription (user) remained false after create",
        },
      ],
    };

    await expect(reconcileDriveCommentSubscriptionAtStartup({
      reconcile: async () => result,
      logger,
    })).resolves.toBeUndefined();

    expect(errors).toEqual([{
      message: "drive comment subscription reconciliation failed",
      fields: result.identities[1],
    }]);
  });

  it("logs an unexpected reconciliation exception without rejecting startup", async () => {
    const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      ...silentLogger(),
      error(message: string, fields?: Record<string, unknown>) {
        errors.push({ message, ...(fields ? { fields } : {}) });
      },
    } satisfies Logger;

    await expect(reconcileDriveCommentSubscriptionAtStartup({
      reconcile: async () => { throw new Error("unexpected failure"); },
      logger,
    })).resolves.toBeUndefined();

    expect(errors).toEqual([{
      message: "drive comment subscription reconciliation failed",
      fields: {
        eventType: "drive.notice.comment_add_v1",
        identities: [
          { identity: "bot", initialStatus: null, createAttempted: null, finalStatus: null },
          { identity: "user", initialStatus: null, createAttempted: null, finalStatus: null },
        ],
        error: "unexpected failure",
      },
    }]);
  });

  it("passes the configured bot open id and poll watch path into the real Lark client", () => {
    const clientSource = bootstrapSource.match(
      /const larkClient = createRealLarkClient\(\{[\s\S]*?\n  \}\);/u,
    )?.[0] ?? "";

    expect(clientSource).toContain("...(cfg.botOpenId ? { botOpenId: cfg.botOpenId } : {}),");
    expect(clientSource).toContain(
      `driveCommentPollPath: path.join(path.dirname(cfg.dbPath), "drive-comment-watches.json"),`,
    );
  });

  it("starts the primary Lark ingress before invoking the real reconciler", () => {
    const startSource = bootstrapSource.match(
      /async start\(\) \{[\s\S]*?\n    \},\n    async stop\(\)/u,
    )?.[0] ?? "";

    expect(startSource).toContain("reconcileDriveCommentSubscriptionAtStartup({");
    expect(startSource).toContain("reconcile: () => reconcileDriveCommentSubscription({");
    expect(startSource.indexOf("await lark.start")).toBeGreaterThanOrEqual(0);
    expect(startSource.indexOf("await lark.start")).toBeLessThan(
      startSource.indexOf("await reconcileDriveCommentSubscriptionAtStartup"),
    );
  });

  it("passes the in-process SDK WS health provider into the API server", () => {
    const apiDepsSource = bootstrapSource.match(
      /const apiDeps: Parameters<typeof startApiServer>\[0\] = \{[\s\S]*?\n      \};/u,
    )?.[0] ?? "";

    expect(apiDepsSource).toContain("larkWsHealth: () => larkClient.getWsHealth()");
  });
});

describe("bootstrap Kimi Code health wiring", () => {
  it("uses the shared CLI compatibility checks with configured kimi --version", () => {
    expect(bootstrapSource).toContain("...createCliCompatibilityChecks()");
    expect(cliCompatibilityChecksSource).toContain(
      'process.env["SM_KIMI_CLI_PATH"] ?? "kimi"',
    );
    expect(cliCompatibilityChecksSource).toContain('execFileP(cmd, ["--version"]');
    expect(cliCompatibilityChecksSource).not.toContain('execFileP(cmd, ["info"]');
  });
});

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => silentLogger(),
  };
}

describe("validateEnv", () => {
  it("returns parsed config on valid env", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g_root",
      SM_ROOT_USER_ID: "u_owner",
      SM_WORKSPACE_ROOT: "/tmp/sm-work",
      SM_DB_PATH: "/tmp/sm.db",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
    });
    expect(cfg.backend).toBe("claude");
    expect(cfg.rootGroupId).toBe("g_root");
    expect(cfg.larkAppId).toBe("cli_test");
    expect(cfg.larkAppSecret).toBe("secret");
    expect(cfg.larkCliPath).toMatch(/lark-cli$/);
    expect(cfg.spawnOrphanThresholdSec).toBe(60);
    expect(cfg.gitActorSessionName).toBe("supermatrix-root");
    expect(cfg.cardAskGatePath).toBe("/tmp/card-ask-gate.json");
    expect(cfg.mentionRegistryPath).toBe("/tmp/sm-work/pinglunmaster/registry/mention-routes.json");
  });

  it("throws when required env is missing", () => {
    expect(() => validateEnv({ SM_ROOT_USER_ID: "u" })).toThrow();
  });

  it("rejects unsupported backend", () => {
    expect(() =>
      validateEnv({
        SM_ROOT_GROUP_ID: "g",
        SM_ROOT_USER_ID: "u",
        SM_WORKSPACE_ROOT: "/w",
        SM_DB_PATH: "/d",
        SM_BACKEND: "gpt4",
        SM_LOG_LEVEL: "info",
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret",
      })
    ).toThrow();
  });

  it("honors explicit SM_LARK_CLI_PATH override", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      SM_LARK_CLI_PATH: "/custom/path/lark-cli",
    });
    expect(cfg.larkCliPath).toBe("/custom/path/lark-cli");
  });

  it("passes an optional LARK_BOT_OPEN_ID into the config", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      LARK_BOT_OPEN_ID: "ou_bot_43f6",
    });
    expect(cfg.botOpenId).toBe("ou_bot_43f6");
  });

  it("treats an empty LARK_BOT_OPEN_ID as unset", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      LARK_BOT_OPEN_ID: "   ",
    });
    expect(cfg.botOpenId).toBeUndefined();
  });

  it("honors explicit spawn orphan threshold override", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      SM_SPAWN_ORPHAN_THRESHOLD_SEC: "120",
    });
    expect(cfg.spawnOrphanThresholdSec).toBe(120);
  });

  it("derives the card ask gate path from the runtime data directory", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/runtime/data/supermatrix.db",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
    });
    expect(cfg.cardAskGatePath).toBe("/runtime/data/card-ask-gate.json");
  });

  it("honors explicit mention registry path override", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      SM_MENTION_REGISTRY_PATH: "/custom/mention-routes.json",
    });
    expect(cfg.mentionRegistryPath).toBe("/custom/mention-routes.json");
  });

  it("uses SM_SESSION_NAME for traceable git authors when provided", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "claude",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      SM_SESSION_NAME: "watchdog",
    });
    expect(cfg.gitActorSessionName).toBe("watchdog");
  });

  it("defaults Codex root runtime git authors to codexroot", () => {
    const cfg = validateEnv({
      SM_ROOT_GROUP_ID: "g",
      SM_ROOT_USER_ID: "u",
      SM_WORKSPACE_ROOT: "/w",
      SM_DB_PATH: "/d",
      SM_BACKEND: "codex",
      SM_LOG_LEVEL: "info",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
    });
    expect(cfg.gitActorSessionName).toBe("codexroot");
  });

  it("wraps the lark-cli notify sender in the dry-run guard", () => {
    const wiring = bootstrapSource.match(/const notifier = createConsoleNotifier\(\{[\s\S]*?\n  \}\);/)?.[0] ?? "";

    expect(wiring).toContain("sender: withNotifyDryRun({");
    expect(wiring).toContain("}, notifyDryRun, notifyLogger, CONSOLE_GROUP_ID)");
    expect(bootstrapSource).toContain("const notifyDryRun = resolveNotifyDryRun(process.env);");
  });

  it.each([
    ["normal session", "ad-adjust", "ad-adjust"],
    ["hash child suffix", "child_ad-adjust_681f40", "ad-adjust"],
    ["numeric child suffix", "child_scheduler_1", "scheduler"],
    ["nested child session", "child_child_amzdata_a4a498_c54024", "amzdata"],
  ])("routes notify default chat for %s through the owner binding", async (_label, source, expectedLookup) => {
    const lookups: string[] = [];
    const resolver = createNotifyDefaultChatResolver({
      async findSessionByName(name: string) {
        lookups.push(name);
        if (name !== expectedLookup) return null;
        return { id: asSessionId(`sess_${name}`) };
      },
      async findBySession(sessionId) {
        if (sessionId !== asSessionId(`sess_${expectedLookup}`)) return null;
        return { groupId: asLarkGroupId(`oc_${expectedLookup}`) };
      },
    }, silentLogger());

    await expect(resolver(source)).resolves.toBe(`oc_${expectedLookup}`);
    expect(lookups).toEqual([expectedLookup]);
  });

  it("falls back when the notify owner session has no binding", async () => {
    const resolver = createNotifyDefaultChatResolver({
      async findSessionByName(name: string) {
        return name === "test-owner" ? { id: asSessionId("sess_test_owner") } : null;
      },
      async findBySession() {
        return null;
      },
    }, silentLogger());

    await expect(resolver("child_test-owner_123")).resolves.toBeNull();
  });

  it("falls back for malformed child notify source names", async () => {
    const lookups: string[] = [];
    const resolver = createNotifyDefaultChatResolver({
      async findSessionByName(name: string) {
        lookups.push(name);
        return null;
      },
      async findBySession() {
        throw new Error("findBySession should not be called");
      },
    }, silentLogger());

    await expect(resolver("child__abc")).resolves.toBeNull();
    expect(lookups).toEqual(["child__abc"]);
  });

  it("forwards drive comment events to the late-bound processor", async () => {
    const source: DriveCommentSource = {
      kind: "drive_comment",
      eventId: "evt_1",
      fileToken: "doc_token",
      fileType: "docx",
      commentId: "comment_1",
      fromUserId: "ou_user",
    };
    const received: DriveCommentSource[] = [];
    const handler = createLateBoundDriveCommentHandler(
      () => ({
        handle: async (input) => {
          received.push(input);
        },
        sweepQueuedMentions: async () => 0,
      }),
      silentLogger(),
    );

    await handler(source);

    expect(received).toEqual([source]);
  });
});
