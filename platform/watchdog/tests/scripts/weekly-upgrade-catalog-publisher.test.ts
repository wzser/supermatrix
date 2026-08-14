import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelSurfaceSnapshot } from "../../src/scripts/_weekly-upgrade-model-audit.js";
import * as catalogPublisher from "../../src/scripts/_weekly-upgrade-catalog-publisher.js";

describe("weekly upgrade backend model effort catalog publisher", () => {
  it("wires the local catalog publisher into do/receipt/report and retires direct Feishu enum writes", () => {
    const doSource = readFileSync("src/scripts/weekly-upgrade.ts", "utf-8");
    const reportSource = readFileSync("src/scripts/weekly-upgrade-report.ts", "utf-8");
    const sharedSource = readFileSync("src/scripts/_weekly-upgrade-shared.ts", "utf-8");
    const modelAuditSource = readFileSync("src/scripts/_weekly-upgrade-model-audit.ts", "utf-8");
    const checklist = readFileSync("docs/weekly-cli-upgrade-checklist.md", "utf-8");

    expect(doSource).toContain("/wendangwang/bin/backend-model-effort-catalog");
    expect(doSource).toContain("readCatalogSelectableModels");
    expect(doSource).toContain("runCatalogModelProbes");
    expect(doSource).toContain("runCodexEffortProbes");
    expect(doSource).toContain("buildBackendModelEffortProbeSnapshot");
    expect(doSource).toContain("publishBackendModelEffortCatalog");
    expect(doSource).toContain("catalogPublish.status !== \"failed\"");
    expect(doSource).toContain("process.exitCode = 1");
    expect(doSource).toMatch(/writeReceipt\([\s\S]*catalogPublish/);
    expect(sharedSource).toContain("catalogPublish?: WeeklyCatalogPublishOutcome");
    expect(reportSource).toContain("pending.catalogPublish");
    expect(reportSource).toContain("catalog revision");
    expect(checklist).toContain("backend_model_effort_probe v1");
    expect(checklist).toContain("backend-model-effort-catalog publish --input");

    for (const productionSource of [doSource, reportSource]) {
      expect(productionSource).not.toContain("_weekly-upgrade-bitable-models");
      expect(productionSource).not.toContain("syncModelEnumAdditions");
      expect(productionSource).not.toContain("MODEL_ENUM_SYNC_VERSION");
      expect(productionSource).not.toContain("MODEL_ENUM_ADDITIONS");
    }
    expect(reportSource).not.toContain("LARK_BIN");
    expect(modelAuditSource).not.toContain("MODEL_ENUM_ADDITIONS");
  });

  it("keeps the targeted catalog reprobe local and publisher-only", () => {
    const reprobeSource = readFileSync("src/scripts/catalog-live-reprobe.ts", "utf-8");

    expect(reprobeSource).toContain("YOLO_ROUTING_PATH");
    expect(reprobeSource).toContain("extractYoloCatalogProbeTargets");
    expect(reprobeSource).toContain("routeCount !== 66");
    expect(reprobeSource).toContain("runCatalogModelProbes");
    expect(reprobeSource).toContain("catalogModels: referencedTargets.models");
    expect(reprobeSource).toContain("runCodexEffortProbes");
    expect(reprobeSource).toContain("referencedTargets.effortParentChains.codex");
    expect(reprobeSource).toContain("publishBackendModelEffortCatalog");
    expect(reprobeSource).toContain("deferred_reprobe");
    expect(reprobeSource).not.toContain("if (!evidence.completion_gate.passed)");
    expect(reprobeSource).toContain("remote_schema_writes: 0");
    expect(reprobeSource).toContain("remote_yolo_row_writes: 0");
    expect(reprobeSource).not.toContain("lark-cli");
    expect(reprobeSource).not.toContain("jianbiao");
  });

  it("returns a failed outcome with the prior revision when the local publisher rejects the snapshot", () => {
    const temporaryDir = mkdtempSync(join(tmpdir(), "watchdog-catalog-publish-failure-test-"));
    const snapshotPath = join(temporaryDir, "probe.json");
    const snapshot = {
      snapshot: "backend_model_effort_probe" as const,
      schema_version: 1 as const,
      producer: "watchdog" as const,
      run_id: "weekly-2026-08-04-failed",
      observed_at: "2026-08-04T08:06:00.000Z",
      evidence_ref: "watchdog://weekly-cli-upgrade/2026-08-04/model-audit",
      source_catalog_revision: 12,
      backends: [],
    };

    try {
      const outcome = catalogPublisher.publishBackendModelEffortCatalog({
        catalogBin: "/opt/wendangwang/backend-model-effort-catalog",
        snapshotPath,
        snapshot,
        run: () => ({
          exitCode: 1,
          stdout: JSON.stringify({ status: "error", error: "available model requires live_probe evidence" }),
          stderr: "",
        }),
      });

      expect(outcome).toEqual({
        status: "failed",
        snapshotPath,
        catalogRevision: 12,
        reason: "available model requires live_probe evidence",
      });
      expect(JSON.parse(readFileSync(snapshotPath, "utf-8"))).toEqual(snapshot);
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it("atomically writes the snapshot and returns the local publisher receipt", () => {
    const publish = (catalogPublisher as Record<string, unknown>)["publishBackendModelEffortCatalog"];
    const temporaryDir = mkdtempSync(join(tmpdir(), "watchdog-catalog-publish-test-"));
    const snapshotPath = join(temporaryDir, "probe.json");
    const snapshot = {
      snapshot: "backend_model_effort_probe",
      schema_version: 1,
      producer: "watchdog",
      run_id: "weekly-2026-08-04-5678",
      observed_at: "2026-08-04T08:05:00.000Z",
      evidence_ref: "watchdog://weekly-cli-upgrade/2026-08-04/model-audit",
      source_catalog_revision: 12,
      backends: [],
    };

    try {
      expect(publish).toBeTypeOf("function");
      const outcome = (publish as Function)({
        catalogBin: "/opt/wendangwang/backend-model-effort-catalog",
        snapshotPath,
        snapshot,
        run: (command: string, args: string[]) => {
          expect(command).toBe("/opt/wendangwang/backend-model-effort-catalog");
          expect(args).toEqual(["publish", "--input", snapshotPath]);
          expect(JSON.parse(readFileSync(snapshotPath, "utf-8"))).toEqual(snapshot);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              status: "updated",
              revision: 13,
              receipt_id: "rcpt_catalog_13",
              catalog_sha256: "a".repeat(64),
              snapshot_sha256: "b".repeat(64),
            }),
            stderr: "",
          };
        },
      });

      expect(outcome).toEqual({
        status: "updated",
        snapshotPath,
        catalogRevision: 13,
        receiptId: "rcpt_catalog_13",
        catalogSha256: "a".repeat(64),
        snapshotSha256: "b".repeat(64),
      });
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  it("reads every backend's current selectable models from one catalog revision", () => {
    const readCatalog = (catalogPublisher as Record<string, unknown>)["readCatalogSelectableModels"];
    const calls: string[][] = [];

    expect(readCatalog).toBeTypeOf("function");
    const catalog = (readCatalog as Function)({
      catalogBin: "/opt/wendangwang/backend-model-effort-catalog",
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        const backend = args.at(-1)!;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "ok",
            dimension: "model",
            backend,
            values: [`${backend}-current-model`],
            catalog_revision: 12,
          }),
          stderr: "",
        };
      },
    });

    expect(catalog).toEqual({
      revision: 12,
      models: {
        claude: ["claude-current-model"],
        codex: ["codex-current-model"],
        kimi: ["kimi-current-model"],
      },
    });
    expect(calls).toEqual([
      ["/opt/wendangwang/backend-model-effort-catalog", "show", "--dimension", "model", "--include-provisional", "--backend", "claude"],
      ["/opt/wendangwang/backend-model-effort-catalog", "show", "--dimension", "model", "--include-provisional", "--backend", "codex"],
      ["/opt/wendangwang/backend-model-effort-catalog", "show", "--dimension", "model", "--include-provisional", "--backend", "kimi"],
    ]);
  });

  it("builds a complete v1 snapshot without overstating model or effort evidence", async () => {
    const publisher = await import("../../src/scripts/_weekly-upgrade-catalog-publisher.js").catch(() => null);

    expect(publisher).not.toBeNull();
    const snapshot = publisher!.buildBackendModelEffortProbeSnapshot({
      runId: "weekly-2026-08-04-1234",
      observedAt: "2026-08-04T08:00:00.000Z",
      evidenceRef: "watchdog://weekly-cli-upgrade/2026-08-04/model-audit",
      catalogRevision: 7,
      catalogModels: {
        claude: ["claude-opus-4-6"],
        codex: ["gpt-5.4", "gpt-5.5"],
        kimi: ["kimi-code/k3"],
      },
      modelSurface: {
        capturedAt: Date.parse("2026-08-04T08:00:00.000Z"),
        claude: {
          modelHelp: "Use a model's full name such as claude-opus-5.",
          effortHelp: "low, medium, high, xhigh, max",
          acceptedEfforts: ["low"],
          effortProbes: [
            { effort: "low", status: "available" },
            { effort: "ultracode", status: "unavailable" },
          ],
        },
        codex: {
          models: [
            {
              slug: "gpt-5.5",
              visibility: "list",
              supportedInApi: true,
              reasoningEfforts: ["low", "high"],
              upgradeModel: null,
            },
            {
              slug: "gpt-5.7-sol",
              visibility: "list",
              supportedInApi: true,
              reasoningEfforts: ["low", "ultra"],
              upgradeModel: null,
            },
          ],
        },
        kimi: {
          models: [
            {
              id: "kimi-code/k3",
              provider: "managed:kimi-code",
              model: "k3",
              displayName: "K3",
              capabilities: ["thinking"],
              supportedEfforts: ["low", "high", "max"],
              defaultEffort: "high",
            },
            {
              id: "kimi-code/k4",
              provider: "managed:kimi-code",
              model: "k4",
              displayName: "K4",
              capabilities: ["thinking"],
              supportedEfforts: ["high"],
              defaultEffort: "high",
            },
          ],
        },
      } as unknown as ModelSurfaceSnapshot,
      modelProbes: [
        { backend: "claude", target: "claude-opus-4-6", status: "available", detail: "live model probe ok" },
        { backend: "codex", target: "gpt-5.4", status: "unavailable", detail: "unknown model" },
        { backend: "codex", target: "gpt-5.5", status: "transient", detail: "429 rate limit" },
        { backend: "kimi", target: "kimi-code/k3", status: "available" },
      ],
      effortProbes: [
        { backend: "codex", model: "gpt-5.5", effort: "high", status: "available" },
        { backend: "codex", model: "gpt-5.5", effort: "low", status: "transient", detail: "429 rate limit" },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshot: "backend_model_effort_probe",
      schema_version: 1,
      producer: "watchdog",
      run_id: "weekly-2026-08-04-1234",
      observed_at: "2026-08-04T08:00:00.000Z",
      evidence_ref: "watchdog://weekly-cli-upgrade/2026-08-04/model-audit",
      source_catalog_revision: 7,
    });
    const backends = new Map(snapshot.backends.map((backend: { id: string }) => [backend.id, backend]));
    const claude = backends.get("claude")!;
    const codex = backends.get("codex")!;
    const kimi = backends.get("kimi")!;
    expect(claude.probe_status).toBe("available");
    expect(codex.probe_status).toBe("transient");
    expect(kimi.probe_status).toBe("available");

    const claudeModels = new Map(claude.models.map((model: { id: string }) => [model.id, model]));
    expect([...claudeModels.keys()]).toEqual(["claude-opus-4-6", "claude-opus-5"]);
    expect(claudeModels.get("claude-opus-4-6")).toMatchObject({
      probe_status: "available",
      detail: "live model probe ok",
      evidence: { kind: "live_probe" },
    });
    expect(claudeModels.get("claude-opus-5")).toMatchObject({
      probe_status: "unverified",
      evidence: { kind: "model_catalog" },
    });
    expect(claudeModels.get("claude-opus-4-6")!.efforts).toEqual([
      expect.objectContaining({
        id: "low",
        probe_status: "available",
        evidence: expect.objectContaining({ kind: "parser_probe" }),
      }),
      expect.objectContaining({
        id: "ultracode",
        probe_status: "unavailable",
        evidence: expect.objectContaining({ kind: "parser_probe" }),
      }),
    ]);

    const codexModels = new Map(codex.models.map((model: { id: string }) => [model.id, model]));
    expect([...codexModels.keys()]).toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.7-sol"]);
    expect(codexModels.get("gpt-5.4")).toMatchObject({
      probe_status: "unavailable",
      evidence: { kind: "live_probe" },
    });
    expect(codexModels.get("gpt-5.5")).toMatchObject({
      probe_status: "transient",
      evidence: { kind: "live_probe" },
    });
    expect(codexModels.get("gpt-5.7-sol")).toMatchObject({
      probe_status: "unverified",
      evidence: { kind: "model_catalog" },
    });
    expect(codexModels.get("gpt-5.5")!.efforts).toEqual([
      expect.objectContaining({ id: "high", probe_status: "available", evidence: { kind: "live_probe", ref: expect.any(String) } }),
      expect.objectContaining({ id: "low", probe_status: "transient", detail: "429 rate limit", evidence: { kind: "live_probe", ref: expect.any(String) } }),
    ]);

    const kimiModels = new Map(kimi.models.map((model: { id: string }) => [model.id, model]));
    expect([...kimiModels.keys()]).toEqual(["kimi-code/k3", "kimi-code/k4"]);
    expect(kimiModels.get("kimi-code/k3")).toMatchObject({
      probe_status: "available",
      evidence: { kind: "live_probe" },
    });
    expect(kimiModels.get("kimi-code/k4")).toMatchObject({
      probe_status: "unverified",
      evidence: { kind: "model_catalog" },
    });
    expect(kimiModels.get("kimi-code/k3")!.efforts).toEqual([
      expect.objectContaining({ id: "high", probe_status: "unverified" }),
      expect.objectContaining({ id: "low", probe_status: "unverified" }),
      expect.objectContaining({ id: "max", probe_status: "unverified" }),
    ]);
  });
});
