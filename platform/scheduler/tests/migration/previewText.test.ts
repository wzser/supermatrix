import { describe, it, expect } from "vitest";
import { renderMigrationPreview } from "../../src/migration/previewText.js";

describe("renderMigrationPreview", () => {
  it("lists every task with its suggested class", () => {
    const text = renderMigrationPreview([
      { taskName: "t1", suggestedClass: "sync_job" },
      { taskName: "t2", suggestedClass: "publication" },
    ]);
    expect(text).toContain("scheduler 预告");
    expect(text).toContain("无需回复");
    expect(text).toContain("t1");
    expect(text).toContain("sync_job");
    expect(text).toContain("t2");
    expect(text).toContain("publication");
  });

  it("notes that structured proposals will follow", () => {
    const text = renderMigrationPreview([{ taskName: "x", suggestedClass: "sync_job" }]);
    expect(text).toMatch(/migration proposal/i);
  });
});
