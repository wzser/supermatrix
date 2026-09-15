import { expect, test, vi } from "vitest";
import { reportSourceChange } from "../../src/cli/sourceWatcher.ts";
import type { Logger } from "../../src/ports/Logger.ts";

test("source changes are reported without requesting a reload", () => {
  const warn = vi.fn();
  const logger = { warn } as Pick<Logger, "warn">;

  reportSourceChange(logger, "app/resultSinkEngine.ts");

  expect(warn).toHaveBeenCalledWith(
    "src changed; automatic reload disabled",
    expect.objectContaining({
      file: "app/resultSinkEngine.ts",
      action: "wait for scheduled-daily or route a maintenance request to codexroot",
    }),
  );
});
