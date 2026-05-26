import { buildSessionCatalog } from "../domain/sessionCatalog.ts";
import type { AbsolutePath } from "../domain/ids.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import type { WorkspaceFs } from "../ports/WorkspaceFs.ts";

export type SessionCatalogServiceDeps = {
  store: BindingStore;
  fs: WorkspaceFs;
  // Absolute path of the single global catalog file. Each workspace reaches
  // it through a symlink, so one write here updates the whole fleet at once.
  catalogPath: AbsolutePath;
  clock: Clock;
  eventBus?: EventBus;
  logger?: Logger;
};

export function createSessionCatalogService(deps: SessionCatalogServiceDeps) {
  // Rebuild the global catalog from the sessions table. This replaces the old
  // per-session CONSTITUTION rerenderAll: instead of writing 68 markdown files
  // (one per workspace, each carrying a copy of the roster), it writes one
  // JSON file. The trigger points are unchanged — session create / delete /
  // backend switch — only the output shape moved from markdown to JSON.
  async function regenerateCatalog(reason: string): Promise<void> {
    const sessions = await deps.store.listActiveSessions();
    const catalog = buildSessionCatalog(sessions, deps.clock.now());
    await deps.fs.writeFile(
      deps.catalogPath,
      JSON.stringify(catalog, null, 2) + "\n",
    );
    deps.logger?.debug("catalog regenerated", {
      reason,
      sessions: catalog.sessions.length,
    });
    if (deps.eventBus) {
      await deps.eventBus.publish({ kind: "catalog_updated", reason });
    }
  }

  return { regenerateCatalog };
}
