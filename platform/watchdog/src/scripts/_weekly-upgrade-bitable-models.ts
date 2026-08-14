import { spawnSync } from "node:child_process";

export const MODEL_ENUM_SYNC_VERSION = 1 as const;
export const MODEL_ENUM_WIKI_NODE_TOKEN = "VaOcwdh7OiFwCRkK7JOcHHTVnje";
export const MODEL_ENUM_TABLE_ID = "tblREDACTEDTABLEID";
export const MODEL_ENUM_FIELDS = [
  { id: "fldH5w2znt", name: "主model默认值" },
  { id: "fldLAvqVHX", name: "主model当前" },
  { id: "fldM55REi2", name: "子model" },
] as const;

export type ModelEnumOption = {
  name: string;
  hue?: string;
  lightness?: string;
};

export type ModelEnumFieldDefinition = {
  id: string;
  name: string;
  type: "select";
  multiple: false;
  description?: string;
  options: ModelEnumOption[];
};

export type LarkCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type LarkCommandRunner = (
  bin: string,
  args: string[],
) => LarkCommandResult;

export type ModelEnumSyncResult = {
  status: "updated" | "unchanged";
  requested: string[];
  added: string[];
  fields: Array<{
    id: string;
    name: string;
    added: string[];
  }>;
};

const CANONICAL_MODEL_ID =
  /^(?:claude-[a-z0-9]+(?:-[a-z0-9]+)*|gpt-[a-z0-9]+(?:[.-][a-z0-9]+)*|kimi-code\/[a-z0-9]+(?:[._-][a-z0-9]+)*)$/;

export function parseModelEnumAdditions(rootReview: string):
  | { status: "valid"; models: string[] }
  | { status: "invalid"; reason: string } {
  const matches = [...rootReview.matchAll(/^MODEL_ENUM_ADDITIONS:\s*(.+?)\s*$/gim)];
  if (matches.length === 0) {
    return { status: "invalid", reason: "root review omitted MODEL_ENUM_ADDITIONS" };
  }
  if (matches.length > 1) {
    return { status: "invalid", reason: "root review contains multiple MODEL_ENUM_ADDITIONS markers" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    return { status: "invalid", reason: "MODEL_ENUM_ADDITIONS is not a JSON array" };
  }
  if (!Array.isArray(parsed) || parsed.length > 50 || !parsed.every((value) => typeof value === "string")) {
    return { status: "invalid", reason: "MODEL_ENUM_ADDITIONS must be an array of at most 50 model ids" };
  }

  const models: string[] = [];
  for (const value of parsed) {
    if (!CANONICAL_MODEL_ID.test(value)) {
      return { status: "invalid", reason: `MODEL_ENUM_ADDITIONS contains non-canonical model id: ${value}` };
    }
    if (!models.includes(value)) models.push(value);
  }
  return { status: "valid", models };
}

export function planModelEnumSync(input: {
  version?: number;
  auditStatus?: "accepted" | "blocked" | "invalid" | "missing";
  rootReview: string;
}):
  | { status: "legacy-skip" }
  | { status: "skipped"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "ready"; models: string[] } {
  if (input.version === undefined) return { status: "legacy-skip" };
  if (input.version !== MODEL_ENUM_SYNC_VERSION) {
    return { status: "invalid", reason: `unsupported model enum sync version: ${input.version}` };
  }
  if (input.auditStatus !== "accepted") {
    return {
      status: "skipped",
      reason: `model audit resolution is ${input.auditStatus ?? "missing"}`,
    };
  }
  const additions = parseModelEnumAdditions(input.rootReview);
  if (additions.status === "invalid") return additions;
  return { status: "ready", models: additions.models };
}

function defaultRunner(bin: string, args: string[]): LarkCommandResult {
  const run = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    ...(run.error ? { error: run.error } : {}),
  };
}

function commandDetail(result: LarkCommandResult): string {
  return `${result.stderr}\n${result.stdout}\n${result.error?.message ?? ""}`
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300) || `exit ${result.status ?? "unknown"}`;
}

