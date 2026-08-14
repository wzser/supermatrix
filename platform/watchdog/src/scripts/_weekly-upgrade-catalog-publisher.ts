import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  ModelProbeStatus,
  ModelSurfaceSnapshot,
} from "./_weekly-upgrade-model-audit.js";

export const BACKEND_MODEL_EFFORT_PROBE_SCHEMA_VERSION = 1 as const;

export type BackendModelEffortBackend = "claude" | "codex" | "kimi";
export type BackendModelEffortProbeStatus = ModelProbeStatus | "unverified";

type ProbeEvidence = {
  kind: "live_probe" | "parser_probe" | "model_catalog";
  ref: string;
};

type EffortProbeItem = {
  id: string;
  probe_status: BackendModelEffortProbeStatus;
  detail?: string;
  evidence: ProbeEvidence;
};

type ModelProbeItem = EffortProbeItem & {
  successor?: string;
  efforts: EffortProbeItem[];
};

type BackendProbeItem = EffortProbeItem & {
  models: ModelProbeItem[];
};

export type BackendModelEffortProbeSnapshot = {
  snapshot: "backend_model_effort_probe";
  schema_version: typeof BACKEND_MODEL_EFFORT_PROBE_SCHEMA_VERSION;
  producer: "watchdog";
  run_id: string;
  observed_at: string;
  evidence_ref: string;
  source_catalog_revision: number;
  backends: BackendProbeItem[];
};

export type CatalogCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CatalogCommandRunner = (
  command: string,
  args: string[],
) => CatalogCommandResult;

export type CatalogSelectableModels = {
  revision: number;
  models: Record<BackendModelEffortBackend, string[]>;
};

export type CatalogPublishSuccess = {
  status: "updated" | "unchanged";
  snapshotPath: string;
  catalogRevision: number;
  receiptId?: string;
  catalogSha256: string;
  snapshotSha256: string;
};

export type CatalogPublishFailure = {
  status: "failed";
  snapshotPath: string;
  catalogRevision: number;
  reason: string;
};

export type CatalogPublishOutcome = CatalogPublishSuccess | CatalogPublishFailure;

export type CatalogModelProbeResult = {
  backend: BackendModelEffortBackend;
  target: string;
  status: ModelProbeStatus;
  detail?: string;
};

export type CatalogEffortProbeResult = {
  backend: BackendModelEffortBackend;
  model: string;
  effort: string;
  status: ModelProbeStatus;
  detail?: string;
};

type ClaudeEffortProbe = {
  effort: string;
  status: ModelProbeStatus;
  detail?: string;
};

type ExtendedModelSurface = ModelSurfaceSnapshot & {
  claude: ModelSurfaceSnapshot["claude"] & {
    effortProbes?: ClaudeEffortProbe[];
  };
  kimi: {
    models: Array<ModelSurfaceSnapshot["kimi"]["models"][number] & {
      supportedEfforts?: string[];
      defaultEffort?: string | null;
    }>;
    error?: string;
  };
};

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim()).map((value) => value.trim()))]
    .sort((left, right) => left.localeCompare(right));
}

