export type CatalogProbeBackend = "claude" | "codex" | "kimi";

export type CatalogEffortParentChain = {
  model: string;
  efforts: string[];
};

export type YoloCatalogProbeTargets = {
  assetId: "yolo.task-model-routing";
  routeCount: number;
  models: Record<CatalogProbeBackend, string[]>;
  effortParentChains: Record<CatalogProbeBackend, CatalogEffortParentChain[]>;
  controlEfforts: Array<{
    backend: CatalogProbeBackend;
    model: string;
    effort: "default";
  }>;
};

const BACKENDS = ["claude", "codex", "kimi"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function extractYoloCatalogProbeTargets(payload: unknown): YoloCatalogProbeTargets {
  if (!isObject(payload) || payload["asset"] !== "yolo.task-model-routing") {
    throw new Error("YOLO routing asset must equal yolo.task-model-routing");
  }
  const taskTypes = payload["task_types"];
  if (!isObject(taskTypes)) throw new Error("YOLO routing task_types must be an object");

  const models = Object.fromEntries(BACKENDS.map((backend) => [backend, new Set<string>()])) as
    Record<CatalogProbeBackend, Set<string>>;
  const efforts = Object.fromEntries(BACKENDS.map((backend) => [backend, new Map<string, Set<string>>()])) as
    Record<CatalogProbeBackend, Map<string, Set<string>>>;
  const controlEfforts = new Map<string, YoloCatalogProbeTargets["controlEfforts"][number]>();
  let routeCount = 0;

  for (const [taskType, routes] of Object.entries(taskTypes)) {
    if (!Array.isArray(routes)) throw new Error(`YOLO routes for ${taskType} must be an array`);
    for (const [index, route] of routes.entries()) {
      if (!isObject(route)) throw new Error(`YOLO route ${taskType}[${index}] must be an object`);
      const backendValue = nonemptyString(route["backend"], `YOLO route ${taskType}[${index}].backend`);
      if (!BACKENDS.includes(backendValue as CatalogProbeBackend)) {
        throw new Error(`unsupported backend in YOLO routing: ${backendValue}`);
      }
      const backend = backendValue as CatalogProbeBackend;
      const model = nonemptyString(route["model"], `YOLO route ${taskType}[${index}].model`);
      const effort = nonemptyString(route["effort"], `YOLO route ${taskType}[${index}].effort`);
      models[backend].add(model);
      if (effort === "default") {
        controlEfforts.set(`${backend}\0${model}\0${effort}`, { backend, model, effort });
      } else {
        const modelEfforts = efforts[backend].get(model) ?? new Set<string>();
        modelEfforts.add(effort);
        efforts[backend].set(model, modelEfforts);
      }
      routeCount += 1;
    }
  }
  if (routeCount === 0) throw new Error("YOLO routing contains no referenced routes");

  const sortedModels = Object.fromEntries(
    BACKENDS.map((backend) => [backend, sorted(models[backend])]),
  ) as Record<CatalogProbeBackend, string[]>;
  const effortParentChains = Object.fromEntries(BACKENDS.map((backend) => [
    backend,
    [...efforts[backend].entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([model, modelEfforts]) => ({ model, efforts: sorted(modelEfforts) })),
  ])) as Record<CatalogProbeBackend, CatalogEffortParentChain[]>;

  return {
    assetId: "yolo.task-model-routing",
    routeCount,
    models: sortedModels,
    effortParentChains,
    controlEfforts: [...controlEfforts.values()].sort((left, right) =>
      `${left.backend}\0${left.model}`.localeCompare(`${right.backend}\0${right.model}`)
    ),
  };
}
