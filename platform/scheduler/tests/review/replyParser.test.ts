import { describe, it, expect } from "vitest";
import { parseReply } from "../../src/review/replyParser.js";

const EXAMPLE_REPLY = `REVIEW DECISIONS — 4 entries

review_id: r1
decision: patched
reason: cron 频率 1 min 太密，估算时长够 5 min，肯定 overlap；改为 5 min
patch: { "cron": "*/5 * * * *", "overlapPolicy": "skip_if_running" }

review_id: r2
decision: approved
reason: 看上去 ok

review_id: r3
decision: rejected
reason: business 任务塞 shell executor，应当用 http executor spawn 给业务 session
disable: true

review_id: r4
decision: escalated
reason: 不确定 ownerSession 是否真要 nas`;

describe("parseReply", () => {
  it("parses 4 mixed decisions from canonical example", () => {
    const result = parseReply(EXAMPLE_REPLY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions).toHaveLength(4);

    expect(result.decisions[0]).toMatchObject({
      reviewId: "r1",
      decision: "patched",
      patch: { cron: "*/5 * * * *", overlapPolicy: "skip_if_running" },
    });
    expect(result.decisions[1]).toMatchObject({ reviewId: "r2", decision: "approved" });
    expect(result.decisions[1].reason).toContain("看上去 ok");

    expect(result.decisions[2]).toMatchObject({
      reviewId: "r3",
      decision: "rejected",
      disable: true,
    });

    expect(result.decisions[3]).toMatchObject({ reviewId: "r4", decision: "escalated" });
  });

  it("defaults disable to true for rejected when omitted", () => {
    const text = `review_id: r1
decision: rejected
reason: bad`;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0].disable).toBe(true);
  });

  it("honors explicit disable=false on rejected", () => {
    const text = `review_id: r1
decision: rejected
reason: advisory only
disable: false`;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0].disable).toBe(false);
  });

  it("tolerates markdown bolding on field labels", () => {
    const text = `**review_id:** r1
**decision:** approved
**reason:** fine`;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0]).toMatchObject({ reviewId: "r1", decision: "approved" });
  });

  it("tolerates multi-line JSON in patch field", () => {
    const text = `review_id: r1
decision: patched
reason: see patch
patch: {
  "cron": "0 * * * *",
  "expectedDurationMs": 300000
}`;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0].patch).toEqual({ cron: "0 * * * *", expectedDurationMs: 300000 });
  });

  it("tolerates code-fence wrapping of patch JSON", () => {
    const text = `review_id: r1
decision: patched
reason: x
patch: \`\`\`json
{ "cron": "0 * * * *" }
\`\`\``;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0].patch).toEqual({ cron: "0 * * * *" });
  });

  it("returns ok:false with partial on unknown decision value", () => {
    const text = `review_id: r1
decision: approved
reason: fine

review_id: r2
decision: yolo
reason: bad`;
    const result = parseReply(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.partial).toHaveLength(1);
    expect(result.partial![0].reviewId).toBe("r1");
    expect(result.error).toContain("yolo");
  });

  it("returns ok:false when reason missing", () => {
    const text = `review_id: r1
decision: approved`;
    const result = parseReply(text);
    expect(result.ok).toBe(false);
  });

  it("returns empty decisions for empty text", () => {
    const result = parseReply("");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions).toHaveLength(0);
  });

  it("ignores leading 'REVIEW DECISIONS — N entries' header line", () => {
    const text = `REVIEW DECISIONS — 1 entries

review_id: r1
decision: approved
reason: fine`;
    const result = parseReply(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions).toHaveLength(1);
  });
});
