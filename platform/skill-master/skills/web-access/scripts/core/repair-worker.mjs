#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { buildSelfHealConfig } from "./self-heal-config.mjs";
import { runRepairWorker } from "./repair-runner.mjs";

function requireValue(flag, argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseRepairWorkerArgs(argv = []) {
  const incident = {
    incidentKey: "",
    id: "",
    packName: "",
    profile: "",
    target: "",
    runId: "",
    trigger: "",
    failureKind: "",
    createdAt: ""
  };
  let repoRoot = process.cwd();
  let dbPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      repoRoot = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--db-path") {
      dbPath = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--incident-key") {
      incident.incidentKey = requireValue(arg, argv, index);
      incident.id = incident.incidentKey;
      index += 1;
    } else if (arg === "--pack-name") {
      incident.packName = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--profile") {
      incident.profile = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--target") {
      incident.target = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--run-id") {
      incident.runId = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--trigger") {
      incident.trigger = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--failure-kind") {
      incident.failureKind = requireValue(arg, argv, index);
      index += 1;
    } else if (arg === "--created-at") {
      incident.createdAt = requireValue(arg, argv, index);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    repoRoot,
    dbPath,
    incident
  };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseRepairWorkerArgs(argv);
  const config = buildSelfHealConfig({ cwd: parsed.repoRoot });
  await runRepairWorker({
    repoRoot: parsed.repoRoot,
    config: {
      ...config,
      incidentDbPath: parsed.dbPath || config.incidentDbPath
    },
    incident: parsed.incident
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exit(1);
  });
}
