import { describe, expect, test } from "vitest";
import { createPinoLogger } from "../../../src/adapters/logger-pino/index.ts";

describe("PinoLogger", () => {
  test("emits JSON to sink and supports child", () => {
    const sink: string[] = [];
    const logger = createPinoLogger("debug", (line) => sink.push(line));
    logger.info("hello", { k: 1 });
    const child = logger.child({ component: "test" });
    child.warn("boom");
    expect(sink.length).toBe(2);
    expect(sink[0]).toContain("hello");
    expect(sink[1]).toContain("test");
  });
});
