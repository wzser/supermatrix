import { describe, expect, test, vi } from "vitest";
import { createExternalSignalGate } from "../../src/cli/externalSignalGate.ts";

describe("external SuperMatrix signal gate", () => {
  test("denies repeated SIGTERM and SIGINT without escalating either signal", () => {
    const captureFirstSigterm = vi.fn();
    const onDenied = vi.fn();
    const gate = createExternalSignalGate({ captureFirstSigterm, onDenied });

    gate("SIGTERM");
    gate("SIGTERM");
    gate("SIGINT");

    expect(captureFirstSigterm).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls).toEqual([
      ["SIGTERM", 1],
      ["SIGTERM", 2],
      ["SIGINT", 3],
    ]);
  });
});
