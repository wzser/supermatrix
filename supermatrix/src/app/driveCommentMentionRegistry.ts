import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  DriveCommentMentionRegistry,
  DriveCommentMentionRegistryEntry,
  DriveCommentMentionRegistryLoader,
  DriveCommentMentionDelivery,
  DriveCommentMentionRegistryTrigger,
  DriveCommentMentionSop,
} from "./driveCommentMentions.ts";
import type { DriveCommentFileType, DriveCommentPollWatch } from "../ports/LarkGateway.ts";

export type FileDriveCommentMentionRegistryLoaderOptions = {
  registryPath: string;
};

export type DriveCommentMentionPollWatch = DriveCommentPollWatch & {
  routeId: string;
};

export function deriveDriveCommentMentionPollWatches(
  registry: DriveCommentMentionRegistry | null,
): DriveCommentMentionPollWatch[] {
  if (!registry) return [];
  const watches: DriveCommentMentionPollWatch[] = [];
  for (const route of registry.routes) {
    const poll = route.ingest?.poll;
    const fileToken = route.source.fileToken;
    const fileType = route.source.fileType;
    if (route.enabled === false || !poll || !fileToken || !fileType) continue;
    watches.push({
      routeId: route.id,
      fileToken,
      fileType,
      ...(route.source.tableId ? { tableId: route.source.tableId } : {}),
      ...(route.source.recordId ? { recordId: route.source.recordId } : {}),
      ...(poll.since !== undefined ? { since: poll.since } : {}),
      requireMention: !route.triggers.some(
        (trigger) => trigger.ingestModes?.includes("poll_unmentioned"),
      ),
      intervalSec: poll.intervalSec,
      ...(route.source.url ? { url: route.source.url } : {}),
    });
  }
  return watches;
}

