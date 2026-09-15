import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as quotaStatusModule from "../../scripts/quota-status-notify.ts";
import {
  buildQuotaStatusMessage,
  parseClaudeUsageJson,
  parseKimiUsageJson,
  parseLatestCodexRateLimitsFromJsonl,
  queryClaudeUsage,
  queryKimiUsage,
  sendLarkText,
  type CommandResult,
} from "../../scripts/quota-status-notify.ts";

const claudeOAuthUsageResponse = {
  five_hour: {
    utilization: 23,
    resets_at: "2026-07-28T10:00:00.000Z",
  },
  seven_day: {
    utilization: 61,
    resets_at: "2026-08-03T00:00:00.000Z",
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: {
    utilization: 17,
    resets_at: "2026-08-03T00:00:00.000Z",
  },
  cinder_cove: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    disabled_reason: null,
  },
  limits: [
    {
      kind: "weekly_scoped",
      group: "model",
      percent: 8,
      resets_at: "2026-08-03T00:00:00.000Z",
      scope: {
        model: { display_name: "Fable" },
        surface: null,
      },
    },
  ],
};

function curlUsageResult(status: number, body: unknown = claudeOAuthUsageResponse): CommandResult {
  return {
    ok: true,
    code: 0,
    stdout: `${JSON.stringify(body)}\nSM_HTTP_STATUS:${status}\n`,
    stderr: "",
    timedOut: false,
  };
}

function claudeCredentialResult(accessToken: string, expiresAt: number, refreshToken?: string): CommandResult {
  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      claudeAiOauth: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt,
      },
    }),
    stderr: "",
    timedOut: false,
  };
}

const testClaudeSettingsDir = mkdtempSync(join(tmpdir(), "supermatrix-claude-settings-"));

function defaultMatchedClaudeCachedUsage(accountUuid: string) {
  return {
    accountUuid,
    fetchedAtMs: Date.parse("2026-07-28T08:00:00.000Z"),
    utilization: claudeOAuthUsageResponse,
  };
}

function writeTestClaudeSettings(input: {
  accountUuid?: string;
  organizationUuid?: string;
  cachedUsageUtilization?: unknown;
} = {}): string {
  const path = join(testClaudeSettingsDir, `${randomUUID()}.json`);
  const accountUuid = input.accountUuid ?? "test-account-uuid";
  // Pass cachedUsageUtilization: undefined to construct the absent-cache case.
  const cachedUsageUtilization = Object.prototype.hasOwnProperty.call(input, "cachedUsageUtilization")
    ? input.cachedUsageUtilization
    : defaultMatchedClaudeCachedUsage(accountUuid);
  writeFileSync(path, JSON.stringify({
    oauthAccount: {
      accountUuid,
      organizationUuid: input.organizationUuid ?? "test-organization-uuid",
    },
    ...(cachedUsageUtilization === undefined ? {} : { cachedUsageUtilization }),
  }));
  return path;
}

afterAll(() => {
  rmSync(testClaudeSettingsDir, { recursive: true, force: true });
});

