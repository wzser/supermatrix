import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../../ports/Logger.ts";
import type { PredicateDbConnection, PredicateDbRegistry } from "../../ports/PredicateDbRegistry.ts";

export const DEFAULT_PREDICATE_DB_REGISTRY_PATH =
  path.join(process.env.SM_RUNTIME_ROOT ?? path.join(process.cwd(), "..", "SuperMatrixRuntime"), "config", "spawn-watcher-db-registry.json");

type RawRegistryEntry = {
  kind: string;
  path?: string;
  path_env?: string;
  readonly?: boolean;
  mode?: string;
};

export type SqlitePredicateDbRegistryOptions = {
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Logger, "warn">;
};

function emptyRegistry(): PredicateDbRegistry {
  return {
    resolve() {
      return undefined;
    },
  };
}

function parseRegistryFile(registryPath: string): Record<string, RawRegistryEntry> {
  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("predicate DB registry must be a JSON object");
  }
  return raw as Record<string, RawRegistryEntry>;
}

export function createPredicateDbRegistryFromConnections(
  connections: PredicateDbConnection[]
): PredicateDbRegistry {
  const byRef = new Map(connections.map((connection) => [connection.dbRef, connection]));
  return {
    resolve(dbRef) {
      return byRef.get(dbRef);
    },
  };
}

export function loadSqlitePredicateDbRegistry(
  options: SqlitePredicateDbRegistryOptions = {}
): PredicateDbRegistry {
  const registryPath = options.registryPath ?? DEFAULT_PREDICATE_DB_REGISTRY_PATH;
  const env = options.env ?? process.env;
  const logger = options.logger;

  if (!existsSync(registryPath)) {
    logger?.warn("predicate DB registry file missing; using empty registry", { registryPath });
    return emptyRegistry();
  }

  const rawEntries = parseRegistryFile(registryPath);
  const connections: PredicateDbConnection[] = [];

  for (const [dbRef, entry] of Object.entries(rawEntries)) {
    if (entry.kind !== "sqlite") {
      logger?.warn("predicate DB registry skipped non-sqlite entry in 0.1", { dbRef, kind: entry.kind });
      continue;
    }
    const dbPath = entry.path ?? (entry.path_env ? env[entry.path_env] : undefined);
    if (!dbPath) {
      logger?.warn("predicate DB registry skipped sqlite entry without resolved path", { dbRef });
      continue;
    }
    connections.push({
      dbRef,
      kind: "sqlite",
      path: dbPath,
      readonly: entry.readonly ?? true,
      ...(entry.mode ? { mode: entry.mode } : {}),
    });
  }

  return createPredicateDbRegistryFromConnections(connections);
}
