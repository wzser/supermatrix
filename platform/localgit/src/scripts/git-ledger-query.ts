import { join } from "node:path";
import {
  filterGitLedgerEntries,
  readGitLedgerEntries,
  type GitLedgerOperation,
} from "./git-ledger.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const ledgerPath = readArg("--ledger") ?? join(process.cwd(), "data", "git-ledger.jsonl");
const repo = readArg("--repo");
const repoPath = readArg("--repo-path");
const operation = readArg("--operation") as GitLedgerOperation | undefined;
const since = readArg("--since");
const limitRaw = readArg("--limit");
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;

const entries = filterGitLedgerEntries(readGitLedgerEntries(ledgerPath), {
  repo,
  repoPath,
  operation,
  since,
  limit: Number.isFinite(limit) ? limit : 50,
});

if (entries.length === 0) {
  console.log("No ledger entries matched.");
  process.exit(0);
}

for (const entry of entries) {
  const sha = entry.commit_sha ? ` ${entry.commit_sha.slice(0, 12)}` : "";
  const reason = entry.skipped_reason ? ` — ${entry.skipped_reason}` : "";
  const message = entry.message ? ` — ${entry.message}` : "";
  console.log(
    `${entry.recorded_at} ${entry.operation}${sha} ${entry.repo}@${entry.branch} ${entry.files_changed} files${message}${reason}`,
  );
}
