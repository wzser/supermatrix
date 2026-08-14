import Database from "better-sqlite3";
import {
  recoverCompletedUnstartedSpawn,
  type CompletedUnstartedSpawnRecoveryInput,
} from "../lib/reopenCompletedUnstartedSpawn.ts";

type ParsedArgs = {
  dbPath: string;
  apply: boolean;
  input: CompletedUnstartedSpawnRecoveryInput;
};

function usage(): string {
  return [
    "Usage: tsx scripts/repair/reopen-completed-unstarted-spawn.ts --db <path> --comm-id <id>",
    "  --from <session> --to <session> --child <session> --message-run-id <id>",
    "  --client-request-id <key> --refusal-marker <text> --forbidden-stream-marker <text> [--apply]",
    "Without --apply, validates only. It never starts a child or business CLI.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const valueFlags = new Set([
    "--db",
    "--comm-id",
    "--from",
    "--to",
    "--child",
    "--message-run-id",
    "--client-request-id",
    "--refusal-marker",
    "--forbidden-stream-marker",
  ]);
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (values.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`missing required ${name}`);
    return value;
  };
  return {
    dbPath: required("--db"),
    apply,
    input: {
      commId: required("--comm-id"),
      fromSessionName: required("--from"),
      toSessionName: required("--to"),
      childSessionName: required("--child"),
      messageRunId: required("--message-run-id"),
      clientRequestId: required("--client-request-id"),
      refusalMarker: required("--refusal-marker"),
      forbiddenStreamMarker: required("--forbidden-stream-marker"),
    },
  };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  const db = new Database(parsed.dbPath);
  try {
    const result = recoverCompletedUnstartedSpawn(db, parsed.input, { apply: parsed.apply });
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