function runJson(
  run: LarkCommandRunner,
  larkBin: string,
  args: string[],
  label: string,
): Record<string, unknown> {
  const result = run(larkBin, args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${commandDetail(result)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${commandDetail(result)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned a non-object response`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope["ok"] !== true) {
    throw new Error(`${label} returned ok=false: ${commandDetail(result)}`);
  }
  if (envelope["identity"] !== "user") {
    throw new Error(`${label} did not use user identity`);
  }
  return envelope;
}

function resolveBaseToken(
  run: LarkCommandRunner,
  larkBin: string,
): string {
  const envelope = runJson(run, larkBin, [
    "wiki",
    "+node-get",
    "--node-token", MODEL_ENUM_WIKI_NODE_TOKEN,
    "--as", "user",
    "--format", "json",
  ], "model enum wiki lookup");
  const data = envelope["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("model enum wiki lookup has no data object");
  }
  const objType = (data as Record<string, unknown>)["obj_type"];
  const objToken = (data as Record<string, unknown>)["obj_token"];
  if (objType !== "bitable" || typeof objToken !== "string" || !objToken.trim()) {
    throw new Error("model enum wiki node does not resolve to a bitable");
  }
  return objToken;
}

function parseField(
  envelope: Record<string, unknown>,
  expected: typeof MODEL_ENUM_FIELDS[number],
): ModelEnumFieldDefinition {
  const data = envelope["data"];
  const field = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)["field"]
    : null;
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${expected.name} readback has no field object`);
  }
  const record = field as Record<string, unknown>;
  if (
    record["id"] !== expected.id
    || record["name"] !== expected.name
    || record["type"] !== "select"
    || record["multiple"] !== false
    || !Array.isArray(record["options"])
  ) {
    throw new Error(`${expected.name} no longer matches the expected single-select field contract`);
  }
  const options = record["options"].map((value): ModelEnumOption => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${expected.name} contains an invalid option`);
    }
    const option = value as Record<string, unknown>;
    if (typeof option["name"] !== "string" || !option["name"]) {
      throw new Error(`${expected.name} contains an option without a name`);
    }
    return {
      name: option["name"],
      ...(typeof option["hue"] === "string" ? { hue: option["hue"] } : {}),
      ...(typeof option["lightness"] === "string" ? { lightness: option["lightness"] } : {}),
    };
  });
  return {
    id: expected.id,
    name: expected.name,
    type: "select",
    multiple: false,
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
    options,
  };
}

function readField(
  run: LarkCommandRunner,
  larkBin: string,
  baseToken: string,
  expected: typeof MODEL_ENUM_FIELDS[number],
): ModelEnumFieldDefinition {
  return parseField(runJson(run, larkBin, [
    "base",
    "+field-get",
    "--base-token", baseToken,
    "--table-id", MODEL_ENUM_TABLE_ID,
    "--field-id", expected.id,
    "--as", "user",
    "--format", "json",
  ], `${expected.name} field read`), expected);
}

function updateField(
  run: LarkCommandRunner,
  larkBin: string,
  baseToken: string,
  field: ModelEnumFieldDefinition,
): void {
  const body = {
    name: field.name,
    type: field.type,
    multiple: field.multiple,
    ...(field.description !== undefined ? { description: field.description } : {}),
    options: field.options,
  };
  runJson(run, larkBin, [
    "base",
    "+field-update",
    "--base-token", baseToken,
    "--table-id", MODEL_ENUM_TABLE_ID,
    "--field-id", field.id,
    "--as", "user",
    "--json", JSON.stringify(body),
    "--yes",
  ], `${field.name} field update`);
}

export function syncModelEnumAdditions(input: {
  larkBin: string;
  models: string[];
  run?: LarkCommandRunner;
}): ModelEnumSyncResult {
  const parsed = parseModelEnumAdditions(`MODEL_ENUM_ADDITIONS: ${JSON.stringify(input.models)}`);
  if (parsed.status === "invalid") throw new Error(parsed.reason);
  const requested = parsed.models;
  if (requested.length === 0) {
    return { status: "unchanged", requested, added: [], fields: [] };
  }

  const run = input.run ?? defaultRunner;
  const baseToken = resolveBaseToken(run, input.larkBin);
  const added = new Set<string>();
  const fields: ModelEnumSyncResult["fields"] = [];

  for (const expected of MODEL_ENUM_FIELDS) {
    const before = readField(run, input.larkBin, baseToken, expected);
    const existing = new Set(before.options.map(({ name }) => name));
    const missing = requested.filter((model) => !existing.has(model));
    if (missing.length > 0) {
      updateField(run, input.larkBin, baseToken, {
        ...before,
        options: [
          ...before.options,
          ...missing.map((name) => ({ name })),
        ],
      });
      const after = readField(run, input.larkBin, baseToken, expected);
      const afterNames = new Set(after.options.map(({ name }) => name));
      const unreadable = requested.filter((model) => !afterNames.has(model));
      if (unreadable.length > 0) {
        throw new Error(`${expected.name} readback is missing: ${unreadable.join(", ")}`);
      }
      missing.forEach((model) => added.add(model));
    }
    fields.push({ id: expected.id, name: expected.name, added: missing });
  }

  return {
    status: added.size > 0 ? "updated" : "unchanged",
    requested,
    added: requested.filter((model) => added.has(model)),
    fields,
  };
}
