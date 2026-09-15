// src/domain/kimiSessionIndex.ts
//
// Shared lookup for the kimi CLI's on-disk session layout: `session_index.jsonl`
// in the kimi home maps sessionId → sessionDir, which keeps path resolution
// robust (no reverse-engineering the wd_<hash> layout). Used by the backend
// adapter (usage accounting) and the app layer (autonomous-turn watch).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultKimiHome(env: NodeJS.ProcessEnv): string {
  return env["SM_KIMI_CODE_HOME"] ?? join(homedir(), ".kimi-code");
}

export async function resolveSessionDir(
  kimiHome: string,
  sessionId: string,
): Promise<string | null> {
  const indexPath = join(kimiHome, "session_index.jsonl");
  let lines: string[];
  try {
    lines = (await readFile(indexPath, "utf-8")).split("\n");
  } catch {
    return null;
  }
  // Last match wins — the index appends on every (re)open.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown };
      if (rec.sessionId === sessionId && typeof rec.sessionDir === "string") {
        return rec.sessionDir;
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}
