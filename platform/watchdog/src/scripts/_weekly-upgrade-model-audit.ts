import { spawnSync } from "node:child_process";

export const MODEL_PROBE_TOKEN = "WEEKLY_MODEL_PROBE_OK";
export const CLAUDE_BTW_TARGET = "sonnet";
export const CODEX_BTW_TARGET = "gpt-5.5";
export const CLAUDE_EFFORT_CANDIDATES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;

export type CodexModelSurface = {
  slug: string;
  visibility: string;
  supportedInApi: boolean;
  reasoningEfforts: string[];
  upgradeModel: string | null;
};

export type KimiModelSurface = {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  capabilities: string[];
  supportedEfforts: string[];
  defaultEffort: string | null;
};

export type ModelSurfaceSnapshot = {
  capturedAt: number;
  claude: {
    modelHelp: string | null;
    effortHelp: string | null;
    acceptedEfforts: string[];
    effortProbes: ClaudeEffortParserProbe[];
    error?: string;
  };
  codex: {
    models: CodexModelSurface[];
    error?: string;
  };
  kimi: {
    models: KimiModelSurface[];
    error?: string;
  };
};

export type ModelSurfaceDiff = {
  changed: boolean;
  claudeModelHelpChanged: boolean;
  claudeEffortHelpChanged: boolean;
  claudeAcceptedEffortsChanged: boolean;
  codexAdded: string[];
  codexRemoved: string[];
  codexChanged: string[];
  kimiAdded: string[];
  kimiRemoved: string[];
  kimiChanged: string[];
};

export type ModelProbeStatus = "available" | "transient" | "unavailable" | "error";
export type ModelProbeBackend = "claude" | "codex" | "kimi";

export type ClaudeEffortParserProbe = {
  effort: string;
  status: ModelProbeStatus;
  detail?: string;
};

export type ModelProbeResult = {
  backend: ModelProbeBackend;
  target: string;
  status: ModelProbeStatus;
  detail?: string;
};

export type ModelProbeCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type ModelProbeCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => ModelProbeCommandResult;

export type WeeklyModelAudit = {
  before: ModelSurfaceSnapshot;
  after: ModelSurfaceSnapshot;
  diff: ModelSurfaceDiff;
  probes: ModelProbeResult[];
  compatibilityAdjustmentReasons: string[];
  requiresReview: boolean;
  requiresAdjustment: boolean;
};

type CodexCatalogRecord = {
  slug?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  supported_reasoning_levels?: unknown;
  upgrade?: unknown;
};

type KimiProviderCatalogRecord = {
  provider?: unknown;
  model?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  capabilities?: unknown;
  supportEfforts?: unknown;
  defaultEffort?: unknown;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}

