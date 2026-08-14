import { describe, expect, it } from "vitest";
import { buildDailyCommitBitableRecord } from "../../src/scripts/daily-commit-bitable.js";

describe("daily-commit bitable sync", () => {
  it("builds records with only stable table fields", () => {
    const record = buildDailyCommitBitableRecord("2026-06-02", {
      name: "business-knowledge",
      committed: true,
      message: "docs(kb): add procurement concept",
      filesChanged: 10,
      skippedReason: "",
      autoFixed: true,
    });

    expect(record).toEqual({
      date: "2026-06-02",
      repo_name: "business-knowledge",
      committed: "yes",
      commit_message: "docs(kb): add procurement concept",
      files_changed: "10",
      skipped_reason: "",
    });
    expect(record).not.toHaveProperty("auto_fixed");
  });
});
