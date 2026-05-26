import { describe, expect, test } from "vitest";
import {
  resolveCodexDefaultModel,
  type ExecCmd,
} from "../../../src/adapters/backend-codex/defaultModelResolver.ts";

function fakeExec(stdout: string): ExecCmd {
  return async () => ({ stdout });
}

function failingExec(error: string): ExecCmd {
  return async () => {
    throw new Error(error);
  };
}

describe("resolveCodexDefaultModel", () => {
  test("picks lowest-priority list-visible API-supported slug", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "gpt-5.5", priority: 0, visibility: "list", supported_in_api: true },
        { slug: "gpt-5.4", priority: 2, visibility: "list", supported_in_api: true },
        { slug: "gpt-5.4-mini", priority: 4, visibility: "list", supported_in_api: true },
      ],
    });
  const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result).toEqual({
      kind: "ok",
      slug: "gpt-5.5",
      models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
      totalCandidates: 3,
    });
  });

  test("filters out hidden models", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "codex-auto-review", priority: 0, visibility: "hide", supported_in_api: true },
        { slug: "gpt-5.5", priority: 1, visibility: "list", supported_in_api: true },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind === "ok" && result.slug).toBe("gpt-5.5");
  });

  test("filters out supported_in_api=false (e.g. spark variants)", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "gpt-5.3-codex-spark", priority: 0, visibility: "list", supported_in_api: false },
        { slug: "gpt-5.5", priority: 1, visibility: "list", supported_in_api: true },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind === "ok" && result.slug).toBe("gpt-5.5");
  });

  test("missing priority sorts as max — explicit priorities win, catalog order breaks ties among missing", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "no-priority-a", visibility: "list", supported_in_api: true },
        { slug: "gpt-5.5", priority: 0, visibility: "list", supported_in_api: true },
        { slug: "no-priority-b", visibility: "list", supported_in_api: true },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind === "ok" && result.slug).toBe("gpt-5.5");
  });

  test("all priorities missing → first list-visible candidate wins (catalog order)", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "first", visibility: "list", supported_in_api: true },
        { slug: "second", visibility: "list", supported_in_api: true },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind === "ok" && result.slug).toBe("first");
  });

  test("exec failure → fail with descriptive error", async () => {
    const result = await resolveCodexDefaultModel({
      execCmd: failingExec("ENOENT: codex not found"),
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") expect(result.error).toContain("ENOENT");
  });

  test("non-JSON stdout → fail", async () => {
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec("not json at all") });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") expect(result.error).toContain("not JSON");
  });

  test("missing .models[] → fail", async () => {
    const result = await resolveCodexDefaultModel({
      execCmd: fakeExec(JSON.stringify({ something_else: 1 })),
    });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") expect(result.error).toContain(".models[]");
  });

  test("no candidates pass filter → fail", async () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "hidden", visibility: "hide", supported_in_api: true },
        { slug: "no-api", visibility: "list", supported_in_api: false },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") expect(result.error).toContain("no candidate models");
  });

  test("entries missing slug or with non-string slug are skipped", async () => {
    const stdout = JSON.stringify({
      models: [
        { priority: 0, visibility: "list", supported_in_api: true }, // no slug
        { slug: "", priority: 0, visibility: "list", supported_in_api: true }, // empty
        { slug: 42, priority: 0, visibility: "list", supported_in_api: true }, // non-string
        { slug: "gpt-5.5", priority: 1, visibility: "list", supported_in_api: true },
      ],
    });
    const result = await resolveCodexDefaultModel({ execCmd: fakeExec(stdout) });
    expect(result.kind === "ok" && result.slug).toBe("gpt-5.5");
  });
});
