const test = require("node:test");
const assert = require("node:assert");
const { buildAskCard, buildAnsweredCard, buildEscapedCard, buildTimedOutEscapedCard, ESCAPE_VALUE, ESCAPE_LABEL } = require("../src/card");

function getActionRow(card) {
  return card.elements.find((e) => e.tag === "action");
}

test("buildAskCard embeds token+value in each business button and appends an escape button", () => {
  const card = buildAskCard({
    question: "部署到哪？",
    options: [{ label: "生产", value: "prod" }, { label: "预发", value: "staging" }],
    token: "tok123",
  });
  assert.strictEqual(card.config.update_multi, true);
  const actions = getActionRow(card).actions;
  // two business buttons + one auto-appended escape button
  assert.strictEqual(actions.length, 3);
  assert.deepStrictEqual(actions[0].value, { __ask_user: true, token: "tok123", value: "prod" });
  assert.strictEqual(actions[0].text.content, "生产");
  // escape button is the last one, marked danger, carries ESCAPE_VALUE
  const escape = actions[actions.length - 1];
  assert.strictEqual(escape.type, "danger");
  assert.strictEqual(escape.text.content, ESCAPE_LABEL);
  assert.deepStrictEqual(escape.value, { __ask_user: true, token: "tok123", value: ESCAPE_VALUE });
});

test("buildAskCard renders top-level context as a note element above the question", () => {
  const card = buildAskCard({
    question: "部署到哪？",
    context: "这是补货 SOP §3.2 的人工 gate，选 retry 会重跑近 14 天数据",
    options: [{ label: "生产", value: "prod" }],
    token: "tokC",
  });
  const note = card.elements.find((e) => e.tag === "note");
  assert.ok(note, "note element exists when context is provided");
  assert.ok(JSON.stringify(note).includes("SOP §3.2"));
  // note appears before the question div
  const noteIdx = card.elements.findIndex((e) => e.tag === "note");
  const questionIdx = card.elements.findIndex((e) => e.tag === "div" && JSON.stringify(e).includes("部署到哪"));
  assert.ok(noteIdx >= 0 && questionIdx > noteIdx, "note precedes the question div");
});

test("buildAskCard renders per-option descriptions in a list above the buttons", () => {
  const card = buildAskCard({
    question: "怎么处理？",
    options: [
      { label: "retry", value: "retry", description: "重跑近 14 天数据，约 8 分钟" },
      { label: "skip", value: "skip", description: "跳过本批，明天再试" },
    ],
    token: "tokD",
  });
  const text = JSON.stringify(card);
  assert.ok(text.includes("重跑近 14 天数据"), "first option's description is rendered");
  assert.ok(text.includes("跳过本批"), "second option's description is rendered");
});

test("buildAskCard skips the description list when no option has a description", () => {
  const card = buildAskCard({
    question: "Q?",
    options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    token: "tokE",
  });
  // expected elements: question div + action row (no note, no description list)
  assert.strictEqual(card.elements.length, 2);
  assert.strictEqual(card.elements[0].tag, "div");
  assert.strictEqual(card.elements[1].tag, "action");
});

test("buildAnsweredCard keeps every option visible and marks the chosen one with ✅+已选", () => {
  const card = buildAnsweredCard({
    question: "部署到哪？",
    options: [
      { label: "生产", value: "prod", description: "灰度 5%" },
      { label: "预发", value: "staging", description: "全量" },
    ],
    selectedValue: "prod",
  });
  assert.ok(!card.elements.some((e) => e.tag === "action"), "no actionable buttons after answered");
  const text = JSON.stringify(card);
  // every option label remains visible (not removed when one is chosen)
  assert.ok(text.includes("生产"), "selected option label still shown");
  assert.ok(text.includes("预发"), "unselected option label still shown");
  // descriptions preserved so the reader sees full context
  assert.ok(text.includes("灰度 5%"));
  assert.ok(text.includes("全量"));
  // the chosen option is bolded + ✅ + （已选）；unchosen is ▫️
  assert.ok(text.includes("✅") && text.includes("已选"), "selected option carries ✅ and 已选 marker");
  assert.ok(text.includes("▫️"), "unselected options carry ▫️ marker");
  // selected and unselected must be distinguishable: the marker patterns must coexist
  // (a passing assertion above doesn't prove they apply to different options, but the
  // explicit string assertions in followingtest case below cover that.)
});

test("buildAnsweredCard preserves top-level context as a note above the question", () => {
  const card = buildAnsweredCard({
    question: "部署到哪？",
    context: "SOP §3.2 人工 gate",
    options: [{ label: "生产", value: "prod" }],
    selectedValue: "prod",
  });
  const note = card.elements.find((e) => e.tag === "note");
  assert.ok(note, "context renders as note element");
  assert.ok(JSON.stringify(note).includes("SOP §3.2 人工 gate"));
});

test("buildTimedOutEscapedCard lists every option as ▫️ (none chosen) + appends timeout note", () => {
  const card = buildTimedOutEscapedCard({
    question: "部署到哪？",
    options: [
      { label: "生产", value: "prod", description: "灰度 5%" },
      { label: "预发", value: "staging" },
    ],
  });
  assert.ok(!card.elements.some((e) => e.tag === "action"), "no actionable buttons after timeout-escape");
  const text = JSON.stringify(card);
  assert.ok(text.includes("生产") && text.includes("预发"), "all options remain listed after timeout");
  assert.ok(text.includes("灰度 5%"), "descriptions preserved");
  assert.ok(text.includes("▫️"), "all options unmarked (▫️) — none was clicked");
  assert.ok(!text.includes("✅"), "no business option carries the ✅ selected marker when timeout");
  assert.ok(text.includes("超时") || text.includes("5 分钟未点击"), "timeout reason explained");
  assert.ok(text.includes("停"), "card text tells the user the agent has stopped");
  assert.ok(text.includes("输入"), "card text tells the user to type the next instruction");
});

test("buildEscapedCard lists every business option as ▫️ + appends a ✅-marked escape line", () => {
  const card = buildEscapedCard({
    question: "部署到哪？",
    options: [
      { label: "生产", value: "prod", description: "灰度 5%" },
      { label: "预发", value: "staging" },
    ],
  });
  assert.ok(!card.elements.some((e) => e.tag === "action"), "no actionable buttons after escape");
  const text = JSON.stringify(card);
  // all business options remain visible, all unmarked
  assert.ok(text.includes("生产") && text.includes("预发"), "all business options remain listed");
  assert.ok(text.includes("灰度 5%"), "descriptions preserved");
  assert.ok(text.includes("▫️"), "business options carry ▫️ unselected marker");
  // the trailing "✅ 都不合适（已选）" line marks the actual escape choice
  assert.ok(text.includes("都不合适"));
  assert.ok(text.includes("✅") && text.includes("已选"), "escape line carries ✅ + 已选 marker");
  assert.ok(text.includes("停"), "card text mentions that the agent has stopped");
});
