import { describe, it, expect } from "vitest";
import { lintTaskInput, type LintInput } from "../../src/classes/creationLint";

const KNOWN_SESSIONS = new Set(["test-owner", "supermatrix-root", "codexroot"]); // size=3 > threshold 2

function baseInput(over: Partial<LintInput> = {}): LintInput {
  return {
    name: "t1",
    description: "中文描述：测试任务用途",
    cron: "0 9 * * *",
    executor: "shell",
    config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
    class: "sync_job",
    category: "数据采集",
    expectedDurationMs: 60_000,
    ownerSession: "test-owner",
    overrides: {
      receiptProof: {
        kind: "external_evidence",
        engine: "sqlite",
        target: { db: "/x.db", sql: "SELECT 1" },
        expectation: ">= 1",
      },
    },
    ...over,
  };
}

describe("lintTaskInput — sqlite target completeness", () => {
  it("rejects external_evidence sqlite with target.db missing", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "sqlite",
          target: { sql: "SELECT 1" },
          expectation: ">= 1",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const e = result.errors.find((x) => x.code === "sqlite_target_incomplete");
      expect(e).toBeDefined();
      expect(e!.field).toBe("overrides.receiptProof.target");
    }
  });

  it("rejects external_evidence sqlite with target.sql missing", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "sqlite",
          target: { db: "/x.db" },
          expectation: ">= 1",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "sqlite_target_incomplete")).toBe(true);
    }
  });

  it("passes when sqlite target has both db and sql", () => {
    const result = lintTaskInput(baseInput(), KNOWN_SESSIONS);
    expect(result.ok).toBe(true);
  });

  it("does NOT fire (rule 1) when overrides=null AND class=monitoring (safe default flows through)", () => {
    // 用 monitoring 而非 sync_job：sync_job 会触发 classed_receipt_must_be_explicit (rule 3b)，
    // 这里只想验证 sqlite_target_incomplete 不会因 user 没给 receiptProof 而误报。
    const input = baseInput({
      class: "monitoring",
      category: "业务巡检",
      overrides: null,
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.errors.find((x) => x.code === "sqlite_target_incomplete")).toBeUndefined();
    }
  });
});

describe("lintTaskInput — sync_job/publication require explicit receiptProof", () => {
  it("rejects sync_job with no overrides at all", () => {
    const input = baseInput({ overrides: null });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "classed_receipt_must_be_explicit")).toBe(true);
    }
  });

  it("rejects publication with overrides but no receiptProof", () => {
    const input = baseInput({
      class: "publication",
      category: "报告产出",
      overrides: { weight: "light" },  // overrides exists but no receiptProof
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "classed_receipt_must_be_explicit")).toBe(true);
    }
  });

  it("accepts sync_job with explicit receiptProof override", () => {
    // baseInput already has explicit receipt; this is the baseline
    expect(lintTaskInput(baseInput(), KNOWN_SESSIONS).ok).toBe(true);
  });

  it("does NOT fire on monitoring (class default exit_zero is safe)", () => {
    const input = baseInput({
      class: "monitoring",
      category: "业务巡检",
      overrides: null,
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });

  it("does NOT fire on delegation (class default session_reply_content_check is meaningful)", () => {
    const input = baseInput({
      class: "delegation",
      category: "跨会话委派",
      executor: "http",
      config: { url: "http://x", method: "POST", timeout: 5000, body: { target: "test-owner", prompt: "do X, reply REPORT:" } },
      overrides: null,
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });
});

describe("lintTaskInput — file target completeness", () => {
  it("rejects external_evidence file with target.path missing", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "file",
          target: {},
          expectation: "mtime > trigger",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "file_target_incomplete")).toBe(true);
    }
  });

  it("passes when file target has path", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "file",
          target: { path: "/tmp/x.json" },
          expectation: "mtime > trigger",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });
});

describe("lintTaskInput — http_get target completeness", () => {
  it("rejects http_get with target.url missing", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "http_get",
          target: {},
          expectation: ">= 200",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "http_get_target_incomplete")).toBe(true);
    }
  });

  it("passes when http_get target has url", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "http_get",
          target: { url: "http://x/healthz" },
          expectation: ">= 200",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });
});

describe("lintTaskInput — receipt kind / engine whitelist", () => {
  it("rejects unknown receiptProof.kind", () => {
    const input = baseInput({
      overrides: { receiptProof: { kind: "yolo" as any } },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "receipt_kind_unknown")).toBe(true);
    }
  });

  it("rejects unknown external_evidence engine", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "yolodb" as any,
          target: {},
          expectation: ">= 1",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "engine_unknown")).toBe(true);
    }
  });

  it("accepts all known receiptProof kinds", () => {
    for (const k of ["exit_zero", "session_reply_present"] as const) {
      const input = baseInput({
        overrides: { receiptProof: { kind: k, ...(k === "session_reply_present" ? { timeoutMs: 60000 } : {}) } as any },
      });
      expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
    }
  });
});