function defaultCatalogCommandRunner(command: string, args: string[]): CatalogCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function commandError(result: CatalogCommandResult): string {
  return `${result.stderr}\n${result.stdout}\n${result.error ?? ""}`
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function readCatalogSelectableModels(input: {
  catalogBin: string;
  run?: CatalogCommandRunner;
}): CatalogSelectableModels {
  const run = input.run ?? defaultCatalogCommandRunner;
  const models = {} as Record<BackendModelEffortBackend, string[]>;
  const revisions = new Set<number>();
  for (const backend of ["claude", "codex", "kimi"] as const) {
    const result = run(input.catalogBin, [
      "show",
      "--dimension", "model",
      "--include-provisional",
      "--backend", backend,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`catalog show failed for ${backend}: ${commandError(result) || `exit ${result.exitCode}`}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`catalog show returned invalid JSON for ${backend}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`catalog show returned a non-object for ${backend}`);
    }
    const envelope = parsed as Record<string, unknown>;
    const revision = envelope["catalog_revision"];
    const values = envelope["values"];
    if (
      envelope["status"] !== "ok"
      || envelope["dimension"] !== "model"
      || envelope["backend"] !== backend
      || typeof revision !== "number"
      || !Number.isInteger(revision)
      || revision < 1
      || !Array.isArray(values)
      || !values.every((value) => typeof value === "string" && value.trim())
    ) {
      throw new Error(`catalog show returned an invalid model envelope for ${backend}`);
    }
    revisions.add(revision);
    models[backend] = uniqueSorted(values as string[]);
  }
  if (revisions.size !== 1) {
    throw new Error("catalog revision changed while reading selectable models");
  }
  return { revision: [...revisions][0]!, models };
}

function writeSnapshotAtomically(
  snapshotPath: string,
  snapshot: BackendModelEffortProbeSnapshot,
): void {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    renameSync(temporaryPath, snapshotPath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function publishBackendModelEffortCatalog(input: {
  catalogBin: string;
  snapshotPath: string;
  snapshot: BackendModelEffortProbeSnapshot;
  run?: CatalogCommandRunner;
}): CatalogPublishOutcome {
  writeSnapshotAtomically(input.snapshotPath, input.snapshot);
  const result = (input.run ?? defaultCatalogCommandRunner)(input.catalogBin, [
    "publish",
    "--input", input.snapshotPath,
  ]);
  const failed = (reason: string): CatalogPublishFailure => ({
    status: "failed",
    snapshotPath: input.snapshotPath,
    catalogRevision: input.snapshot.source_catalog_revision,
    reason: reason.slice(0, 500),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (result.exitCode !== 0) {
    const publisherError = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["error"]
      : null;
    return failed(
      typeof publisherError === "string" && publisherError.trim()
        ? publisherError.trim()
        : commandError(result) || `catalog publisher exited ${result.exitCode}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failed("catalog publish returned invalid JSON or a non-object");
  }
  const envelope = parsed as Record<string, unknown>;
  const status = envelope["status"];
  const revision = envelope["revision"];
  const catalogSha256 = envelope["catalog_sha256"];
  const snapshotSha256 = envelope["snapshot_sha256"];
  const receiptId = envelope["receipt_id"];
  if (
    (status !== "updated" && status !== "unchanged")
    || typeof revision !== "number"
    || !Number.isInteger(revision)
    || revision < 1
    || typeof catalogSha256 !== "string"
    || typeof snapshotSha256 !== "string"
    || (receiptId !== undefined && typeof receiptId !== "string")
  ) {
    const publisherError = envelope["error"];
    return failed(
      typeof publisherError === "string" && publisherError.trim()
        ? publisherError.trim()
        : "catalog publish returned an invalid success envelope",
    );
  }
  return {
    status,
    snapshotPath: input.snapshotPath,
    catalogRevision: revision,
    ...(receiptId ? { receiptId } : {}),
    catalogSha256,
    snapshotSha256,
  };
}

function evidenceRef(
  root: string,
  dimension: "backend" | "model" | "effort",
  backend: BackendModelEffortBackend,
  id: string,
): string {
  return `${root}#${dimension}:${backend}:${encodeURIComponent(id)}`;
}

function discoveredClaudeModels(modelHelp: string | null): string[] {
  return uniqueSorted(modelHelp?.match(/\bclaude-[a-z0-9]+(?:-[a-z0-9]+)+\b/giu) ?? []);
}

function modelStatus(
  backend: BackendModelEffortBackend,
  model: string,
  probes: Map<string, CatalogModelProbeResult>,
): { status: BackendModelEffortProbeStatus; detail?: string; evidenceKind: ProbeEvidence["kind"] } {
  const probe = probes.get(`${backend}\0${model}`);
  return probe
    ? { status: probe.status, ...(probe.detail ? { detail: probe.detail } : {}), evidenceKind: "live_probe" }
    : { status: "unverified", evidenceKind: "model_catalog" };
}

function effortStatus(
  backend: BackendModelEffortBackend,
  model: string,
  effort: string,
  probes: Map<string, CatalogEffortProbeResult>,
): { status: BackendModelEffortProbeStatus; detail?: string; evidenceKind: ProbeEvidence["kind"] } {
  const probe = probes.get(`${backend}\0${model}\0${effort}`);
  return probe
    ? { status: probe.status, ...(probe.detail ? { detail: probe.detail } : {}), evidenceKind: "live_probe" }
    : { status: "unverified", evidenceKind: "model_catalog" };
}

function backendStatus(models: ModelProbeItem[]): BackendModelEffortProbeStatus {
  const statuses = new Set(models.map((model) => model.probe_status));
  if (statuses.has("available")) return "available";
  if (statuses.has("transient")) return "transient";
  if (statuses.has("error")) return "error";
  if (statuses.has("unverified")) return "unverified";
  return statuses.has("unavailable") ? "unavailable" : "unverified";
}

export function buildBackendModelEffortProbeSnapshot(input: {
  runId: string;
  observedAt: string;
  evidenceRef: string;
  catalogRevision: number;
  catalogModels: Record<BackendModelEffortBackend, string[]>;
  modelSurface: ModelSurfaceSnapshot;
  modelProbes: CatalogModelProbeResult[];
  effortProbes?: CatalogEffortProbeResult[];
}): BackendModelEffortProbeSnapshot {
  const surface = input.modelSurface as ExtendedModelSurface;
  const probes = new Map(
    input.modelProbes.map((probe) => [`${probe.backend}\0${probe.target}`, probe]),
  );
  const effortProbes = new Map(
    (input.effortProbes ?? []).map((probe) => [
      `${probe.backend}\0${probe.model}\0${probe.effort}`,
      probe,
    ]),
  );
  const surfaceModels: Record<BackendModelEffortBackend, string[]> = {
    claude: discoveredClaudeModels(surface.claude.modelHelp),
    codex: surface.codex.models.map((model) => model.slug),
    kimi: surface.kimi.models.map((model) => model.id),
  };
  const codexById = new Map(surface.codex.models.map((model) => [model.slug, model]));
  const kimiById = new Map(surface.kimi.models.map((model) => [model.id, model]));
  const claudeEfforts = surface.claude.effortProbes
    ?? surface.claude.acceptedEfforts.map((effort) => ({ effort, status: "available" as const }));

  const backends = (["claude", "codex", "kimi"] as const).map((backend): BackendProbeItem => {
    const models = uniqueSorted([
      ...input.catalogModels[backend],
      ...surfaceModels[backend],
    ]).map((id): ModelProbeItem => {
      const status = modelStatus(backend, id, probes);
      let efforts: EffortProbeItem[];
      if (backend === "claude") {
        efforts = [...claudeEfforts]
          .sort((left, right) => left.effort.localeCompare(right.effort))
          .map((probe) => ({
            id: probe.effort,
            probe_status: probe.status,
            ...(probe.detail ? { detail: probe.detail } : {}),
            evidence: {
              kind: "parser_probe",
              ref: evidenceRef(input.evidenceRef, "effort", backend, `${id}:${probe.effort}`),
            },
          }));
      } else {
        const discoveredEfforts = backend === "codex"
          ? codexById.get(id)?.reasoningEfforts ?? []
          : kimiById.get(id)?.supportedEfforts ?? [];
        efforts = uniqueSorted(discoveredEfforts).map((effort) => {
          const status = effortStatus(backend, id, effort, effortProbes);
          return {
            id: effort,
            probe_status: status.status,
            ...(status.detail ? { detail: status.detail } : {}),
            evidence: {
              kind: status.evidenceKind,
              ref: evidenceRef(input.evidenceRef, "effort", backend, `${id}:${effort}`),
            },
          };
        });
      }
      const successor = backend === "codex" ? codexById.get(id)?.upgradeModel : null;
      return {
        id,
        probe_status: status.status,
        ...(status.detail ? { detail: status.detail } : {}),
        evidence: {
          kind: status.evidenceKind,
          ref: evidenceRef(input.evidenceRef, "model", backend, id),
        },
        ...(successor ? { successor } : {}),
        efforts,
      };
    });
    const status = backendStatus(models);
    return {
      id: backend,
      probe_status: status,
      evidence: {
        kind: status === "unverified" ? "model_catalog" : "live_probe",
        ref: evidenceRef(input.evidenceRef, "backend", backend, backend),
      },
      models,
    };
  });

  return {
    snapshot: "backend_model_effort_probe",
    schema_version: BACKEND_MODEL_EFFORT_PROBE_SCHEMA_VERSION,
    producer: "watchdog",
    run_id: input.runId,
    observed_at: input.observedAt,
    evidence_ref: input.evidenceRef,
    source_catalog_revision: input.catalogRevision,
    backends,
  };
}
