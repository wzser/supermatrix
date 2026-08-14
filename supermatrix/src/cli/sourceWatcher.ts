import { watch } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import type { ProcessLifecycle } from "../app/processLifecycle.ts";
import type { Logger } from "../ports/Logger.ts";

export type SourceWatcherOptions = {
  srcDir: string;
  lifecycle: ProcessLifecycle;
  logger?: Logger;
  debounceMs?: number;
  startupGraceMs?: number;
};

// Watches `srcDir` recursively for .ts file changes. On each stable change
// (debounced), runs `tsc --noEmit` as a pre-flight check before marking the
// restart controller pending. If the typecheck fails, the restart is deferred
// so a partially-written or broken file won't crash-loop the process.
//
// If new file changes arrive while the typecheck is running, the check is
// cancelled and the debounce restarts — so we always check the latest state.
export function startSourceWatcher(opts: SourceWatcherOptions): () => void {
  const debounceMs = opts.debounceMs ?? 300;
  const startupGraceMs = opts.startupGraceMs ?? 5_000;
  const ac = new AbortController();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingFile: string | undefined;
  let checkChild: ReturnType<typeof execFile> | undefined;
  let checkCancelled = false;
  const bootTime = Date.now();
  const projectRoot = path.resolve(opts.srcDir, "..");
  const tscPath = path.join(projectRoot, "node_modules", ".bin", "tsc");

  function cancelCheck() {
    if (checkChild) {
      checkCancelled = true;
      checkChild.kill();
      checkChild = undefined;
    }
  }

  function scheduleCheck() {
    cancelCheck();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runPreflightAndRestart();
    }, debounceMs);
  }

  async function runPreflightAndRestart() {
    checkCancelled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        checkChild = execFile(tscPath, ["--noEmit"], {
          cwd: projectRoot,
          timeout: 30_000,
        }, (err) => {
          checkChild = undefined;
          if (err) reject(err);
          else resolve();
        });
      });
    } catch {
      if (checkCancelled || ac.signal.aborted) return;
      opts.logger?.warn("src changed but typecheck failed — deferring restart", {
        file: pendingFile,
      });
      return;
    }
    if (ac.signal.aborted) return;
    opts.lifecycle.requestRestart(
      `src change: ${pendingFile ?? "(unknown)"}`,
      { source: "src-watcher" },
    );
  }

  void (async () => {
    try {
      const iterable = watch(opts.srcDir, { recursive: true, signal: ac.signal });
      for await (const event of iterable) {
        if (ac.signal.aborted) break;
        const filename = event.filename;
        if (!filename || !filename.endsWith(".ts")) continue;
        if (Date.now() - bootTime < startupGraceMs) continue;
        pendingFile = filename;
        scheduleCheck();
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.name === "AbortError" || ac.signal.aborted) return;
      opts.logger?.error("source watcher crashed", { err: error.message });
    }
  })();

  return () => {
    ac.abort();
    cancelCheck();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };
}
