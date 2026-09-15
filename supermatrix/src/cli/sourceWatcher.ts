import { watch } from "node:fs/promises";
import type { Logger } from "../ports/Logger.ts";

export type SourceWatcherOptions = {
  srcDir: string;
  logger?: Logger;
  debounceMs?: number;
  startupGraceMs?: number;
};

// Source changes remain visible to operators, but never reload SuperMatrix.
// The only authorized reload path is the codexroot maintenance gate; the
// scheduler-owned daily task may only create the codexroot evaluator run.
export function reportSourceChange(
  logger: Pick<Logger, "warn"> | undefined,
  file: string | undefined,
): void {
  logger?.warn("src changed; automatic reload disabled", {
    file: file ?? "(unknown)",
    action: "wait for scheduled-daily or route a maintenance request to codexroot",
  });
}

// Watches `srcDir` recursively for .ts file changes and emits a debounced
// operator-visible warning. It deliberately has no ProcessLifecycle dependency:
// saving a source file must not interrupt active runs.
export function startSourceWatcher(opts: SourceWatcherOptions): () => void {
  const debounceMs = opts.debounceMs ?? 300;
  const startupGraceMs = opts.startupGraceMs ?? 5_000;
  const ac = new AbortController();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingFile: string | undefined;
  const bootTime = Date.now();

  function scheduleReport() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      if (ac.signal.aborted) return;
      reportSourceChange(opts.logger, pendingFile);
    }, debounceMs);
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
        scheduleReport();
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.name === "AbortError" || ac.signal.aborted) return;
      opts.logger?.error("source watcher crashed", { err: error.message });
    }
  })();

  return () => {
    ac.abort();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };
}
