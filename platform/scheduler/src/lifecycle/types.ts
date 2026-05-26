export type TriggerResult = {
  triggerOk: boolean;
  pid?: number;
  childSessionId?: string;
  childMessageRunId?: string;
  /**
   * Set when /api/spawn returned `switched_async` — the spawn's sync close did
   * not verify and the framework's watcher has taken it over. The trigger
   * itself succeeded (triggerOk stays true); this is the `spawn_async_items`
   * key for reconciling the eventual outcome.
   */
  asyncRef?: string;
  error?: string;
  exitPromise?: Promise<ExitInfo>;
};

export type ExitInfo = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  exitedAt: number;
};
