import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CodexBackend } from "../../../src/adapters/backend-codex/index.ts";
import { collectStream } from "../../../src/app/streamCollector.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import { createTempStore } from "../store-sqlite/helpers.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeCodex.sh");

describe("Codex token usage pipeline", () => {
  // Pin the model for assertions: this test asserts the fallback model
  // wired into the codex stream parser is `gpt-5.4`. If the developer's
  // shell happens to set `SM_CODEX_DEFAULT_MODEL` (e.g. they pinned 5.5
  // in `.env.local` for local SM), it must not leak in here.
  const ORIGINAL_ENV = process.env.SM_CODEX_DEFAULT_MODEL;
  beforeEach(() => {
    process.env.SM_CODEX_DEFAULT_MODEL = "gpt-5.4";
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SM_CODEX_DEFAULT_MODEL;
    else process.env.SM_CODEX_DEFAULT_MODEL = ORIGINAL_ENV;
  });

  test("fake codex usage stream persists one token_usage row with reasoning excluded from output", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const sessionId = asSessionId("codex-usage-session");
      const runId = asMessageRunId("codex-usage-run");
      const now = asTimestamp(1_700_000_000_000);
      const workdir = asAbsolutePath("/tmp");
      await store.createSessionWithBinding(
        {
          id: sessionId,
          name: "codex-usage",
          scope: "user",
          backend: "codex",
          workdir,
          purpose: "",
          createdAt: now,
        },
        asLarkGroupId("oc_codex_usage")
      );
      await store.startMessageRun({
        id: runId,
        sessionId,
        groupId: asLarkGroupId("oc_codex_usage"),
        prompt: "hi",
        startedAt: now,
      });

      const backend = new CodexBackend({ command: FAKE, buildArgs: () => ["usage"] });
      const result = await collectStream(
        backend.run({
          session: {
            id: sessionId,
            name: "codex-usage",
            alias: "",
            avatar: "", category: "", fpManaged: null,
            scope: "user",
            backend: "codex",
            model: null,
            effort: null,
            thinking: false,
            modelLocked: false,
            workdir,
            backendSessionId: null,
            chatName: null,
            purpose: "",
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
            createdAt: now,
            updatedAt: now,
          },
          prompt: "hi",
        })
      );

      expect(result.usage).toBeTruthy();
      await store.recordTokenUsage({
        sessionId,
        messageRunId: runId,
        backend: "codex",
        model: result.usage?.model ?? null,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
        reasoningTokens: result.usage?.reasoningTokens ?? 0,
        rawUsageJson: result.usage?.rawUsageJson ?? null,
        createdAt: now,
      });

      const row = (
        store as unknown as {
          db: { prepare: (sql: string) => { get: () => Record<string, unknown> | undefined } };
        }
      ).db
        .prepare("SELECT * FROM token_usage WHERE message_run_id = 'codex-usage-run'")
        .get();

      expect(row).toBeTruthy();
      expect(row?.backend).toBe("codex");
      expect(row?.model).toBe("gpt-5.4");
      expect(row?.input_tokens).toBe(16006);
      expect(row?.output_tokens).toBe(307);
      expect(row?.cache_read_tokens).toBe(12000);
      expect(row?.cache_write_tokens).toBe(0);
      expect(row?.reasoning_tokens).toBe(463);
      expect(JSON.parse(String(row?.raw_usage_json))).toMatchObject({
        input_tokens: 16006,
        cached_input_tokens: 12000,
        output_tokens: 770,
        reasoning_output_tokens: 463,
        model: "gpt-5.4",
      });
    } finally {
      await cleanup();
    }
  });
});
