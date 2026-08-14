import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateCardAskGate,
  writeCardAskGateAtomic,
} from "../../src/app/cardAskGate.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_1"),
    name: "carddemo",
    alias: "",
    avatar: "",
    category: "工具",
    fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/carddemo"),
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
    ...overrides,
  };
}

describe("evaluateCardAskGate", () => {
  it("enables only matching session/category/backend entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "card-ask-gate-"));
    try {
      const gatePath = join(dir, "card-ask-gate.json");
      await writeFile(gatePath, JSON.stringify({
        sessions: ["carddemo"],
        categories: ["工具"],
        excludeSessions: ["blocked-session"],
        excludeCategories: ["外部"],
        backends: ["claude", "codex"],
      }));

      await expect(evaluateCardAskGate({
        gatePath,
        session: makeSession({ name: "carddemo", backend: "claude" }),
        backend: "claude",
      })).resolves.toEqual({ enabled: true });

      await expect(evaluateCardAskGate({
        gatePath,
        session: makeSession({ name: "carddemo", backend: "kimi" }),
        backend: "kimi",
      })).resolves.toEqual({ enabled: false });

      await expect(evaluateCardAskGate({
        gatePath,
        session: makeSession({ name: "blocked-session", backend: "claude" }),
        backend: "claude",
      })).resolves.toEqual({ enabled: false });

      await expect(evaluateCardAskGate({
        gatePath,
        session: makeSession({ name: "other", category: "外部", backend: "claude" }),
        backend: "claude",
      })).resolves.toEqual({ enabled: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on missing or invalid gate files and warns instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "card-ask-gate-bad-"));
    try {
      const warnings: string[] = [];
      const missingPath = join(dir, "missing.json");
      await expect(evaluateCardAskGate({
        gatePath: missingPath,
        session: makeSession(),
        backend: "claude",
        logger: { warn: (message) => warnings.push(message) },
      })).resolves.toEqual({ enabled: false });

      const badPath = join(dir, "bad.json");
      await writeFile(badPath, "{not-json");
      await expect(evaluateCardAskGate({
        gatePath: badPath,
        session: makeSession(),
        backend: "claude",
        logger: { warn: (message) => warnings.push(message) },
      })).resolves.toEqual({ enabled: false });

      expect(warnings.length).toBeGreaterThanOrEqual(2);
      expect(warnings.join("\n")).toContain("card ask gate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes gate updates with tmp plus rename semantics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "card-ask-gate-write-"));
    try {
      const gatePath = join(dir, "card-ask-gate.json");
      await writeCardAskGateAtomic(gatePath, {
        sessions: ["carddemo"],
        categories: [],
        excludeSessions: [],
        excludeCategories: [],
        backends: ["codex"],
      });

      const parsed = JSON.parse(await readFile(gatePath, "utf8")) as {
        sessions: string[];
        backends: string[];
      };
      expect(parsed.sessions).toEqual(["carddemo"]);
      expect(parsed.backends).toEqual(["codex"]);

      await expect(rename(`${gatePath}.tmp`, join(dir, "leftover"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