export function parseCodexBundledCatalog(raw: string): CodexModelSurface[] {
  const parsed = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error("Codex bundled catalog has no models array");

  return parsed.models.flatMap((value): CodexModelSurface[] => {
    if (!value || typeof value !== "object") return [];
    const model = value as CodexCatalogRecord;
    if (typeof model.slug !== "string" || !model.slug.trim()) return [];
    const efforts = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((level): string[] => {
          if (!level || typeof level !== "object") return [];
          const effort = (level as { effort?: unknown }).effort;
          return typeof effort === "string" && effort ? [effort] : [];
        })
      : [];
    return [{
      slug: model.slug,
      visibility: typeof model.visibility === "string" ? model.visibility : "unknown",
      supportedInApi: model.supported_in_api === true,
      reasoningEfforts: efforts,
      upgradeModel: model.upgrade
        && typeof model.upgrade === "object"
        && !Array.isArray(model.upgrade)
        && typeof (model.upgrade as Record<string, unknown>)["model"] === "string"
        ? (model.upgrade as Record<string, string>)["model"]!
        : null,
    }];
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function parseKimiProviderCatalog(raw: string): KimiModelSurface[] {
  const parsed = JSON.parse(raw) as { models?: unknown };
  if (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models)) {
    throw new Error("Kimi provider catalog has no models object");
  }

  return Object.entries(parsed.models).map(([id, value]): KimiModelSurface => {
    if (!id.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Kimi provider catalog has an invalid model record");
    }
    const model = value as KimiProviderCatalogRecord;
    if (typeof model.provider !== "string" || !model.provider.trim()) {
      throw new Error(`Kimi model ${id} has no provider`);
    }
    if (typeof model.model !== "string" || !model.model.trim()) {
      throw new Error(`Kimi model ${id} has no model id`);
    }
    if (!Array.isArray(model.capabilities) || !model.capabilities.every((item) => typeof item === "string")) {
      throw new Error(`Kimi model ${id} has invalid capabilities`);
    }
    if (model.supportEfforts !== undefined && (
      !Array.isArray(model.supportEfforts)
      || !model.supportEfforts.every((item) => typeof item === "string")
    )) {
      throw new Error(`Kimi model ${id} has invalid supportEfforts`);
    }
    if (model.defaultEffort !== undefined && typeof model.defaultEffort !== "string") {
      throw new Error(`Kimi model ${id} has invalid defaultEffort`);
    }
    return {
      id,
      provider: model.provider,
      model: model.model,
      displayName: typeof model.displayName === "string"
        ? model.displayName
        : typeof model.display_name === "string"
          ? model.display_name
          : null,
      capabilities: [...model.capabilities].sort(),
      supportedEfforts: Array.isArray(model.supportEfforts)
        ? [...model.supportEfforts].sort()
        : [],
      defaultEffort: typeof model.defaultEffort === "string" ? model.defaultEffort : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function extractClaudeOptionHelp(help: string, startPattern: RegExp): string | null {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => startPattern.test(line));
  if (start < 0) return null;

  const parts = [lines[start]!.replace(startPattern, "").trim()];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s{2,}--?\S/.test(line)) break;
    if (line.trim()) parts.push(line.trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim() || null;
}

export function extractClaudeModelHelp(help: string): string | null {
  return extractClaudeOptionHelp(help, /^\s*--model\s+<model>\s+/);
}

export function extractClaudeEffortHelp(help: string): string | null {
  return extractClaudeOptionHelp(help, /^\s*--effort\s+<level>\s+/);
}

function codexModelFingerprint(model: CodexModelSurface): string {
  return JSON.stringify({
    visibility: model.visibility,
    supportedInApi: model.supportedInApi,
    reasoningEfforts: model.reasoningEfforts,
    upgradeModel: model.upgradeModel,
  });
}

function kimiModelFingerprint(model: KimiModelSurface): string {
  return JSON.stringify({
    provider: model.provider,
    model: model.model,
    displayName: model.displayName,
    capabilities: model.capabilities,
    supportedEfforts: model.supportedEfforts,
    defaultEffort: model.defaultEffort,
  });
}

export function diffModelSurfaces(
  before: ModelSurfaceSnapshot,
  after: ModelSurfaceSnapshot,
): ModelSurfaceDiff {
  const beforeModels = new Map(before.codex.models.map((model) => [model.slug, model]));
  const afterModels = new Map(after.codex.models.map((model) => [model.slug, model]));
  const codexAdded = [...afterModels.keys()].filter((slug) => !beforeModels.has(slug)).sort();
  const codexRemoved = [...beforeModels.keys()].filter((slug) => !afterModels.has(slug)).sort();
  const codexChanged = [...afterModels.keys()].filter((slug) => {
    const previous = beforeModels.get(slug);
    return previous !== undefined && codexModelFingerprint(previous) !== codexModelFingerprint(afterModels.get(slug)!);
  }).sort();
  const beforeKimiModels = new Map(before.kimi.models.map((model) => [model.id, model]));
  const afterKimiModels = new Map(after.kimi.models.map((model) => [model.id, model]));
  const kimiAdded = [...afterKimiModels.keys()].filter((id) => !beforeKimiModels.has(id)).sort();
  const kimiRemoved = [...beforeKimiModels.keys()].filter((id) => !afterKimiModels.has(id)).sort();
  const kimiChanged = [...afterKimiModels.keys()].filter((id) => {
    const previous = beforeKimiModels.get(id);
    return previous !== undefined && kimiModelFingerprint(previous) !== kimiModelFingerprint(afterKimiModels.get(id)!);
  }).sort();
  const claudeModelHelpChanged = before.claude.modelHelp !== after.claude.modelHelp;
  const claudeEffortHelpChanged = before.claude.effortHelp !== after.claude.effortHelp;
  const claudeAcceptedEffortsChanged = JSON.stringify(before.claude.acceptedEfforts)
    !== JSON.stringify(after.claude.acceptedEfforts);
  return {
    changed: claudeModelHelpChanged
      || claudeEffortHelpChanged
      || claudeAcceptedEffortsChanged
      || codexAdded.length > 0
      || codexRemoved.length > 0
      || codexChanged.length > 0
      || kimiAdded.length > 0
      || kimiRemoved.length > 0
      || kimiChanged.length > 0,
    claudeModelHelpChanged,
    claudeEffortHelpChanged,
    claudeAcceptedEffortsChanged,
    codexAdded,
    codexRemoved,
    codexChanged,
    kimiAdded,
    kimiRemoved,
    kimiChanged,
  };
}

export function collectCodexUpgradeProbeTargets(
  before: ModelSurfaceSnapshot,
  after: ModelSurfaceSnapshot,
  referencedModels: string[],
): string[] {
  const diff = diffModelSurfaces(before, after);
  const affected = new Set([
    ...diff.codexAdded,
    ...diff.codexRemoved,
    ...diff.codexChanged,
  ]);
  const beforeBySlug = new Map(before.codex.models.map((model) => [model.slug, model]));
  const afterBySlug = new Map(after.codex.models.map((model) => [model.slug, model]));
  const targets = new Set<string>();
  for (const target of referencedModels) {
    if (!affected.has(target)) continue;
    targets.add(target);
    const upgradeModel = afterBySlug.get(target)?.upgradeModel
      ?? beforeBySlug.get(target)?.upgradeModel;
    if (upgradeModel) targets.add(upgradeModel);
  }
  return [...targets].sort();
}

export function isAcceptedClaudeEffortProbe(input: {
  exitCode: number | null;
  output: string;
  error?: string;
}): boolean {
  return classifyClaudeEffortParserProbe({ effort: "candidate", ...input }).status === "available";
}

export function classifyClaudeEffortParserProbe(input: {
  effort: string;
  exitCode: number | null;
  output: string;
  error?: string;
}): ClaudeEffortParserProbe {
  const detail = `${input.output}\n${input.error ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 240);
  if (/Unknown --effort value/i.test(detail)) {
    return {
      effort: input.effort,
      status: "unavailable",
      ...(detail ? { detail } : {}),
    };
  }
  if (input.exitCode === 0) return { effort: input.effort, status: "available" };
  if (/quota|rate.?limit|too many requests|overload|temporar(?:y|ily)|timed?\s*out|timeout|network|connection|ECONN|429\b/i.test(detail)) {
    return {
      effort: input.effort,
      status: "transient",
      ...(detail ? { detail } : {}),
    };
  }
  return {
    effort: input.effort,
    status: "error",
    ...(detail ? { detail } : {}),
  };
}

function captureAcceptedClaudeEfforts(claudeBin: string): {
  acceptedEfforts: string[];
  effortProbes: ClaudeEffortParserProbe[];
  error?: string;
} {
  const acceptedEfforts: string[] = [];
  const effortProbes: ClaudeEffortParserProbe[] = [];
  const errors: string[] = [];
  for (const effort of CLAUDE_EFFORT_CANDIDATES) {
    const run = spawnSync(claudeBin, ["--effort", effort, "--version"], {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const probe = classifyClaudeEffortParserProbe({
      effort,
      exitCode: run.status,
      output,
      error: run.error?.message,
    });
    effortProbes.push(probe);
    if (probe.status === "available") {
      acceptedEfforts.push(effort);
      continue;
    }
    if (probe.status === "error" || probe.status === "transient") {
      errors.push(`${effort}: ${probe.detail ?? errorText(run.error ?? new Error(`claude --effort ${effort} exited ${run.status}`))}`);
    }
  }
  return {
    acceptedEfforts,
    effortProbes,
    ...(errors.length > 0 ? { error: errors.join("; ").slice(0, 240) } : {}),
  };
}

export function captureModelSurface(input: {
  claudeBin: string;
  codexBin: string;
  kimiBin: string;
}): ModelSurfaceSnapshot {
  const capturedAt = Date.now();
  const claudeRun = spawnSync(input.claudeBin, ["--help"], {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const claudeOutput = `${claudeRun.stdout ?? ""}\n${claudeRun.stderr ?? ""}`;
  const claudeModelHelp = extractClaudeModelHelp(claudeOutput);
  const claudeEffortHelp = extractClaudeEffortHelp(claudeOutput);
  const claudeEffortProbe = captureAcceptedClaudeEfforts(input.claudeBin);
  const missingClaudeHelp = [
    ...(claudeModelHelp ? [] : ["--model"]),
    ...(claudeEffortHelp ? [] : ["--effort"]),
  ];
  const claudeErrors = [
    ...(missingClaudeHelp.length > 0
      ? [errorText(claudeRun.error ?? new Error(`claude --help missing ${missingClaudeHelp.join(" and ")} option documentation`))]
      : []),
    ...(claudeEffortProbe.error ? [claudeEffortProbe.error] : []),
  ];

  const codexRun = spawnSync(input.codexBin, ["debug", "models", "--bundled"], {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let codexModels: CodexModelSurface[] = [];
  let codexError: string | undefined;
  try {
    if (codexRun.status !== 0) {
      throw codexRun.error ?? new Error(`codex debug models exited ${codexRun.status}`);
    }
    codexModels = parseCodexBundledCatalog(codexRun.stdout ?? "");
  } catch (error) {
    codexError = errorText(error);
  }

  const kimiRun = spawnSync(input.kimiBin, ["provider", "list", "--json"], {
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      KIMI_CLI_NO_AUTO_UPDATE: "1",
    },
  });
  let kimiModels: KimiModelSurface[] = [];
  let kimiError: string | undefined;
  try {
    if (kimiRun.status !== 0) {
      throw kimiRun.error ?? new Error(`kimi provider list exited ${kimiRun.status}`);
    }
    kimiModels = parseKimiProviderCatalog(kimiRun.stdout ?? "");
  } catch (error) {
    kimiError = errorText(error);
  }

  return {
    capturedAt,
    claude: {
      modelHelp: claudeModelHelp,
      effortHelp: claudeEffortHelp,
      acceptedEfforts: claudeEffortProbe.acceptedEfforts,
      effortProbes: claudeEffortProbe.effortProbes,
      ...(claudeErrors.length > 0 ? { error: claudeErrors.join("; ").slice(0, 240) } : {}),
    },
    codex: {
      models: codexModels,
      ...(codexError ? { error: codexError } : {}),
    },
    kimi: {
      models: kimiModels,
      ...(kimiError ? { error: kimiError } : {}),
    },
  };
}

export function classifyModelProbe(input: {
  backend: ModelProbeBackend;
  target: string;
  exitCode: number | null;
  output: string;
  error?: string;
}): ModelProbeResult {
  const combined = `${input.output}\n${input.error ?? ""}`.trim();
  const detail = combined.replace(/\s+/g, " ").slice(0, 240);
  if (input.exitCode === 0 && combined.includes(MODEL_PROBE_TOKEN)) {
    return { backend: input.backend, target: input.target, status: "available" };
  }

  // sm-proxy strict mode 的 model_not_served 是账号/路由级状态（如 sm-switch
  // 把 codex 切到 DeepSeek 通道，2026-08-06 下午实测），不是模型退役——归 transient。
  const fable5QuotaLimit = input.backend === "claude"
    && input.target === "claude-fable-5"
    && /(?:fable\s*5|claude[-\s]?fable[-\s]?5).*(?:quota|limit)|(?:quota|limit).*(?:fable\s*5|claude[-\s]?fable[-\s]?5)/i.test(combined);
  const transient = /(?:weekly|session) limit|quota|rate.?limit|too many requests|overload|temporar(?:y|ily)|timed?\s*out|timeout|network|connection|ECONN|429\b|model_not_served|sm-proxy strict mode/i;
  if (fable5QuotaLimit || transient.test(combined)) {
    return { backend: input.backend, target: input.target, status: "transient", ...(detail ? { detail } : {}) };
  }

  const unavailable = /unknown model|invalid model|model metadata .* not found|does not exist|do not have access|not supported when using|unsupported model|model .* retired|model .* deprecated/i;
  if (unavailable.test(combined)) {
    return { backend: input.backend, target: input.target, status: "unavailable", ...(detail ? { detail } : {}) };
  }

  return { backend: input.backend, target: input.target, status: "error", ...(detail ? { detail } : {}) };
}

function runProbe(
  backend: ModelProbeBackend,
  target: string,
  bin: string,
  args: string[],
  cwd: string,
  runner: ModelProbeCommandRunner = defaultModelProbeCommandRunner,
): ModelProbeResult {
  const run = runner(bin, args, {
    cwd,
    ...(backend === "kimi" ? {
      env: {
        ...process.env,
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_CLI_NO_AUTO_UPDATE: "1",
      },
    } : {}),
  });
  return classifyModelProbe({
    backend,
    target,
    exitCode: run.exitCode,
    output: `${run.stdout}\n${run.stderr}`,
    error: run.error,
  });
}

function defaultModelProbeCommandRunner(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ModelProbeCommandResult {
  const run = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    exitCode: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    ...(run.error ? { error: run.error.message } : {}),
  };
}

export function runBtwModelProbes(input: {
  claudeBin: string;
  codexBin: string;
  supermatrixDir: string;
}): ModelProbeResult[] {
  const prompt = `Reply with exactly ${MODEL_PROBE_TOKEN}.`;
  return [
    runProbe("claude", CLAUDE_BTW_TARGET, input.claudeBin, [
      "-p",
      "--model", CLAUDE_BTW_TARGET,
      "--output-format", "text",
      "--no-session-persistence",
      prompt,
    ], input.supermatrixDir),
    runProbe("codex", CODEX_BTW_TARGET, input.codexBin, [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model", CODEX_BTW_TARGET,
      "--cd", input.supermatrixDir,
      prompt,
    ], input.supermatrixDir),
  ];
}

export function runCodexModelProbes(input: {
  targets: string[];
  codexBin: string;
  supermatrixDir: string;
}): ModelProbeResult[] {
  const prompt = `Reply with exactly ${MODEL_PROBE_TOKEN}.`;
  return [...new Set(input.targets)].sort().map((target) =>
    runProbe("codex", target, input.codexBin, [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model", target,
      "--cd", input.supermatrixDir,
      prompt,
    ], input.supermatrixDir)
  );
}

export type CodexEffortProbeTarget = {
  target: string;
  efforts: string[];
};

export type CodexEffortProbeResult = {
  backend: "codex";
  target: string;
  effort: string;
  status: ModelProbeStatus;
  detail?: string;
};

/**
 * Verifies each model-specific Codex effort at the same CLI boundary used by
 * SuperMatrix.  A bundled `supported_reasoning_levels` entry is only a
 * candidate; this call establishes the account-visible execution chain.
 */
export function runCodexEffortProbes(input: {
  targets: CodexEffortProbeTarget[];
  codexBin: string;
  supermatrixDir: string;
  run?: ModelProbeCommandRunner;
}): CodexEffortProbeResult[] {
  const prompt = `Reply with exactly ${MODEL_PROBE_TOKEN}.`;
  const effortsByTarget = new Map<string, Set<string>>();
  for (const item of input.targets) {
    const target = item.target.trim();
    if (!target) continue;
    const efforts = effortsByTarget.get(target) ?? new Set<string>();
    for (const effort of item.efforts) {
      if (effort.trim()) efforts.add(effort.trim());
    }
    effortsByTarget.set(target, efforts);
  }

  const probes: CodexEffortProbeResult[] = [];
  for (const target of [...effortsByTarget.keys()].sort()) {
    for (const effort of [...effortsByTarget.get(target)!].sort()) {
      const result = runProbe("codex", target, input.codexBin, [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model", target,
        "-c", `model_reasoning_effort=${effort}`,
        "--cd", input.supermatrixDir,
        prompt,
      ], input.supermatrixDir, input.run);
      probes.push({
        backend: "codex",
        target,
        effort,
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }
  }
  return probes;
}

export function runCatalogModelProbes(input: {
  catalogModels: Record<ModelProbeBackend, string[]>;
  alreadyProbed?: ModelProbeResult[];
  claudeBin: string;
  codexBin: string;
  kimiBin: string;
  supermatrixDir: string;
  run?: ModelProbeCommandRunner;
}): ModelProbeResult[] {
  const prompt = `Reply with exactly ${MODEL_PROBE_TOKEN}.`;
  const alreadyProbed = new Set(
    (input.alreadyProbed ?? []).map((probe) => `${probe.backend}\0${probe.target}`),
  );
  const binaries: Record<ModelProbeBackend, string> = {
    claude: input.claudeBin,
    codex: input.codexBin,
    kimi: input.kimiBin,
  };
  const args = (backend: ModelProbeBackend, target: string): string[] => {
    if (backend === "claude") {
      return [
        "-p",
        "--model", target,
        "--output-format", "text",
        "--no-session-persistence",
        prompt,
      ];
    }
    if (backend === "codex") {
      return [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model", target,
        "--cd", input.supermatrixDir,
        prompt,
      ];
    }
    return [
      "--model", target,
      "--prompt", prompt,
      "--output-format", "text",
    ];
  };

  const probes: ModelProbeResult[] = [];
  for (const backend of ["claude", "codex", "kimi"] as const) {
    for (const target of [...new Set(input.catalogModels[backend])].sort()) {
      if (alreadyProbed.has(`${backend}\0${target}`)) continue;
      probes.push(runProbe(
        backend,
        target,
        binaries[backend],
        args(backend, target),
        input.supermatrixDir,
        input.run,
      ));
    }
  }
  return probes;
}

export function buildWeeklyModelAudit(
  before: ModelSurfaceSnapshot,
  after: ModelSurfaceSnapshot,
  probes: ModelProbeResult[],
  compatibility: {
    requiresAdjustment: boolean;
    adjustmentReasons: string[];
  } = { requiresAdjustment: false, adjustmentReasons: [] },
): WeeklyModelAudit {
  const diff = diffModelSurfaces(before, after);
  const postCodexTargets = new Set(after.codex.models.map((model) => model.slug));
  const targetUnavailable = probes.some((probe) => probe.status === "unavailable");
  const codexTargetMissing = !after.codex.error && !postCodexTargets.has(CODEX_BTW_TARGET);
  const probeError = probes.some((probe) => probe.status === "error");
  const requiresAdjustment = targetUnavailable
    || codexTargetMissing
    || compatibility.requiresAdjustment;
  return {
    before,
    after,
    diff,
    probes,
    compatibilityAdjustmentReasons: compatibility.adjustmentReasons,
    requiresReview: diff.changed
      || requiresAdjustment
      || probeError
      || Boolean(after.claude.error)
      || Boolean(after.codex.error)
      || Boolean(after.kimi.error),
    requiresAdjustment,
  };
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function formatModelAuditForReview(audit: WeeklyModelAudit): string {
  const probeLines = audit.probes.map((probe) =>
    `- ${probe.backend} ${probe.target}: ${probe.status}${probe.detail ? ` (${probe.detail})` : ""}`
  );
  return [
    `- model surface changed: ${audit.diff.changed ? "yes" : "no"}`,
    `- claude --model help changed: ${audit.diff.claudeModelHelpChanged ? "yes" : "no"}`,
    `- claude --effort help changed: ${audit.diff.claudeEffortHelpChanged ? "yes" : "no"}`,
    `- claude --effort parser values: ${list(audit.after.claude.acceptedEfforts)}`,
    `- claude --effort parser values changed: ${audit.diff.claudeAcceptedEffortsChanged ? "yes" : "no"}`,
    `- codex bundled added: ${list(audit.diff.codexAdded)}`,
    `- codex bundled removed: ${list(audit.diff.codexRemoved)}`,
    `- codex bundled metadata changed: ${list(audit.diff.codexChanged)}`,
    `- kimi provider models added: ${list(audit.diff.kimiAdded)}`,
    `- kimi provider models removed: ${list(audit.diff.kimiRemoved)}`,
    `- kimi provider model metadata changed: ${list(audit.diff.kimiChanged)}`,
    `- kimi provider catalog: ${audit.after.kimi.error ? `error (${audit.after.kimi.error})` : "captured"}`,
    `- SuperMatrix compatibility adjustment reasons: ${list(audit.compatibilityAdjustmentReasons)}`,
    `- requires source adjustment: ${audit.requiresAdjustment ? "yes" : "no"}`,
    "- runtime target probes (fixed BTW targets plus changed referenced Codex models and successors):",
    ...probeLines,
  ].join("\n");
}

export function formatModelAuditReviewInstructions(audit: WeeklyModelAudit): string {
  return `==================================================================
【定时任务模型审计（机器证据，必须处理）】
==================================================================
${formatModelAuditForReview(audit)}

处理契约：
- 仍需按 checklist 对当前登录逐模型探针；Codex bundled catalog 和 Kimi provider catalog 都不能替代实际 backend 协议兼容性。
- 已验证的新增、删除、重命名或 effort 变化，要在同一 review 同步 /model、/help model、/help effort、相关 catalog/allowlist、alias/default/fallback 及测试；Claude 的 --effort 值以本次机器审计为准，不能沿用旧的硬编码列表。
- Claude 已知 effort 候选以无模型调用的 claude --effort <candidate> --version parser probe 判定；claude --help 只作说明文本，不能因为未列出就断言候选不可用。模型特异档位仍须对受影响目标做真实 probe。
- Kimi Code 的 provider list --json 只记录白名单模型字段；如果 provider/model/capability 变化，必须复核 backend-kimi ACP 初始化、新会话模型元数据和 Kimi 用户模型目录，不能沿用旧的静态说明。
- Claude BTW 保持动态 sonnet alias；Codex BTW 当前为 gpt-5.5。若锁定目标被确认退役/重命名，必须在同一 review 更新 /btw 到已验证的低一档模型及测试，不得只登记普通待办。
- quota/rate-limit/weekly limit 属于 transient，不得据此改模型。无明确替代时标 blocked、fail closed，并登记人工决策，禁止静默回退最高档或全局默认。
- 本仓相关测试必须实际运行；不要把测试转包给其它 session。
- watchdog 已在本轮通过 backend_model_effort_probe v1 快照发布全局 catalog；review 只裁决 SuperMatrix 源码是否需要调整，不得直接修改飞书枚举或另写 catalog。

最终回复末尾必须独占一行：
MODEL_AUDIT_RESOLUTION: adjusted|unchanged|blocked
其中 adjusted=已改源码并验证；unchanged=证据确认无需改用户模型面；blocked=无法安全自动调整并已明确告警。`;
}

export function assessModelAuditResolution(
  audit: WeeklyModelAudit,
  rootReview: string,
):
  | { status: "accepted"; resolution: "adjusted" | "unchanged" }
  | { status: "blocked"; resolution: "blocked"; reason: string }
  | { status: "invalid"; resolution: "adjusted" | "unchanged" | "blocked" | "missing"; reason: string } {
  const match = rootReview.match(/^MODEL_AUDIT_RESOLUTION:\s*(adjusted|unchanged|blocked)\s*$/im);
  const resolution = (match?.[1] ?? "missing") as "adjusted" | "unchanged" | "blocked" | "missing";
  if (resolution === "missing") {
    return { status: "invalid", resolution, reason: "root review omitted MODEL_AUDIT_RESOLUTION" };
  }
  if (resolution === "blocked") {
    return { status: "blocked", resolution, reason: "model audit needs human or upstream resolution" };
  }
  if (resolution === "adjusted") {
    const autoFixedIndex = rootReview.search(/^##\s*Auto-fixed\b/im);
    const afterHeading = autoFixedIndex >= 0
      ? rootReview.slice(autoFixedIndex).replace(/^##\s*Auto-fixed[^\n]*\n/i, "")
      : "";
    const nextHeading = afterHeading.search(/\n##\s/);
    const autoFixed = (nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading).trim();
    if (!/commit:\s*[0-9a-f]{7,40}\b/i.test(autoFixed)) {
      return { status: "invalid", resolution, reason: "adjusted resolution has no Auto-fixed commit receipt" };
    }
  }
  if (audit.requiresAdjustment && resolution !== "adjusted") {
    return { status: "invalid", resolution, reason: "model audit requires a source adjustment" };
  }
  return { status: "accepted", resolution };
}
