import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSessionCategoryLookup } from "../src/sessionCategory.js";

describe("createSessionCategoryLookup", () => {
  it("reads session category by name from SuperMatrix DB", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (name TEXT PRIMARY KEY, category TEXT)");
    db.prepare("INSERT INTO sessions (name, category) VALUES (?, ?)").run("employee001", "员工");

    const lookup = createSessionCategoryLookup(db);

    expect(lookup("employee001")).toBe("员工");
    expect(lookup("missing")).toBeNull();
  });
});
