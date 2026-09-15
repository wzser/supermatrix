import Database from "better-sqlite3";

export type SessionCategoryLookup = (sessionName: string) => string | null;

export function createSessionCategoryLookup(db: Database.Database): SessionCategoryLookup {
  const stmt = db.prepare("SELECT category FROM sessions WHERE name = ? LIMIT 1");
  return (sessionName: string) => {
    const row = stmt.get(sessionName) as { category?: unknown } | undefined;
    return typeof row?.category === "string" && row.category.trim() !== "" ? row.category : null;
  };
}

export function createSessionCategoryLookupFromPath(dbPath: string): SessionCategoryLookup {
  let lookup: SessionCategoryLookup | null = null;
  return (sessionName: string) => {
    try {
      if (!lookup) {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        lookup = createSessionCategoryLookup(db);
      }
      return lookup(sessionName);
    } catch {
      return null;
    }
  };
}
