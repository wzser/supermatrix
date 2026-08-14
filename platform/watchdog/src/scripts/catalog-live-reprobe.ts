import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractYoloCatalogProbeTargets } from "./_catalog-live-reprobe-targets.js";
import {
  captureModelSurface,
  runCatalogModelProbes,
  runCodexEffortProbes,
  type ModelProbeCommandResult,
  type ModelProbeResult,
  type ModelProbeStatus,
} from "./_weekly-upgrade-model-audit.js";
import {
  buildBackendModelEffortProbeSnapshot,
  publishBackendModelEffortCatalog,
  readCatalogSelectableModels,
  type CatalogEffortProbeResult,
} from "./_weekly-upgrade-catalog-publisher.js";

const CLAUDE_BIN = "/Users/LOCAL_USER/.local/bin/claude";
const CODEX_BIN = "/Users/LOCAL_USER/.npm-global/bin/codex";
const KIMI_BIN = process.env["SM_KIMI_CLI_PATH"]?.trim() || "/Users/LOCAL_USER/.kimi-code/bin/kimi";
const SUPERMATRIX_DIR = "/Users/LOCAL_USER/SuperMatrix";
const CATALOG_BIN = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/backend-model-effort-catalog";
const YOLO_ROUTING_PATH = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/yolo/engine/references/task-model-routing.json";
const EVIDENCE_DIR = join(process.cwd(), "data", "model-audit");

type ProbeBackend = "claude" | "codex" | "kimi";

type CapturedProbe = {
  sequence: number;
  backend: ProbeBackend;
  target: string;
  effort?: string;
  executable: string;
  args: string[];
  exit_code: number | null;
  signal: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
  probe_token_seen: boolean;
  transport_error: string | null;
  probe_status?: ModelProbeStatus;
  probe_detail?: string | null;
};