describe("quota-status-notify", () => {
  test("parses the latest Codex token_count rate_limits event and ignores plain text matches", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-07-08T00:00:00.000Z",
        type: "response_item",
        payload: { text: "this line mentions rate_limits but is not a token_count event" },
      }),
      JSON.stringify({
        timestamp: "2026-07-08T00:30:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 4, window_minutes: 300, resets_at: 1783070000 },
            secondary: { used_percent: 19, window_minutes: 10080, resets_at: 1783500000 },
            plan_type: "pro",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-08T01:20:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 2, window_minutes: 300, resets_at: 1783071000 },
            secondary: { used_percent: 7, window_minutes: 10080, resets_at: 1783501000 },
            plan_type: "pro",
          },
        },
      }),
    ].join("\n");

    const snapshot = parseLatestCodexRateLimitsFromJsonl(content, "codex.jsonl");

    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: Date.parse("2026-07-08T01:20:00.000Z"),
      sourcePath: "codex.jsonl",
      planType: "pro",
      primary: { usedPercent: 2, remainingPercent: 98, windowMinutes: 300, resetAtMs: 1783071000 * 1000 },
      secondary: { usedPercent: 7, remainingPercent: 93, windowMinutes: 10080, resetAtMs: 1783501000 * 1000 },
    });
  });

  test("uses the current single weekly Codex rate-limit window instead of stale dual-window data", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-07-13T02:51:52.352Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 18, window_minutes: 300, resets_at: 1783896218 },
            secondary: { used_percent: 28, window_minutes: 10080, resets_at: 1784355497 },
            plan_type: "pro",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-13T06:34:17.390Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 20, window_minutes: 10080, resets_at: 1784487621 },
            secondary: null,
            plan_type: "pro",
          },
        },
      }),
    ].join("\n");

    const snapshot = parseLatestCodexRateLimitsFromJsonl(content, "codex.jsonl");
    const message = buildQuotaStatusMessage({
      nowMs: Date.parse("2026-07-13T06:35:00.000Z"),
      codex: snapshot,
      claude: { ok: false, error: "not queried" },
      kimi: { ok: false, error: "not queried" },
    });

    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: Date.parse("2026-07-13T06:34:17.390Z"),
      primary: { usedPercent: 20, remainingPercent: 80, windowMinutes: 10080 },
    });
    expect(message).toContain("weekly: used 20% / remain 80%");
    expect(message).not.toContain("5h: used 20%");
    expect(message).not.toContain("used 28%");
  });

  test("does not let a model-specific limit overwrite the account-wide Codex quota", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-07-13T06:34:17.390Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 20, window_minutes: 10080, resets_at: 1784487621 },
            secondary: null,
            plan_type: "pro",
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-07-13T06:35:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex_bengalfox",
            limit_name: "GPT-5.3-Codex-Spark",
            primary: { used_percent: 0, window_minutes: 10080, resets_at: 1784500466 },
            secondary: null,
          },
        },
      }),
    ].join("\n");

    const snapshot = parseLatestCodexRateLimitsFromJsonl(content, "codex.jsonl");

    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: Date.parse("2026-07-13T06:34:17.390Z"),
      planType: "pro",
      primary: { usedPercent: 20, windowMinutes: 10080 },
    });
  });

  test("parses Claude /usage JSON result percentages", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current session: 0% used · resets Jul 8 at 12:39pm (Asia/Shanghai)",
        "Current week (all models): 9% used · resets Jul 14 at 3:59pm (Asia/Shanghai)",
        "Current week (Fable): 6% used · resets Jul 14 at 3:59pm (Asia/Shanghai)",
      ].join("\n"),
    });

    const snapshot = parseClaudeUsageJson(stdout, Date.parse("2026-07-08T01:20:00.000Z"));

    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: Date.parse("2026-07-08T01:20:00.000Z"),
      session: { usedPercent: 0, remainingPercent: 100, resetsAtText: "Jul 8 at 12:39pm (Asia/Shanghai)" },
      weeklyAll: { usedPercent: 9, remainingPercent: 91, resetsAtText: "Jul 14 at 3:59pm (Asia/Shanghai)" },
      weeklyFable: { usedPercent: 6, remainingPercent: 94, resetsAtText: "Jul 14 at 3:59pm (Asia/Shanghai)" },
    });
  });

  test("parses a passive Claude status-line rate-limit snapshot without invoking Claude", () => {
    expect("parseClaudeStatuslineSnapshot" in quotaStatusModule).toBe(true);
    const parseSnapshot = (
      quotaStatusModule as unknown as {
        parseClaudeStatuslineSnapshot: (content: string, sourcePath: string) => unknown;
      }
    ).parseClaudeStatuslineSnapshot;

    const snapshot = parseSnapshot(
      JSON.stringify({
        generatedAt: 1784944800000,
        providers: [
          {
            id: "claude",
            status: "ok",
            sourceObservedAt: 1784944800000,
            limits: [
              {
                key: "five-hour",
                usedPercent: 23,
                remainingPercent: 77,
                resetAtMs: 1784952000000,
              },
              {
                key: "seven-day",
                usedPercent: 61,
                remainingPercent: 39,
                resetAtMs: 1785542400000,
              },
            ],
          },
        ],
      }),
      "/tmp/usage-status.json",
    );

    expect(snapshot).toEqual({
      ok: true,
      observedAtMs: 1784944800000,
      rawText: "passive Claude status-line rate_limits",
      session: {
        usedPercent: 23,
        remainingPercent: 77,
        resetAtMs: 1784952000000,
      },
      weeklyAll: {
        usedPercent: 61,
        remainingPercent: 39,
        resetAtMs: 1785542400000,
      },
    });
  });

  test("captures Claude status-line rate limits to a token-free snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-"));
    const snapshotPath = join(directory, "usage-status.json");
    const scriptPath = join(import.meta.dirname, "../../scripts/claude-quota-statusline.cjs");
    const observedBefore = Date.now();

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        input: JSON.stringify({
          version: "2.1.217",
          rate_limits: {
            five_hour: { used_percentage: 23, resets_at: 1784952000 },
            seven_day: { used_percentage: 61, resets_at: 1785542400 },
          },
        }),
        env: {
          ...process.env,
          CLAUDE_USAGE_SNAPSHOT_PATH: snapshotPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      expect(snapshot.generatedAt).toBeGreaterThanOrEqual(observedBefore);
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        claudeCodeVersion: "2.1.217",
        providers: [
          {
            id: "claude",
            label: "Claude",
            status: "ok",
            source: "Claude status-line rate_limits",
            limits: [
              {
                key: "five-hour",
                label: "5h",
                usedPercent: 23,
                remainingPercent: 77,
                resetAtMs: 1784952000000,
              },
              {
                key: "seven-day",
                label: "7d",
                usedPercent: 61,
                remainingPercent: 39,
                resetAtMs: 1785542400000,
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(snapshot)).not.toMatch(/accessToken|refreshToken|oauth|credential/iu);
      expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("parses the Claude 2.1.217 OAuth usage response shape", () => {
    expect("parseClaudeOAuthUsageJson" in quotaStatusModule).toBe(true);
    const parseUsage = (
      quotaStatusModule as unknown as {
        parseClaudeOAuthUsageJson: (content: string, observedAtMs: number) => unknown;
      }
    ).parseClaudeOAuthUsageJson;
    const observedAtMs = Date.parse("2026-07-28T08:00:00.000Z");

    const snapshot = parseUsage(JSON.stringify(claudeOAuthUsageResponse), observedAtMs);

    expect(snapshot).toEqual({
      ok: true,
      observedAtMs,
      rawText: "official Claude OAuth usage API",
      session: {
        usedPercent: 23,
        remainingPercent: 77,
        resetAtMs: Date.parse("2026-07-28T10:00:00.000Z"),
      },
      weeklyAll: {
        usedPercent: 61,
        remainingPercent: 39,
        resetAtMs: Date.parse("2026-08-03T00:00:00.000Z"),
      },
      weeklyFable: {
        usedPercent: 8,
        remainingPercent: 92,
        resetAtMs: Date.parse("2026-08-03T00:00:00.000Z"),
      },
    });
  });

  test("writes optional command input to child stdin without putting it in argv or env", async () => {
    const input = "stdin-only-test-value";
    const script = [
      "let content = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { content += chunk; });",
      "process.stdin.on('end', () => process.stdout.write(content));",
    ].join("");

    const result = await quotaStatusModule.runCommand(process.execPath, ["-e", script], 5_000, {}, input);

    expect(result).toMatchObject({ ok: true, stdout: input, stderr: "", timedOut: false });
    expect(JSON.stringify([process.execPath, "-e", script])).not.toContain(input);
    expect(JSON.stringify({})).not.toContain(input);
  });

  test("prefers a fresh Claude status-line snapshot without reading Keychain or making a network request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-priority-"));
    const snapshotPath = join(directory, "usage-status.json");
    const nowMs = Date.parse("2026-07-28T08:10:00.000Z");
    writeFileSync(snapshotPath, JSON.stringify({
      generatedAt: nowMs - 5 * 60_000,
      providers: [{
        id: "claude",
        sourceObservedAt: nowMs - 5 * 60_000,
        limits: [{
          key: "five-hour",
          usedPercent: 9,
          remainingPercent: 91,
        }],
      }],
    }));
    let keychainReads = 0;
    let fetches = 0;

    try {
      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: snapshotPath,
        claudeSettingsPath: writeTestClaudeSettings({
          cachedUsageUtilization: {
            accountUuid: "test-account-uuid",
            fetchedAtMs: nowMs - 5_000,
            utilization: {
              five_hour: { utilization: 9 },
            },
          },
        }),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "test-macos-login",
        runCommand: async () => {
          keychainReads += 1;
          fetches += 1;
          throw new Error("no command may run when the snapshot is fresh");
        },
      });

      expect(snapshot).toMatchObject({
        ok: true,
        rawText: "passive Claude status-line rate_limits",
        session: { usedPercent: 9, remainingPercent: 91 },
        accountIdentity: { cachedUsage: "matched" },
      });
      expect(keychainReads).toBe(0);
      expect(fetches).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("skips a fresh passive snapshot missing Fable and returns matching live usage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-passive-account-conflict-"));
    const snapshotPath = join(directory, "usage-status.json");
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    writeFileSync(snapshotPath, JSON.stringify({
      generatedAt: nowMs - 5 * 60_000,
      providers: [{
        id: "claude",
        sourceObservedAt: nowMs - 5 * 60_000,
        limits: [
          {
            key: "five-hour",
            usedPercent: 23,
            remainingPercent: 77,
            resetAtMs: Date.parse("2026-08-01T08:00:00.000Z"),
          },
          {
            key: "seven-day",
            usedPercent: 61,
            remainingPercent: 39,
            resetAtMs: Date.parse("2026-08-04T00:00:00.000Z"),
          },
        ],
      }],
    }));
    const commands: string[] = [];

    try {
      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: snapshotPath,
        claudeSettingsPath: writeTestClaudeSettings({
          accountUuid,
          cachedUsageUtilization: {
            accountUuid,
            fetchedAtMs: nowMs - 5_000,
            utilization: claudeOAuthUsageResponse,
          },
        }),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "current-macos-login",
        runCommand: async (file) => {
          commands.push(file);
          if (file === "/usr/bin/security") {
            return claudeCredentialResult("current-account-access-token", nowMs + 60_000);
          }
          return curlUsageResult(200);
        },
      });

      expect(commands).toEqual(["/usr/bin/security", "/usr/bin/curl"]);
      expect(snapshot).toMatchObject({
        ok: true,
        observedAtMs: nowMs,
        rawText: "official Claude OAuth usage API",
        session: { usedPercent: 23, remainingPercent: 77 },
        weeklyAll: { usedPercent: 61, remainingPercent: 39 },
        weeklyFable: { usedPercent: 8, remainingPercent: 92 },
        accountIdentity: {
          fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
          cachedUsage: "matched",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("queries live usage for a valid oauthAccount without cached usage and never borrows another Keychain account", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const macosAccount = "current-macos-login";
    const accountUuid = "current-account-uuid";
    const organizationUuid = "current-organization-uuid";
    const currentUserToken = "current-user-access-token";
    const otherAccountToken = "other-account-access-token";
    const commands: Array<{ file: string; args: string[]; input: string | undefined }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings({
        accountUuid,
        organizationUuid,
        cachedUsageUtilization: undefined,
      }),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => macosAccount,
      runCommand: async (file, args, _timeoutMs, _env, input) => {
        commands.push({ file, args, input });
        if (file === "/usr/bin/security") {
          const selectedAccount = args[args.indexOf("-a") + 1];
          return claudeCredentialResult(
            selectedAccount === macosAccount ? currentUserToken : otherAccountToken,
            nowMs + 60_000,
          );
        }
        return curlUsageResult(200);
      },
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "Claude Code-credentials", "-a", macosAccount, "-w"],
      input: undefined,
    });
    expect(commands[1]).toMatchObject({
      file: "/usr/bin/curl",
      args: ["--disable", "--no-location", "--config", "-"],
    });
    expect(commands[1]?.input).toContain(`header = "Authorization: Bearer ${currentUserToken}"`);
    expect(commands[1]?.input).toContain(`header = "x-organization-uuid: ${organizationUuid}"`);
    expect(commands[1]?.input).not.toContain(otherAccountToken);
    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: nowMs,
      rawText: "official Claude OAuth usage API",
      session: { usedPercent: 23, remainingPercent: 77 },
      weeklyAll: { usedPercent: 61, remainingPercent: 39 },
      weeklyFable: { usedPercent: 8, remainingPercent: 92 },
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "absent",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(currentUserToken);
    expect(JSON.stringify(snapshot)).not.toContain(otherAccountToken);
    expect(JSON.stringify(snapshot)).not.toContain(accountUuid);
    expect(JSON.stringify(snapshot)).not.toContain(organizationUuid);
  });

  test("uses the account-matched cache without querying legacy acct=Claude when the current macOS credential item is not found", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const macosAccount = "current-macos-login";
    const legacyKeychainAccount = "Claude";
    const commands: Array<{ file: string; args: string[]; input: string | undefined }> = [];
    let curlCalls = 0;

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => macosAccount,
      runCommand: async (file, args, _timeoutMs, _env, input) => {
        commands.push({ file, args, input });
        if (file === "/usr/bin/security") {
          const selectedAccount = args[args.indexOf("-a") + 1];
          if (selectedAccount === macosAccount) {
            return {
              ok: false,
              code: 44,
              stdout: "",
              stderr: "The specified item could not be found in the keychain.",
              timedOut: false,
            };
          }
          expect(selectedAccount).toBe(legacyKeychainAccount);
          return claudeCredentialResult("legacy-imported-access-token", nowMs + 60_000);
        }
        curlCalls += 1;
        return curlUsageResult(200);
      },
    });

    expect(commands.map(({ file, args }) => ({ file, args }))).toEqual([
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", "Claude Code-credentials", "-a", macosAccount, "-w"],
      },
    ]);
    expect(curlCalls).toBe(0);
    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "cached Claude OAuth usage",
      observedAtMs: Date.parse("2026-07-28T08:00:00.000Z"),
      accountIdentity: { cachedUsage: "matched" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("legacy-imported-access-token");
  });

  test("returns the matched cache and does not fall back to legacy acct=Claude when the current credential is malformed", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const macosAccount = "current-macos-login";
    const keychainAccounts: string[] = [];
    let curlCalls = 0;

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => macosAccount,
      runCommand: async (file, args) => {
        if (file === "/usr/bin/security") {
          keychainAccounts.push(args[args.indexOf("-a") + 1] ?? "");
          return { ok: true, code: 0, stdout: "not-json", stderr: "", timedOut: false };
        }
        curlCalls += 1;
        return curlUsageResult(200);
      },
    });

    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "cached Claude OAuth usage",
      accountIdentity: { cachedUsage: "matched" },
    });
    expect(keychainAccounts).toEqual([macosAccount]);
    expect(curlCalls).toBe(0);
  });

  test("fails closed before reading Keychain or OAuth when the account-bound cache is invalid", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const currentUserToken = "stale-current-user-access-token";
    const legacyToken = "legacy-main-access-token";
    const commands: Array<{ file: string; args: string[] }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings({
        accountUuid,
        cachedUsageUtilization: null,
      }),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "current-macos-login",
      runCommand: async (file, args) => {
        commands.push({ file, args });
        const selectedAccount = args[args.indexOf("-a") + 1];
        return claudeCredentialResult(selectedAccount === "Claude" ? legacyToken : currentUserToken, nowMs + 60_000);
      },
    });

    expect(commands).toEqual([]);
    expect(snapshot).toEqual({
      ok: false,
      error: "Claude account-bound cached usage is invalid; refusing attribution",
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "invalid",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(currentUserToken);
    expect(JSON.stringify(snapshot)).not.toContain(legacyToken);
  });

  test("uses the account-matched cache after an expired current macOS credential without legacy fallback", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const organizationUuid = "current-organization-uuid";
    const accessToken = "expired-access-token";
    const settingsPath = writeTestClaudeSettings({
      accountUuid,
      organizationUuid,
      cachedUsageUtilization: {
        accountUuid,
        fetchedAtMs: nowMs - 5_000,
        utilization: {
          five_hour: { utilization: 0, resets_at: "2026-08-01T08:00:00.000Z" },
          seven_day: { utilization: 0, resets_at: "2026-08-04T00:00:00.000Z" },
          limits: [],
        },
      },
    });
    const commands: Array<{ file: string; args: string[] }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: settingsPath,
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "current-macos-login",
      runCommand: async (file, args) => {
        commands.push({ file, args });
        return claudeCredentialResult(accessToken, nowMs);
      },
    });

    expect(commands).toEqual([{
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "Claude Code-credentials", "-a", "current-macos-login", "-w"],
    }]);
    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: nowMs - 5_000,
      rawText: "cached Claude OAuth usage",
      session: { usedPercent: 0, remainingPercent: 100 },
      weeklyAll: { usedPercent: 0, remainingPercent: 100 },
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "matched",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(accountUuid);
    expect(JSON.stringify(snapshot)).not.toContain(organizationUuid);
    expect(JSON.stringify(snapshot)).not.toContain(accessToken);
  });

  test("treats whitespace-only profile and cache UUID differences as the same account for live Claude usage", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const profileAccountUuid = `\t ${accountUuid} \n`;
    const cachedAccountUuid = `\r\n${accountUuid}\t `;
    const commands: string[] = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings({
        accountUuid: profileAccountUuid,
        cachedUsageUtilization: {
          accountUuid: cachedAccountUuid,
          fetchedAtMs: nowMs - 5_000,
          utilization: claudeOAuthUsageResponse,
        },
      }),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "current-macos-login",
      runCommand: async (file) => {
        commands.push(file);
        if (file === "/usr/bin/security") {
          return claudeCredentialResult("current-account-access-token", nowMs + 60_000);
        }
        return curlUsageResult(200);
      },
    });

    expect(commands).toEqual(["/usr/bin/security", "/usr/bin/curl"]);
    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "official Claude OAuth usage API",
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "matched",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(profileAccountUuid);
    expect(JSON.stringify(snapshot)).not.toContain(cachedAccountUuid);
  });

  test("rejects blank and embedded-newline UUIDs after normalization for both profile and cache", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const fingerprint = `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`;

    for (const invalidAccountUuid of [" \t\r\n ", `current\r\naccount`]) {
      const profileCommands: string[] = [];
      const profileSnapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
        claudeSettingsPath: writeTestClaudeSettings({ accountUuid: invalidAccountUuid }),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "current-macos-login",
        runCommand: async (file) => {
          profileCommands.push(file);
          return claudeCredentialResult("must-not-be-used", nowMs + 60_000);
        },
      });

      expect(profileSnapshot).toEqual({
        ok: false,
        error: "Claude account context is unavailable in ~/.claude.json",
      });
      expect(profileCommands).toEqual([]);

      const cacheCommands: string[] = [];
      const cacheSnapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
        claudeSettingsPath: writeTestClaudeSettings({
          accountUuid,
          cachedUsageUtilization: {
            accountUuid: invalidAccountUuid,
            fetchedAtMs: nowMs - 5_000,
            utilization: claudeOAuthUsageResponse,
          },
        }),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "current-macos-login",
        runCommand: async (file) => {
          cacheCommands.push(file);
          return claudeCredentialResult("must-not-be-used", nowMs + 60_000);
        },
      });

      expect(cacheSnapshot).toEqual({
        ok: false,
        error: "Claude account-bound cached usage is invalid; refusing attribution",
        accountIdentity: { fingerprint, cachedUsage: "invalid" },
      });
      expect(cacheCommands).toEqual([]);
    }
  });

  test("fails closed before reading Keychain or OAuth when cached usage belongs to a different oauthAccount", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const staleAccountUuid = "legacy-main-account-uuid";
    const settingsPath = writeTestClaudeSettings({
      accountUuid,
      cachedUsageUtilization: {
        accountUuid: staleAccountUuid,
        fetchedAtMs: nowMs - 5_000,
        utilization: {
          five_hour: { utilization: 100, resets_at: "2026-08-01T08:00:00.000Z" },
          seven_day: { utilization: 100, resets_at: "2026-08-04T00:00:00.000Z" },
        },
      },
    });
    const currentUserToken = "stale-current-user-access-token";
    const legacyToken = "legacy-main-access-token";
    const commands: Array<{ file: string; args: string[] }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: settingsPath,
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "current-macos-login",
      runCommand: async (file, args) => {
        commands.push({ file, args });
        const selectedAccount = args[args.indexOf("-a") + 1];
        return claudeCredentialResult(selectedAccount === "Claude" ? legacyToken : currentUserToken, nowMs + 60_000);
      },
    });

    expect(commands).toEqual([]);
    expect(snapshot).toEqual({
      ok: false,
      error: "Claude cached usage belongs to a different oauthAccount; refusing attribution",
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "mismatch",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(staleAccountUuid);
    expect(JSON.stringify(snapshot)).not.toContain(currentUserToken);
    expect(JSON.stringify(snapshot)).not.toContain(legacyToken);
  });

  test("accepts changed live OAuth usage for the normalized account-bound cache", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const accessToken = "current-account-access-token";
    const settingsPath = writeTestClaudeSettings({
      accountUuid,
      cachedUsageUtilization: {
        accountUuid,
        fetchedAtMs: nowMs - 5_000,
        utilization: {
          five_hour: { utilization: 0, resets_at: "2026-08-01T08:00:00.000Z" },
          seven_day: { utilization: 0, resets_at: "2026-08-04T00:00:00.000Z" },
          limits: [],
        },
      },
    });
    const commands: string[] = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: settingsPath,
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "current-macos-login",
      runCommand: async (file) => {
        commands.push(file);
        if (file === "/usr/bin/security") {
          return claudeCredentialResult(accessToken, nowMs + 60_000);
        }
        return curlUsageResult(200);
      },
    });

    expect(commands).toEqual(["/usr/bin/security", "/usr/bin/curl"]);
    expect(snapshot).toMatchObject({
      ok: true,
      observedAtMs: nowMs,
      rawText: "official Claude OAuth usage API",
      session: { usedPercent: 23, remainingPercent: 77 },
      weeklyAll: { usedPercent: 61, remainingPercent: 39 },
      accountIdentity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: "matched",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(accountUuid);
    expect(JSON.stringify(snapshot)).not.toContain(accessToken);
  });

  test("uses official live Fable usage when a fresh passive snapshot cannot prove the account", async () => {
    const nowMs = Date.parse("2026-08-01T03:30:00.000Z");
    const accountUuid = "current-account-uuid";
    const cachedFetchedAtMs = nowMs - 5_000;
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-passive-fable-conflict-"));
    const snapshotPath = join(directory, "usage-status.json");
    writeFileSync(snapshotPath, JSON.stringify({
      generatedAt: nowMs - 5 * 60_000,
      providers: [{
        id: "claude",
        sourceObservedAt: nowMs - 5 * 60_000,
        limits: [
          {
            key: "five-hour",
            usedPercent: 23,
            remainingPercent: 77,
            resetAtMs: Date.parse("2026-07-28T10:00:00.000Z"),
          },
          {
            key: "seven-day",
            usedPercent: 61,
            remainingPercent: 39,
            resetAtMs: Date.parse("2026-08-03T00:00:00.000Z"),
          },
        ],
      }],
    }));
    const settingsPath = writeTestClaudeSettings({
      accountUuid,
      cachedUsageUtilization: {
        accountUuid,
        fetchedAtMs: cachedFetchedAtMs,
        utilization: {
          five_hour: { utilization: 23, resets_at: "2026-07-28T10:00:00.000Z" },
          seven_day: { utilization: 61, resets_at: "2026-08-03T00:00:00.000Z" },
          limits: [{
            kind: "weekly_scoped",
            percent: 0,
            resets_at: "2026-08-03T00:00:00.000Z",
            scope: { model: { display_name: "Fable" } },
          }],
        },
      },
    });
    const commands: string[] = [];

    try {
      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: snapshotPath,
        claudeSettingsPath: settingsPath,
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "current-macos-login",
        runCommand: async (file) => {
          commands.push(file);
          if (file === "/usr/bin/security") {
            return claudeCredentialResult("current-account-access-token", nowMs + 60_000);
          }
          return curlUsageResult(200);
        },
      });

      expect(commands).toEqual(["/usr/bin/security", "/usr/bin/curl"]);
      expect(snapshot).toMatchObject({
        ok: true,
        observedAtMs: nowMs,
        rawText: "official Claude OAuth usage API",
        session: { usedPercent: 23, remainingPercent: 77 },
        weeklyAll: { usedPercent: 61, remainingPercent: 39 },
        weeklyFable: { usedPercent: 8, remainingPercent: 92 },
        accountIdentity: {
          fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
          cachedUsage: "matched",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("falls back to one OAuth GET when the Claude status-line snapshot is over one minute in the future", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-future-"));
    const snapshotPath = join(directory, "usage-status.json");
    const nowMs = Date.parse("2026-07-28T08:10:00.000Z");
    writeFileSync(snapshotPath, JSON.stringify({
      generatedAt: nowMs + 60_001,
      providers: [{
        id: "claude",
        sourceObservedAt: nowMs + 60_001,
        limits: [{
          key: "five-hour",
          usedPercent: 9,
          remainingPercent: 91,
          resetAtMs: 1785232800000,
        }],
      }],
    }));
    let keychainReads = 0;
    let curlCalls = 0;

    try {
      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: snapshotPath,
        claudeSettingsPath: writeTestClaudeSettings(),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "test-macos-login",
        env: {},
        runCommand: async (file) => {
          if (file === "/usr/bin/security") {
            keychainReads += 1;
            return claudeCredentialResult("future-fallback-access-token", nowMs + 60_000);
          }
          curlCalls += 1;
          return curlUsageResult(200);
        },
      });

      expect(keychainReads).toBe(1);
      expect(curlCalls).toBe(1);
      expect(snapshot).toMatchObject({
        ok: true,
        rawText: "official Claude OAuth usage API",
        session: { usedPercent: 23, remainingPercent: 77 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses proxy environment and sends the access token only through curl config stdin", async () => {
    const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
    const accessToken = "access-token-must-not-enter-receipt";
    const refreshToken = "refresh-token-must-never-be-sent";
    const networkEnv: NodeJS.ProcessEnv = {
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1",
      PATH: "/usr/bin:/bin",
    };
    const commands: Array<{
      file: string;
      args: string[];
      timeoutMs: number;
      env: NodeJS.ProcessEnv | undefined;
      input: string | undefined;
    }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "test-macos-login",
      env: networkEnv,
      runCommand: async (file, args, timeoutMs, env, input) => {
        commands.push({ file, args, timeoutMs, env, input });
        if (file === "/usr/bin/security") {
          return {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              claudeAiOauth: {
                accessToken,
                refreshToken,
                expiresAt: nowMs + 60_000,
                scopes: ["user:profile", "user:inference"],
              },
            }),
            stderr: "",
            timedOut: false,
          };
        }
        return curlUsageResult(200);
      },
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-s", "Claude Code-credentials", "-a", "test-macos-login", "-w"],
    });
    expect(commands[1]).toMatchObject({
      file: "/usr/bin/curl",
      args: ["--disable", "--no-location", "--config", "-"],
      timeoutMs: 5_000,
      env: networkEnv,
    });
    const curlCall = commands[1];
    expect(curlCall?.input).toContain("url = \"https://api.anthropic.com/api/oauth/usage\"");
    expect(curlCall?.input).toContain(`header = "Authorization: Bearer ${accessToken}"`);
    expect(curlCall?.input).toContain("header = \"anthropic-beta: oauth-2025-04-20\"");
    expect(curlCall?.input).toContain("header = \"x-organization-uuid: test-organization-uuid\"");
    expect(curlCall?.input).not.toContain("location");
    expect(JSON.stringify({ file: curlCall?.file, args: curlCall?.args, env: curlCall?.env })).not.toContain(
      accessToken,
    );
    expect(JSON.stringify({ file: curlCall?.file, args: curlCall?.args, env: curlCall?.env })).not.toContain(
      "test-organization-uuid",
    );
    expect(curlCall?.input).not.toContain(refreshToken);
    expect(JSON.stringify(commands.map(({ input: _input, ...command }) => command))).not.toContain(accessToken);
    expect(JSON.stringify(commands)).not.toContain("api/oauth/token");
    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "official Claude OAuth usage API",
      session: { usedPercent: 23, remainingPercent: 77 },
      weeklyAll: { usedPercent: 61, remainingPercent: 39 },
    });
    expect(JSON.stringify(snapshot)).not.toContain(accessToken);
    expect(JSON.stringify(snapshot)).not.toContain(refreshToken);
  });

  test.each([
    {
      controlName: "LF",
      accessToken: "line\nfeed-access-token",
      sentinel: "feed-access-token",
    },
    {
      controlName: "CR",
      accessToken: "carriage\rreturn-access-token",
      sentinel: "return-access-token",
    },
  ])("rejects an access token containing $controlName before constructing curl config", async ({
    accessToken,
    sentinel,
  }) => {
    const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
    const refreshToken = "refresh-token-must-never-be-sent";
    let curlCalls = 0;
    let argvOrEnvContainsToken = false;

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "test-macos-login",
      env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
      runCommand: async (file, args, _timeoutMs, env) => {
        argvOrEnvContainsToken ||= args.some((arg) => arg.includes(sentinel));
        argvOrEnvContainsToken ||= Object.values(env ?? {}).some((value) => value?.includes(sentinel) === true);
        if (file === "/usr/bin/security") {
          return claudeCredentialResult(accessToken, nowMs + 60_000, refreshToken);
        }
        curlCalls += 1;
        return curlUsageResult(200);
      },
    });

    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "cached Claude OAuth usage",
      accountIdentity: { cachedUsage: "matched" },
    });
    expect(curlCalls).toBe(0);
    expect(argvOrEnvContainsToken).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(sentinel);
    expect(JSON.stringify(snapshot)).not.toContain(refreshToken);
  });

  test("emits escaped stdin config accepted by system curl with redirects disabled in token-free argv", async () => {
    const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
    const accessToken = 'quote"and\\backslash-access-token';
    const accessTokenSentinel = "backslash-access-token";
    const refreshToken = "refresh-token-must-never-be-sent";
    let systemCurlResult: CommandResult | null = null;
    const curlCalls: Array<{
      args: string[];
      env: NodeJS.ProcessEnv | undefined;
      input: string | undefined;
    }> = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "test-macos-login",
      env: {},
      runCommand: async (file, args, timeoutMs, env, input) => {
        if (file === "/usr/bin/security") {
          return claudeCredentialResult(accessToken, nowMs + 60_000, refreshToken);
        }
        curlCalls.push({ args, env, input });
        const localConfig = input?.replace(
          "https://api.anthropic.com/api/oauth/usage",
          "file:///dev/null",
        );
        expect(localConfig).not.toBe(input);
        systemCurlResult = await quotaStatusModule.runCommand(
          file,
          args,
          timeoutMs,
          env,
          localConfig,
        );
        return systemCurlResult;
      },
    });

    expect(systemCurlResult).toMatchObject({
      ok: true,
      code: 0,
      stderr: "",
      timedOut: false,
    });
    expect(curlCalls).toHaveLength(1);
    const curlCall = curlCalls[0];
    expect(curlCall?.input).toContain(
      'header = "Authorization: Bearer quote\\"and\\\\backslash-access-token"',
    );
    expect(JSON.stringify({ args: curlCall?.args, env: curlCall?.env })).not.toContain(accessTokenSentinel);
    expect(curlCall?.input).not.toContain(refreshToken);
    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "cached Claude OAuth usage",
      accountIdentity: { cachedUsage: "matched" },
    });
    expect(JSON.stringify(snapshot)).not.toContain(accessTokenSentinel);
    expect(JSON.stringify(snapshot)).not.toContain(refreshToken);
  });

  test("makes the same single Claude usage GET when no proxy variables are configured", async () => {
    const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
    const commandEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    let curlCalls = 0;

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "test-macos-login",
      env: {},
      runCommand: async (file, _args, _timeoutMs, env) => {
        if (file === "/usr/bin/security") {
          return {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              claudeAiOauth: {
                accessToken: "direct-access-token",
                expiresAt: nowMs + 60_000,
              },
            }),
            stderr: "",
            timedOut: false,
          };
        }
        curlCalls += 1;
        commandEnvs.push(env);
        return curlUsageResult(200);
      },
    });

    expect(curlCalls).toBe(1);
    expect(commandEnvs).toEqual([{}]);
    expect(snapshot).toMatchObject({
      ok: true,
      session: { usedPercent: 23 },
      weeklyAll: { usedPercent: 61 },
    });
  });

  test("falls back to one OAuth GET when the Claude status-line snapshot is older than ten minutes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supermatrix-claude-quota-stale-"));
    const snapshotPath = join(directory, "usage-status.json");
    const nowMs = Date.parse("2026-07-28T08:10:00.000Z");
    writeFileSync(snapshotPath, JSON.stringify({
      generatedAt: nowMs - 10 * 60_000 - 1,
      providers: [{
        id: "claude",
        sourceObservedAt: nowMs - 10 * 60_000 - 1,
        limits: [{
          key: "five-hour",
          usedPercent: 9,
          remainingPercent: 91,
          resetAtMs: 1785232800000,
        }],
      }],
    }));
    let keychainReads = 0;
    let curlCalls = 0;

    try {
      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: snapshotPath,
        claudeSettingsPath: writeTestClaudeSettings(),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "test-macos-login",
        env: {},
        runCommand: async (file) => {
          if (file === "/usr/bin/security") {
            keychainReads += 1;
            return {
              ok: true,
              code: 0,
              stdout: JSON.stringify({
                claudeAiOauth: {
                  accessToken: "stale-fallback-access-token",
                  expiresAt: nowMs + 60_000,
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          curlCalls += 1;
          return curlUsageResult(200);
        },
      });

      expect(keychainReads).toBe(1);
      expect(curlCalls).toBe(1);
      expect(snapshot).toMatchObject({
        ok: true,
        rawText: "official Claude OAuth usage API",
        session: { usedPercent: 23, remainingPercent: 77 },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns Claude unavailable without a request when the access token is expired", async () => {
    const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
    let curlCalls = 0;
    const commandFiles: string[] = [];

    const snapshot = await queryClaudeUsage({
      claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
      claudeSettingsPath: writeTestClaudeSettings(),
      timeoutMs: 5_000,
      now: () => nowMs,
      currentUser: () => "test-macos-login",
      runCommand: async (file) => {
        commandFiles.push(file);
        if (file !== "/usr/bin/security") {
          curlCalls += 1;
        }
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-access-token",
              refreshToken: "refresh-token-must-not-be-used",
              expiresAt: nowMs,
            },
          }),
          stderr: "",
          timedOut: false,
        };
      },
    });

    expect(snapshot).toMatchObject({
      ok: true,
      rawText: "cached Claude OAuth usage",
      accountIdentity: { cachedUsage: "matched" },
    });
    expect(curlCalls).toBe(0);
    expect(commandFiles).toEqual(["/usr/bin/security"]);
  });

  test.each([401, 403])(
    "returns Claude unavailable after one HTTP %i without refresh or auth retry",
    async (status) => {
      const nowMs = Date.parse("2026-07-28T08:00:00.000Z");
      const accessToken = "rejected-access-token-must-not-enter-receipt";
      const refreshToken = "refresh-token-must-never-be-sent";
      const curlCalls: Array<{
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
        input: string | undefined;
      }> = [];
      const commandFiles: string[] = [];

      const snapshot = await queryClaudeUsage({
        claudeUsageSnapshotPath: join(tmpdir(), `missing-claude-usage-${randomUUID()}.json`),
        claudeSettingsPath: writeTestClaudeSettings({ cachedUsageUtilization: undefined }),
        timeoutMs: 5_000,
        now: () => nowMs,
        currentUser: () => "test-macos-login",
        env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
        runCommand: async (file, args, _timeoutMs, env, input) => {
          commandFiles.push(file);
          if (file === "/usr/bin/security") {
            return {
              ok: true,
              code: 0,
              stdout: JSON.stringify({
                claudeAiOauth: {
                  accessToken,
                  refreshToken,
                  expiresAt: nowMs + 60_000,
                },
              }),
              stderr: "",
              timedOut: false,
            };
          }
          curlCalls.push({ args, env, input });
          return curlUsageResult(status, { accessToken, refreshToken });
        },
      });

      expect(snapshot).toMatchObject({
        ok: false,
        error: `Claude OAuth usage unavailable (HTTP ${status}); authentication refresh is disabled`,
        accountIdentity: { cachedUsage: "absent" },
      });
      expect(curlCalls).toHaveLength(1);
      expect(commandFiles).toEqual(["/usr/bin/security", "/usr/bin/curl"]);
      expect(JSON.stringify({ args: curlCalls[0]?.args, env: curlCalls[0]?.env })).not.toContain(accessToken);
      expect(curlCalls[0]?.input).toContain(`Authorization: Bearer ${accessToken}`);
      expect(curlCalls[0]?.input).not.toContain(refreshToken);
      expect(JSON.stringify(snapshot)).not.toContain(accessToken);
      expect(JSON.stringify(snapshot)).not.toContain(refreshToken);
    },
  );

  test("parses Kimi Code weekly and five-hour managed quota", () => {
    const snapshot = parseKimiUsageJson(JSON.stringify({
      usage: {
        limit: "100",
        used: "5",
        remaining: "95",
        resetTime: "2026-07-24T16:18:35.469185Z",
      },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          used: "14",
          remaining: "86",
          resetTime: "2026-07-18T07:18:35.469185Z",
        },
      }],
    }), Date.parse("2026-07-18T07:12:00.000Z"));

    expect(snapshot).toEqual({
      ok: true,
      observedAtMs: Date.parse("2026-07-18T07:12:00.000Z"),
      weekly: {
        usedPercent: 5,
        remainingPercent: 95,
        resetAtMs: Date.parse("2026-07-24T16:18:35.469185Z"),
      },
      fiveHour: {
        usedPercent: 14,
        remainingPercent: 86,
        resetAtMs: Date.parse("2026-07-18T07:18:35.469185Z"),
      },
    });
  });

  test("reports Kimi Code unavailable when both quota windows are not present", () => {
    const snapshot = parseKimiUsageJson(JSON.stringify({
      usage: { limit: 100, remaining: 95, reset_at: "2026-07-24T16:18:35Z" },
      limits: [],
    }), Date.parse("2026-07-18T07:12:00.000Z"));

    expect(snapshot).toEqual({
      ok: false,
      error: "Kimi /usages did not include weekly and 5h quota windows",
    });
  });

  test("refreshes a near-expiry Kimi credential before querying managed quota", async () => {
    const kimiHomeDir = mkdtempSync(join(tmpdir(), "supermatrix-kimi-quota-"));
    const credentialsDir = join(kimiHomeDir, "credentials");
    mkdirSync(credentialsDir, { recursive: true });
    const credentialPath = join(credentialsDir, "kimi-code.json");
    const nowMs = Date.parse("2026-07-18T07:12:00.000Z");
    writeFileSync(credentialPath, JSON.stringify({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_at: Math.floor(nowMs / 1000) + 100,
      expires_in: 900,
      scope: "coding",
      token_type: "Bearer",
    }), { mode: 0o600 });

    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url === "https://auth.kimi.com/api/oauth/token") {
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 900,
          scope: "coding",
          token_type: "Bearer",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        usage: { limit: "100", used: "5", resetTime: "2026-07-24T16:18:35.469185Z" },
        limits: [{
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "14", resetTime: "2026-07-18T07:18:35.469185Z" },
        }],
      }), { status: 200 });
    };
    const cliCalls: Array<{ file: string; args: string[] }> = [];

    try {
      const snapshot = await queryKimiUsage({
        kimiCliPath: "kimi",
        kimiHomeDir,
        timeoutMs: 5_000,
        now: () => nowMs,
        env: {},
        fetchImpl,
        runCommand: async (file, args): Promise<CommandResult> => {
          cliCalls.push({ file, args });
          return { ok: true, code: 0, stdout: "0.26.0\n", stderr: "", timedOut: false };
        },
      });

      expect(snapshot).toMatchObject({
        ok: true,
        observedAtMs: nowMs,
        weekly: { usedPercent: 5, remainingPercent: 95 },
        fiveHour: { usedPercent: 14, remainingPercent: 86 },
      });
      expect(cliCalls).toEqual([{ file: "kimi", args: ["--version"] }]);
      expect(requests.map((request) => request.url)).toEqual([
        "https://auth.kimi.com/api/oauth/token",
        "https://api.kimi.com/coding/v1/usages",
      ]);
      expect(requests[0]).toMatchObject({ method: "POST" });
      expect(new URLSearchParams(requests[0]?.body).get("grant_type")).toBe("refresh_token");
      const saved = JSON.parse(readFileSync(credentialPath, "utf8")) as Record<string, unknown>;
      expect(saved).toMatchObject({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_at: Math.floor(nowMs / 1000) + 900,
      });
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(kimiHomeDir, { recursive: true, force: true });
    }
  });

  test("reports missing Kimi credentials without starting login or making a request", async () => {
    const kimiHomeDir = mkdtempSync(join(tmpdir(), "supermatrix-kimi-quota-missing-"));
    let invoked = false;
    try {
      const snapshot = await queryKimiUsage({
        kimiCliPath: "kimi",
        kimiHomeDir,
        timeoutMs: 5_000,
        now: () => Date.parse("2026-07-18T07:12:00.000Z"),
        env: {},
        fetchImpl: async () => {
          invoked = true;
          return new Response("{}", { status: 200 });
        },
        runCommand: async (): Promise<CommandResult> => {
          invoked = true;
          return { ok: true, code: 0, stdout: "0.26.0\n", stderr: "", timedOut: false };
        },
      });

      expect(snapshot).toEqual({
        ok: false,
        error: `Kimi credential not found: ${join(kimiHomeDir, "credentials/kimi-code.json")}`,
      });
      expect(invoked).toBe(false);
    } finally {
      rmSync(kimiHomeDir, { recursive: true, force: true });
    }
  });

  test("builds a compact status-group message with all providers and source freshness", () => {
    const message = buildQuotaStatusMessage({
      nowMs: Date.parse("2026-07-08T01:30:00.000Z"),
      codex: {
        ok: true,
        observedAtMs: Date.parse("2026-07-08T01:20:00.000Z"),
        sourcePath: "/Users/LOCAL_USER/.codex/sessions/latest.jsonl",
        planType: "pro",
        primary: { usedPercent: 2, remainingPercent: 98, windowMinutes: 300, resetAtMs: Date.parse("2026-07-08T05:50:40.000Z") },
        secondary: { usedPercent: 7, remainingPercent: 93, windowMinutes: 10080, resetAtMs: Date.parse("2026-07-14T01:46:44.000Z") },
      },
      claude: {
        ok: true,
        observedAtMs: Date.parse("2026-07-08T01:21:00.000Z"),
        rawText: "usage",
        session: { usedPercent: 0, remainingPercent: 100, resetsAtText: "Jul 8 at 12:39pm (Asia/Shanghai)" },
        weeklyAll: { usedPercent: 9, remainingPercent: 91, resetsAtText: "Jul 14 at 3:59pm (Asia/Shanghai)" },
        weeklyFable: { usedPercent: 6, remainingPercent: 94, resetsAtText: "Jul 14 at 3:59pm (Asia/Shanghai)" },
      },
      kimi: {
        ok: true,
        observedAtMs: Date.parse("2026-07-08T01:22:00.000Z"),
        weekly: {
          usedPercent: 5,
          remainingPercent: 95,
          resetAtMs: Date.parse("2026-07-14T16:18:35.000Z"),
        },
        fiveHour: {
          usedPercent: 14,
          remainingPercent: 86,
          resetAtMs: Date.parse("2026-07-08T05:18:35.000Z"),
        },
      },
    });

    expect(message).toContain("AI 额度状态｜2026-07-08 09:30 CST");
    expect(message).toContain("Codex Pro");
    expect(message).toContain("5h: used 2% / remain 98%");
    expect(message).toContain("weekly: used 7% / remain 93%");
    expect(message).toContain("Claude");
    expect(message).toContain("session: used 0% / remain 100%");
    expect(message).toContain("weekly all: used 9% / remain 91%");
    expect(message).toContain("Codex source: local rate_limits @ 09:20");
    expect(message).toContain("Kimi Code");
    expect(message).toContain("weekly: used 5% / remain 95%");
    expect(message).toContain("5h: used 14% / remain 86%");
    expect(message).toContain("Kimi source: local OAuth + Kimi /usages @ 09:22");
    expect(message).toContain("Kimi 来自本机 OAuth 认证后的结构化 /usages API");
  });

  test("sends via lark-cli and requires JSON ok true", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await sendLarkText({
      larkCliPath: "lark-cli",
      chatId: "oc_status",
      text: "hello",
      timeoutMs: 5_000,
      runCommand: async (file: string, args: string[]): Promise<CommandResult> => {
        calls.push({ file, args });
        return { ok: true, code: 0, stdout: "{\"ok\":true}", stderr: "", timedOut: false };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{
      file: "lark-cli",
      args: ["im", "+messages-send", "--as", "bot", "--chat-id", "oc_status", "--text", "hello"],
    }]);
  });

  test("treats lark-cli exit 0 with JSON ok false as failed delivery", async () => {
    const result = await sendLarkText({
      larkCliPath: "lark-cli",
      chatId: "oc_status",
      text: "hello",
      timeoutMs: 5_000,
      runCommand: async (): Promise<CommandResult> => ({
        ok: true,
        code: 0,
        stdout: "{\"ok\":false,\"error\":\"bad chat\"}",
        stderr: "",
        timedOut: false,
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.responsePreview).toContain("bad chat");
  });
});
