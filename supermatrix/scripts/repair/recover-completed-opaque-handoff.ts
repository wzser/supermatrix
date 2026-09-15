import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import {
  readOpaqueRecoveryProof,
  recoverCompletedOpaqueHandoff,
  type CompletedOpaqueHandoffRecoveryInput,
} from "../lib/recoverCompletedOpaqueHandoff.ts";

function usage(): string {
  return [
    "Usage: tsx scripts/repair/recover-completed-opaque-handoff.ts --db <path>",
    "  --comm-id <id> --client-request-id <key> --source-request <json> --proof <json> [--apply]",
    "Without --apply, validates exact envelope bytes/digest and no-side-effect proof only.",
    "--apply only changes this comm metadata and releases its idempotency key after a closed/delivered transport-failure receipt; it never starts a child or business CLI.",
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const flags = new Set(["--db", "--comm-id", "--client-request-id", "--source-request", "--proof"]);
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--apply") { apply = true; continue; }
    if (!flags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (values.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    values.set(arg, value);
    i += 1;
  }
  const required = (flag: string) => {
    const value = values.get(flag)?.trim();
    if (!value) throw new Error(`missing required ${flag}`);
    return value;
  };
  return {
    dbPath: required("--db"),
    apply,
    input: {
      commId: required("--comm-id"),
      clientRequestId: required("--client-request-id"),
      sourcePrompt: (JSON.parse(readFileSync(required("--source-request"), "utf8")) as { prompt: string }).prompt,
      proof: readOpaqueRecoveryProof(required("--proof")),
    } satisfies CompletedOpaqueHandoffRecoveryInput,
  };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  const db = new Database(parsed.dbPath);
  try {
    const result = recoverCompletedOpaqueHandoff(db, parsed.input, { apply: parsed.apply });
    console.log(JSON.stringify({ ok: result.outcome !== "blocked", apply: parsed.apply, ...result }));
    if (result.outcome === "blocked") process.exitCode = 2;
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