type CatalogEnvelope = {
  status: "valid";
  revision: number;
  catalog_sha256: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJsonAtomically(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function argumentValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function backendFor(command: string): ProbeBackend {
  if (command === CLAUDE_BIN) return "claude";
  if (command === CODEX_BIN) return "codex";
  if (command === KIMI_BIN) return "kimi";
  throw new Error(`unexpected catalog probe executable: ${command}`);
}

function effortFor(args: string[]): string | undefined {
  const config = argumentValue(args, "-c") ?? argumentValue(args, "--config");
  const match = config?.match(/^model_reasoning_effort=(.+)$/);
  return match?.[1];
}

function createRecordingRunner(records: CapturedProbe[]) {
  return (
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ): ModelProbeCommandResult => {
    const run = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const target = argumentValue(args, "--model");
    if (!target) throw new Error(`catalog probe omitted --model: ${command}`);
    records.push({
      sequence: records.length + 1,
      backend: backendFor(command),
      target,
      ...(effortFor(args) ? { effort: effortFor(args) } : {}),
      executable: command,
      args,
      exit_code: run.status,
      signal: run.signal ?? null,
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      probe_token_seen: `${stdout}\n${stderr}`.includes("WEEKLY_MODEL_PROBE_OK"),
      transport_error: run.error?.message ?? null,
    });
    return {
      exitCode: run.status,
      stdout,
      stderr,
      ...(run.error ? { error: run.error.message } : {}),
    };
  };
}

function annotateModelProbes(records: CapturedProbe[], probes: ModelProbeResult[]): void {
  const byKey = new Map(probes.map((probe) => [`${probe.backend}\0${probe.target}`, probe]));
  for (const record of records) {
    const probe = byKey.get(`${record.backend}\0${record.target}`);
    if (!probe) throw new Error(`missing classification for ${record.backend}:${record.target}`);
    record.probe_status = probe.status;
    record.probe_detail = probe.detail ?? null;
  }
}

function annotateEffortProbes(
  records: CapturedProbe[],
  probes: ReturnType<typeof runCodexEffortProbes>,
): void {
  const byKey = new Map(probes.map((probe) => [`${probe.target}\0${probe.effort}`, probe]));
  for (const record of records) {
    const probe = byKey.get(`${record.target}\0${record.effort ?? ""}`);
    if (!probe) throw new Error(`missing effort classification for ${record.target}:${record.effort ?? ""}`);
    record.probe_status = probe.status;
    record.probe_detail = probe.detail ?? null;
  }
}

function readCatalogEnvelope(): CatalogEnvelope {
  const run = spawnSync(CATALOG_BIN, ["validate"], {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.status !== 0) {
    throw new Error(`catalog validate failed: ${`${run.stderr ?? ""}\n${run.stdout ?? ""}`.trim().slice(0, 240)}`);
  }
  const parsed: unknown = JSON.parse(run.stdout ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("catalog validate returned invalid JSON");
  }
  const result = parsed as Partial<CatalogEnvelope>;
  if (
    result.status !== "valid"
    || !Number.isInteger(result.revision)
    || typeof result.catalog_sha256 !== "string"
  ) {
    throw new Error("catalog validate returned an invalid success envelope");
  }
  return result as CatalogEnvelope;
}

function statusCounts(snapshot: ReturnType<typeof buildBackendModelEffortProbeSnapshot>): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {
    backend: {},
    model: {},
    effort: {},
  };
  const increment = (dimension: "backend" | "model" | "effort", status: string) => {
    counts[dimension][status] = (counts[dimension][status] ?? 0) + 1;
  };
  for (const backend of snapshot.backends) {
    increment("backend", backend.probe_status);
    for (const model of backend.models) {
      increment("model", model.probe_status);
      for (const effort of model.efforts) increment("effort", effort.probe_status);
    }
  }
  return counts;
}

function catalogShow(dimension: "model" | "effort"): string[] {
  const run = spawnSync(CATALOG_BIN, ["show", "--dimension", dimension], {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.status !== 0) throw new Error(`catalog show failed for ${dimension}`);
  const parsed: unknown = JSON.parse(run.stdout ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`catalog show returned invalid JSON for ${dimension}`);
  }
  const values = (parsed as { values?: unknown }).values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error(`catalog show returned invalid values for ${dimension}`);
  }
  return values;
}

function main(): void {
  const observedAt = new Date().toISOString();
  const stamp = observedAt.replace(/[-:.]/g, "").replace("Z", "Z");
  const runId = `catalog-live-reprobe-${stamp}`;
  const snapshotPath = join(EVIDENCE_DIR, `backend-model-effort-probe-${runId}.json`);
  const evidencePath = join(EVIDENCE_DIR, `backend-model-effort-probe-${runId}.evidence.json`);
  const preflight = readCatalogEnvelope();
  const catalogModels = readCatalogSelectableModels({ catalogBin: CATALOG_BIN });
  if (catalogModels.revision !== preflight.revision) {
    throw new Error("catalog revision changed while reading live probe candidates");
  }
  const routingSource = readFileSync(YOLO_ROUTING_PATH, "utf-8");
  const referencedTargets = extractYoloCatalogProbeTargets(JSON.parse(routingSource));
  if (referencedTargets.routeCount !== 66) {
    throw new Error(`YOLO routing row count changed: expected 66, got ${referencedTargets.routeCount}`);
  }
  const missingReferencedCatalogModels = (["claude", "codex", "kimi"] as const)
    .flatMap((backend) => referencedTargets.models[backend]
      .filter((model) => !catalogModels.models[backend].includes(model))
      .map((model) => ({ backend, model })));
  if (missingReferencedCatalogModels.length > 0) {
    throw new Error(`YOLO referenced models are absent from catalog discovery: ${missingReferencedCatalogModels
      .map((item) => `${item.backend}:${item.model}`)
      .join(", ")}`);
  }

  const modelSurface = captureModelSurface({
    claudeBin: CLAUDE_BIN,
    codexBin: CODEX_BIN,
    kimiBin: KIMI_BIN,
  });
  if (modelSurface.claude.error || modelSurface.codex.error || modelSurface.kimi.error) {
    throw new Error(`model surface capture incomplete: ${[
      modelSurface.claude.error,
      modelSurface.codex.error,
      modelSurface.kimi.error,
    ].filter(Boolean).join("; ")}`);
  }

  const modelCalls: CapturedProbe[] = [];
  const modelProbes = runCatalogModelProbes({
    catalogModels: referencedTargets.models,
    claudeBin: CLAUDE_BIN,
    codexBin: CODEX_BIN,
    kimiBin: KIMI_BIN,
    supermatrixDir: SUPERMATRIX_DIR,
    run: createRecordingRunner(modelCalls),
  });
  annotateModelProbes(modelCalls, modelProbes);

  const codexEffortTargets = referencedTargets.effortParentChains.codex
    .map((chain) => ({ target: chain.model, efforts: chain.efforts }));
  const codexSurfaceByModel = new Map(modelSurface.codex.models.map((model) => [model.slug, model]));
  const missingCodexSurfaceModels = referencedTargets.models.codex
    .filter((model) => !codexSurfaceByModel.has(model));
  const unsupportedCodexEffortChains = codexEffortTargets.flatMap((target) => {
    const supported = new Set(codexSurfaceByModel.get(target.target)?.reasoningEfforts ?? []);
    return target.efforts
      .filter((effort) => !supported.has(effort))
      .map((effort) => ({ model: target.target, effort }));
  });
  const effortCalls: CapturedProbe[] = [];
  const effortProbes = runCodexEffortProbes({
    targets: codexEffortTargets,
    codexBin: CODEX_BIN,
    supermatrixDir: SUPERMATRIX_DIR,
    run: createRecordingRunner(effortCalls),
  });
  annotateEffortProbes(effortCalls, effortProbes);

  const claudeParserByEffort = new Map(
    modelSurface.claude.effortProbes.map((probe) => [probe.effort, probe]),
  );
  const claudeEffortFailures = referencedTargets.effortParentChains.claude.flatMap((chain) =>
    chain.efforts.flatMap((effort) => {
      const probe = claudeParserByEffort.get(effort);
      return probe?.status === "available"
        ? []
        : [{ model: chain.model, effort, status: probe?.status ?? "unverified", detail: probe?.detail ?? null }];
    })
  );
  const unsupportedKimiEffortChains = referencedTargets.effortParentChains.kimi;

  const snapshot = buildBackendModelEffortProbeSnapshot({
    runId,
    observedAt,
    evidenceRef: evidencePath,
    catalogRevision: catalogModels.revision,
    catalogModels: catalogModels.models,
    modelSurface,
    modelProbes,
    effortProbes: effortProbes.map<CatalogEffortProbeResult>((probe) => ({
      backend: probe.backend,
      model: probe.target,
      effort: probe.effort,
      status: probe.status,
      ...(probe.detail ? { detail: probe.detail } : {}),
    })),
  });

  const modelFailures = modelProbes.filter((probe) => probe.status !== "available");
  const effortFailures = effortProbes.filter((probe) => probe.status !== "available");
  const completionPassed = modelFailures.length === 0
    && effortFailures.length === 0
    && claudeEffortFailures.length === 0
    && missingCodexSurfaceModels.length === 0
    && unsupportedCodexEffortChains.length === 0
    && unsupportedKimiEffortChains.length === 0;
  const deferredReprobe = completionPassed ? null : {
    status: "deferred_reprobe",
    migration_state: "frozen",
    retry_command: "npx tsx src/scripts/catalog-live-reprobe.ts",
    retry_against_catalog_revision: preflight.revision,
    retry_against_catalog_sha256: preflight.catalog_sha256,
    conditions: [
      ...(modelFailures.length > 0
        ? ["retry after each failed or transient referenced model has execution capacity"]
        : []),
      ...(effortFailures.length > 0
        ? ["retry each failed or transient referenced Codex model-effort chain"]
        : []),
      ...(claudeEffortFailures.length > 0
        ? ["retry after the referenced Claude effort parser surface is conclusive"]
        : []),
      ...(missingCodexSurfaceModels.length > 0 || unsupportedCodexEffortChains.length > 0
        ? ["retry after the Codex bundled surface contains every referenced model-effort chain"]
        : []),
      ...(unsupportedKimiEffortChains.length > 0
        ? ["define a live/parser probe contract before using a non-default Kimi effort"]
        : []),
    ],
    resume_requires: [
      "a newer publisher-accepted snapshot with live_probe evidence for every referenced model",
      "available effort evidence on every exact referenced parent chain",
      "fresh catalog revision/hash preflight before any separately authorized schema migration",
    ],
  };
  const evidence = {
    evidence: "backend_model_effort_live_reprobe",
    schema_version: 1,
    producer: "watchdog",
    run_id: runId,
    observed_at: observedAt,
    scope: {
      asset_id: "yolo.task-model-routing",
      routing_path: YOLO_ROUTING_PATH,
      routing_sha256: sha256(routingSource),
      routing_row_count: referencedTargets.routeCount,
      catalog_revision: preflight.revision,
      catalog_sha256: preflight.catalog_sha256,
      remote_schema_writes: 0,
      remote_yolo_row_writes: 0,
      registry_writes: 0,
      schema_runner_dispatches: 0,
      publisher: CATALOG_BIN,
    },
    candidates: {
      models: referencedTargets.models,
      effort_parent_chains: referencedTargets.effortParentChains,
      control_efforts: referencedTargets.controlEfforts,
      codex_effort_parent_chains: codexEffortTargets,
      missing_codex_surface_models: missingCodexSurfaceModels,
      unsupported_codex_effort_chains: unsupportedCodexEffortChains,
      unsupported_kimi_effort_chains: unsupportedKimiEffortChains,
    },
    cli_binaries: {
      claude: CLAUDE_BIN,
      codex: CODEX_BIN,
      kimi: KIMI_BIN,
    },
    captured_model_surface: modelSurface,
    model_call_results: modelCalls,
    codex_effort_call_results: effortCalls,
    snapshot_path: snapshotPath,
    status_counts: statusCounts(snapshot),
    completion_gate: {
      model_failures: modelFailures,
      effort_failures: effortFailures,
      claude_effort_failures: claudeEffortFailures,
      missing_codex_surface_models: missingCodexSurfaceModels,
      unsupported_codex_effort_chains: unsupportedCodexEffortChains,
      unsupported_kimi_effort_chains: unsupportedKimiEffortChains,
      passed: completionPassed,
    },
    deferred_reprobe: deferredReprobe,
  };
  writeJsonAtomically(evidencePath, evidence);

  const beforePublish = readCatalogEnvelope();
  if (
    beforePublish.revision !== preflight.revision
    || beforePublish.catalog_sha256 !== preflight.catalog_sha256
  ) {
    throw new Error("catalog changed during live reprobe; refusing to publish against a moved baseline");
  }
  const publish = publishBackendModelEffortCatalog({
    catalogBin: CATALOG_BIN,
    snapshotPath,
    snapshot,
  });
  if (publish.status === "failed") {
    throw new Error(`catalog publisher rejected probe snapshot: ${publish.reason}`);
  }
  const readback = readCatalogEnvelope();
  const finalEvidence = {
    ...evidence,
    catalog_publish: publish,
    catalog_readback: {
      revision: readback.revision,
      catalog_sha256: readback.catalog_sha256,
      available_models: catalogShow("model"),
      available_efforts: catalogShow("effort"),
      snapshot_file_sha256: sha256(readFileSync(snapshotPath, "utf-8")),
    },
  };
  writeJsonAtomically(evidencePath, finalEvidence);
  console.log(JSON.stringify({
    status: completionPassed ? publish.status : "deferred",
    catalog_publish_status: publish.status,
    run_id: runId,
    snapshot_path: snapshotPath,
    evidence_path: evidencePath,
    catalog_revision: readback.revision,
    catalog_sha256: readback.catalog_sha256,
    receipt_id: publish.receiptId ?? null,
    model_probe_count: modelProbes.length,
    codex_effort_probe_count: effortProbes.length,
    completion_proven: completionPassed,
    deferred_reprobe: deferredReprobe,
  }, null, 2));
  if (!completionPassed) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