describe("lintTaskInput — expectation per engine", () => {
  it("rejects mtime>trigger on sqlite engine", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "sqlite",
          target: { db: "/x.db", sql: "SELECT 1" },
          expectation: "mtime > trigger",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "expectation_invalid_for_engine")).toBe(true);
    }
  });

  it("accepts numeric expectation on file engine (file size check)", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "file",
          target: { path: "/x" },
          expectation: ">= 1024",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });

  it("rejects bitable engine outright (runtime is deferred — always fails)", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "bitable",
          target: { baseToken: "b", tableId: "t" },
          expectation: ">= 1",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "engine_deferred")).toBe(true);
    }
  });

  it("rejects internal kind name 'mtime_gt_trigger' on any engine", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "file",
          target: { path: "/x" },
          expectation: "mtime_gt_trigger",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(false);
  });

  it("accepts mtime>trigger on file", () => {
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence",
          engine: "file",
          target: { path: "/x" },
          expectation: "mtime > trigger",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });

  it.each(["sqlite", "http_get"] as const)("accepts numeric on %s engine", (eng) => {
    const target = eng === "sqlite" ? { db: "/x.db", sql: "SELECT 1" }
      : { url: "http://x", jsonPath: "$.n" };
    const input = baseInput({
      overrides: {
        receiptProof: {
          kind: "external_evidence" as const,
          engine: eng,
          target,
          expectation: ">= 1",
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    if (eng === "sqlite") {
      expect(result.ok).toBe(true);
    } else {
      // http_get: no target completeness rule yet, expectation valid → ok
      if (!result.ok) {
        expect(result.errors.find((x) => x.code === "expectation_invalid_for_engine")).toBeUndefined();
      }
    }
  });
});

describe("lintTaskInput — kind vs executor mismatch", () => {
  it("rejects sync_job (default kind=script) + executor=http", () => {
    const input = baseInput({
      executor: "http",
      config: { url: "http://localhost:3501/api/spawn", method: "POST", timeout: 5000 },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "kind_executor_mismatch")).toBe(true);
    }
  });

  it("rejects delegation (default kind=session) + executor=shell", () => {
    const input = baseInput({
      class: "delegation",
      category: "跨会话委派",
      executor: "shell",
      config: { command: "echo REPORT:", cwd: "/tmp", timeout: 5000 },
      overrides: {
        receiptProof: { kind: "session_reply_content_check", pattern: "REPORT:", patternType: "contains", timeoutMs: 60000 },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "kind_executor_mismatch")).toBe(true);
    }
  });

  it("accepts override flipping kind to match (sync_job + overrides.kind=session + executor=http)", () => {
    const input = baseInput({
      executor: "http",
      config: { url: "http://x", method: "POST", timeout: 5000 },
      overrides: {
        kind: "session",
        receiptProof: {
          kind: "external_evidence",
          engine: "sqlite",
          target: { db: "/x.db", sql: "SELECT 1" },
          expectation: ">= 1",
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });

  it("accepts matching defaults (monitoring=script + executor=shell)", () => {
    expect(
      lintTaskInput(baseInput({
        class: "monitoring",
        category: "业务巡检",
        overrides: undefined,
      }), KNOWN_SESSIONS).ok,
    ).toBe(true);
  });
});

describe("lintTaskInput — session_reply_content_check json_path is unsupported", () => {
  it("rejects json_path patternType (runtime always fails it)", () => {
    const input = baseInput({
      class: "delegation",
      category: "跨会话委派",
      executor: "http",
      config: {
        url: "http://x", method: "POST", timeout: 30000,
        body: { target: "test-owner", prompt: "do X" },
      },
      overrides: {
        receiptProof: {
          kind: "session_reply_content_check",
          pattern: "$.report",
          patternType: "json_path",
          timeoutMs: 60000,
        },
      },
    });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "session_reply_json_path_unsupported")).toBe(true);
    }
  });

  it("accepts contains patternType", () => {
    const input = baseInput({
      class: "delegation",
      category: "跨会话委派",
      executor: "http",
      config: {
        url: "http://x", method: "POST", timeout: 30000,
        body: { target: "test-owner", prompt: "回 REPORT:" },
      },
      overrides: {
        receiptProof: {
          kind: "session_reply_content_check",
          pattern: "REPORT:",
          patternType: "contains",
          timeoutMs: 60000,
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });

  it("accepts regex patternType", () => {
    const input = baseInput({
      class: "delegation",
      category: "跨会话委派",
      executor: "http",
      config: {
        url: "http://x", method: "POST", timeout: 30000,
        body: { target: "test-owner", prompt: "do X" },
      },
      overrides: {
        receiptProof: {
          kind: "session_reply_content_check",
          pattern: "^(REPORT|今日无新信号)",
          patternType: "regex",
          timeoutMs: 60000,
        },
      },
    });
    expect(lintTaskInput(input, KNOWN_SESSIONS).ok).toBe(true);
  });
});

describe("lintTaskInput — ownerSession in known set", () => {
  it("rejects unknown ownerSession", () => {
    const input = baseInput({ ownerSession: "ghost-session" });
    const result = lintTaskInput(input, KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "owner_unknown")).toBe(true);
    }
  });

  it("accepts known ownerSession", () => {
    expect(lintTaskInput(baseInput(), KNOWN_SESSIONS).ok).toBe(true);
  });
});

describe("lintTaskInput — description quality", () => {
  it("rejects empty description", () => {
    const result = lintTaskInput(baseInput({ description: "" }), KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "description_empty")).toBe(true);
    }
  });

  it("rejects undefined description", () => {
    expect(lintTaskInput(baseInput({ description: undefined }), KNOWN_SESSIONS).ok).toBe(false);
  });

  it("rejects 执行命令: placeholder", () => {
    const result = lintTaskInput(baseInput({ description: "执行命令: bash -c 'echo hi'" }), KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "description_placeholder")).toBe(true);
    }
  });

  it("rejects 调用接口: placeholder", () => {
    expect(lintTaskInput(baseInput({ description: "调用接口: POST http://x" }), KNOWN_SESSIONS).ok).toBe(false);
  });

  it("rejects English-only description", () => {
    const result = lintTaskInput(baseInput({ description: "Poll every 5 min" }), KNOWN_SESSIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((x) => x.code === "description_no_chinese")).toBe(true);
    }
  });

  it("accepts well-formed Chinese description", () => {
    expect(
      lintTaskInput(baseInput({ description: "每 10 分钟扫订单表，用于补货告警" }), KNOWN_SESSIONS).ok,
    ).toBe(true);
  });
});