// Cursor persistence belongs with the registry normalizer rather than the
// polling adapter. Re-read and normalize before every write so a route removed
// or disabled while a sweep was in flight cannot be revived by a stale cursor.
export async function persistDriveCommentMentionPollSince(
  registryPath: string,
  routeId: string,
  since: number,
): Promise<void> {
  if (!Number.isFinite(since) || since < 0) {
    throw new Error("mention registry poll cursor must be a non-negative number");
  }
  const raw = await readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const normalized = normalizeRegistry(parsed);
  const route = normalized.routes.find((candidate) => candidate.id === routeId);
  if (!route || route.enabled === false || !route.ingest?.poll) return;
  if ((route.ingest.poll.since ?? -1) >= since) return;

  if (!isRecord(parsed) || !Array.isArray(parsed.routes)) return;
  const rawRoute = parsed.routes.find(
    (candidate) => isRecord(candidate) && candidate.id === routeId,
  );
  if (!isRecord(rawRoute)) return;
  const poll = recordField(recordField(rawRoute, "ingest"), "poll");
  if (!poll) return;
  poll.since = since;

  const tempPath = `${registryPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await rename(tempPath, registryPath);
}

export function createFileDriveCommentMentionRegistryLoader(
  options: FileDriveCommentMentionRegistryLoaderOptions,
): DriveCommentMentionRegistryLoader {
  const registryDir = dirname(options.registryPath);
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(options.registryPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      return normalizeRegistry(JSON.parse(raw) as unknown);
    },
    async loadSop(sopRef: string) {
      const sopPaths = [
        resolve(registryDir, sopRef),
        resolve(registryDir, "..", sopRef),
      ];
      let lastError: unknown;
      for (const sopPath of sopPaths) {
        try {
          return parseSopMarkdown(await readFile(sopPath, "utf8"));
        } catch (err) {
          lastError = err;
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      throw lastError;
    },
  };
}

function normalizeRegistry(value: unknown): DriveCommentMentionRegistry {
  if (!isRecord(value)) throw new Error("mention registry must be a JSON object");
  if (value.version !== 1) throw new Error("mention registry version must be 1");
  if (!Array.isArray(value.routes)) throw new Error("mention registry routes must be an array");
  return {
    version: 1,
    routes: value.routes.map(normalizeEntry),
  };
}

function normalizeEntry(value: unknown): DriveCommentMentionRegistryEntry {
  if (!isRecord(value)) throw new Error("mention registry route must be an object");
  const id = requiredString(value, "id");
  const rawSource = recordField(value, "source");
  const rawTriggers = value.triggers;
  if (!Array.isArray(rawTriggers)) {
    throw new Error(`mention registry route ${id} triggers must be an array`);
  }
  const entry: DriveCommentMentionRegistryEntry = {
    id,
    source: normalizeSource(rawSource, id),
    triggers: rawTriggers.map((trigger) => normalizeTrigger(trigger, id)),
  };
  if (typeof value.enabled === "boolean") entry.enabled = value.enabled;
  const ownerSession = stringField(value, "ownerSession", "owner_session");
  if (ownerSession) entry.ownerSession = ownerSession;
  const delivery = normalizeDelivery(value.delivery, id);
  if (delivery) entry.delivery = delivery;
  const ingest = normalizeIngest(value.ingest, id);
  if (ingest) entry.ingest = ingest;
  return entry;
}

function normalizeIngest(
  value: unknown,
  routeId: string,
): DriveCommentMentionRegistryEntry["ingest"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`mention registry route ${routeId} ingest must be an object`);
  const poll = recordField(value, "poll");
  if (!poll) throw new Error(`mention registry route ${routeId} ingest.poll must be an object`);
  const intervalSec = poll.intervalSec ?? poll.interval_sec;
  if (typeof intervalSec !== "number" || !Number.isInteger(intervalSec) || intervalSec < 60) {
    throw new Error(`mention registry route ${routeId} ingest.poll.interval_sec must be an integer >= 60`);
  }
  const since = poll.since;
  if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since) || since < 0)) {
    throw new Error(`mention registry route ${routeId} ingest.poll.since must be a non-negative number`);
  }
  return {
    poll: {
      intervalSec,
      ...(typeof since === "number" ? { since } : {}),
    },
  };
}

function normalizeDelivery(
  value: unknown,
  routeId: string,
): DriveCommentMentionDelivery | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`mention registry route ${routeId} delivery must be an object`);
  const type = requiredString(value, "type");
  if (type === "script") {
    const argv = value.argv;
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error(`mention registry route ${routeId} script delivery argv must be a non-empty string array`);
    }
    const normalizedArgv = argv.map((arg, index) => {
      if (typeof arg !== "string" || arg.trim().length === 0) {
        throw new Error(`mention registry route ${routeId} script delivery argv[${index}] must be a non-empty string`);
      }
      return arg;
    });
    const cwd = requiredString(value, "cwd");
    const timeoutMs = value.timeout_ms;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`mention registry route ${routeId} script delivery timeout_ms must be a positive integer`);
    }
    return { type, argv: normalizedArgv, cwd, timeoutMs };
  }
  if (type !== "session") {
    throw new Error(`mention registry route ${routeId} delivery.type is invalid: ${type}`);
  }
  return {
    type: "session",
    sessionName: requiredString(value, "sessionName", "session_name"),
  };
}

function normalizeSource(
  value: Record<string, unknown> | undefined,
  routeId: string,
): DriveCommentMentionRegistryEntry["source"] {
  if (!value) throw new Error(`mention registry route ${routeId} source must be an object`);
  const fileType = stringField(value, "fileType", "file_type");
  if (fileType !== undefined && !isDriveCommentFileType(fileType)) {
    throw new Error(`mention registry route ${routeId} source.file_type is invalid: ${fileType}`);
  }
  const source: DriveCommentMentionRegistryEntry["source"] = {};
  const fileToken = stringField(value, "fileToken", "file_token");
  const tableId = stringField(value, "tableId", "table_id");
  const url = stringField(value, "url");
  const recordId = stringField(value, "recordId", "record_id");
  if (fileToken) source.fileToken = fileToken;
  if (fileType) source.fileType = fileType;
  if (tableId) source.tableId = tableId;
  if (url) source.url = url;
  if (recordId) source.recordId = recordId;
  return source;
}

function normalizeTrigger(value: unknown, routeId: string): DriveCommentMentionRegistryTrigger {
  if (!isRecord(value)) throw new Error(`mention registry route ${routeId} trigger must be an object`);
  const id = requiredString(value, "id");
  const match = recordField(value, "match");
  if (!match) throw new Error(`mention registry trigger ${routeId}/${id} match must be an object`);
  const trigger: DriveCommentMentionRegistryTrigger = {
    id,
    match: {},
    sopRef: requiredString(value, "sopRef", "sop_ref"),
  };
  const recordFieldConditions = value.recordFieldConditions ?? value.record_field_conditions;
  if (recordFieldConditions !== undefined) {
    if (!Array.isArray(recordFieldConditions)) {
      throw new Error(`mention registry trigger ${routeId}/${id} record_field_conditions must be an array`);
    }
    trigger.recordFieldConditions = recordFieldConditions.map((condition, index) => {
      if (!isRecord(condition)) {
        throw new Error(`mention registry trigger ${routeId}/${id} record_field_conditions[${index}] must be an object`);
      }
      const field = requiredString(condition, "field");
      const operator = requiredString(condition, "operator");
      if (operator !== "non_empty_string") {
        throw new Error(
          `mention registry trigger ${routeId}/${id} record_field_conditions[${index}].operator is invalid: ${operator}`,
        );
      }
      return { field, operator };
    });
  }
  if (typeof value.priority === "number") trigger.priority = value.priority;
  const ingestModes = value.ingestModes ?? value.ingest_modes;
  if (ingestModes !== undefined) {
    if (!Array.isArray(ingestModes) || ingestModes.length === 0) {
      throw new Error(`mention registry trigger ${routeId}/${id} ingest_modes must be a non-empty array`);
    }
    trigger.ingestModes = ingestModes.map((mode, index) => {
      if (mode !== "mention" && mode !== "poll_unmentioned") {
        throw new Error(
          `mention registry trigger ${routeId}/${id} ingest_modes[${index}] is invalid: ${String(mode)}`,
        );
      }
      return mode;
    });
  }
  const all = stringArrayField(match, "all");
  const any = stringArrayField(match, "any");
  const none = stringArrayField(match, "none");
  if (all) trigger.match.all = all;
  if (any) trigger.match.any = any;
  if (none) trigger.match.none = none;
  return trigger;
}

function parseSopMarkdown(markdown: string): DriveCommentMentionSop {
  const { attrs, body } = splitFrontmatter(markdown);
  const name = requiredString(attrs, "name");
  const targetSession = requiredString(attrs, "targetSession", "target_session");
  const sop: DriveCommentMentionSop = {
    name,
    targetSession,
    body: body.trim(),
  };
  const replyTemplate = stringField(attrs, "replyTemplate", "reply_template");
  if (replyTemplate) sop.replyTemplate = replyTemplate;
  return sop;
}

function splitFrontmatter(markdown: string): { attrs: Record<string, unknown>; body: string } {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0] !== "---") throw new Error("mention SOP must start with YAML frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) throw new Error("mention SOP frontmatter is not closed");
  const attrs: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) attrs[key] = value;
  }
  return { attrs, body: lines.slice(end + 1).join("\n") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordField(
  obj: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return isRecord(value) ? value : undefined;
}

function requiredString(obj: Record<string, unknown>, ...keys: string[]): string {
  const value = stringField(obj, ...keys);
  if (!value) throw new Error(`required string missing: ${keys.join("/")}`);
  return value;
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function isDriveCommentFileType(value: string): value is DriveCommentFileType {
  return value === "doc"
    || value === "docx"
    || value === "sheet"
    || value === "file"
    || value === "slides"
    || value === "bitable";
}
