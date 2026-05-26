import { describe, it, expect } from "vitest";
import { renderMigrationProposalText } from "../../src/migration/proposalText.js";

describe("renderMigrationProposalText", () => {
  it("includes task name, suggested class, CONFIRM/MODIFY/LATER/DISABLE menu", () => {
    const text = renderMigrationProposalText({
      taskName: "amz-sql-dashenlin-logistics-daily",
      taskCron: "0 1 * * *",
      suggestedClass: "sync_job",
      suggestedExpectedDurationMs: 1_800_000,
      executorSummary: "shell: python /path/run.py",
      laterCount: 0,
    });
    expect(text).toContain("amz-sql-dashenlin-logistics-daily");
    expect(text).toContain("sync_job");
    expect(text).toContain("1800000");
    expect(text).toContain("python /path/run.py");
    expect(text).toContain("CONFIRM");
    expect(text).toContain("MODIFY");
    expect(text).toContain("LATER");
    expect(text).toContain("DISABLE");
    expect(text).toContain("migration proposal");
  });

  it("notes when this is a re-send after previous LATER", () => {
    const text = renderMigrationProposalText({
      taskName: "t",
      taskCron: "0 * * * *",
      suggestedClass: "publication",
      suggestedExpectedDurationMs: 60000,
      executorSummary: "shell: x",
      laterCount: 1,
    });
    expect(text).toMatch(/第\s*2\s*次|again|resend|重发/);
  });
});
