import { describe, expect, it } from "vitest";
import * as weeklyUpgradeShared from "../../src/scripts/_weekly-upgrade-shared.js";
import {
  summarizeClaudeAuthSnapshot,
  type QuietCommandResult,
  type ClaudeAuthStatusProbe,
} from "../../src/scripts/_weekly-upgrade-shared.js";

const FAKE_CLAUDE_BIN = "/fake/bin/claude";
const FAKE_UID = 501;

type CaptureClaudeAuthStatusProbes = (input: {
  claudeBin: string;
  uid: number;
  timeoutMs?: number;
  runCommand?: (command: string, args: string[], timeoutMs?: number) => Promise<QuietCommandResult>;
}) => Promise<ClaudeAuthStatusProbe[]>;

describe("weekly upgrade Claude auth scheduled-context probes", () => {
  it("uses the scheduled command shapes without requiring a local executable, account, or launchctl", async () => {
    const api = weeklyUpgradeShared as typeof weeklyUpgradeShared & {
      captureClaudeAuthStatusProbes?: CaptureClaudeAuthStatusProbes;
    };

    expect(api.captureClaudeAuthStatusProbes).toBeTypeOf("function");
    if (!api.captureClaudeAuthStatusProbes) return;

    const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
    const fakeRunner = async (command: string, args: string[], timeoutMs?: number): Promise<QuietCommandResult> => {
      calls.push({ command, args, timeoutMs });
      return { exitCode: 0, output: JSON.stringify({ loggedIn: true }) };
    };
    const probes = await api.captureClaudeAuthStatusProbes({
      claudeBin: FAKE_CLAUDE_BIN,
      uid: FAKE_UID,
      timeoutMs: 1234,
      runCommand: fakeRunner,
    });
    const interactive = probes.filter((probe) => probe.context === "interactive-terminal");
    const launchctl = probes.filter((probe) => probe.context === "launchctl-asuser");

    expect(interactive).toHaveLength(3);
    expect(launchctl).toHaveLength(3);
    // The probe only returns safe diagnostics; it never exposes auth output.
    const allowedProbeKeys = [
      "context",
      "status",
      "exitCode",
      "terminalIoctlFailure",
    ];
    expect(probes.every((probe) => Object.keys(probe).every((key) => allowedProbeKeys.includes(key)))).toBe(true);
    expect(interactive.every((probe) => probe.terminalIoctlFailure === false)).toBe(true);
    expect(probes.every((probe) => probe.status === "authenticated" || probe.status === "quota")).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls.filter((call) => call.command === FAKE_CLAUDE_BIN)).toHaveLength(3);
    expect(calls.filter((call) => call.command === "/bin/launchctl")).toHaveLength(3);
    expect(calls.every((call) => call.args.at(-2) === "auth" && call.args.at(-1) === "status")).toBe(true);
    expect(calls.every((call) => call.timeoutMs === 1234)).toBe(true);
    expect(calls.filter((call) => call.command === "/bin/launchctl").every((call) => call.args.slice(0, 4).join(" ") === `asuser ${FAKE_UID} ${FAKE_CLAUDE_BIN} auth`)).toBe(true);

    expect(summarizeClaudeAuthSnapshot({
      version: "scheduled-context-smoke",
      keychainScopes: { "user:inference": true, "user:profile": true },
      probes,
    })).toMatchObject({
      status: "pass",
      probeCounts: { "interactive-terminal": 3, "launchctl-asuser": 3 },
    });
  });
});
