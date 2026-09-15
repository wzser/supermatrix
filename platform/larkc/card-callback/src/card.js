"use strict";

const ESCAPE_VALUE = "__none_fits__";
const ESCAPE_LABEL = "都不合适（停下等我输入）";

function header(title, template = "blue") {
  return { title: { tag: "plain_text", content: title }, template };
}

function optionDescriptionsBlock(options) {
  if (!options.some((o) => o && o.description)) return null;
  const lines = options.map((o) => (o.description ? `- **${o.label}** — ${o.description}` : `- **${o.label}**`));
  return { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } };
}

// Render the option list for a settled (no-longer-interactive) card. Keeps
// every business option visible so the reader sees the full context of what
// was on offer, and marks which one (if any) was picked. Selected option:
// "✅ **label** — description（已选）"; others: "▫️ label — description"
function settledOptionsBlock(options, selectedValue, extraLines = []) {
  const lines = options.map((o) => {
    const isSelected = o.value === selectedValue;
    const desc = o.description ? ` — ${o.description}` : "";
    if (isSelected) {
      return `✅ **${o.label}**${desc}（已选）`;
    }
    return `▫️ ${o.label}${desc}`;
  });
  return { tag: "div", text: { tag: "lark_md", content: [...lines, ...extraLines].join("\n") } };
}

function contextNote(context) {
  if (!context) return null;
  return { tag: "note", elements: [{ tag: "plain_text", content: String(context) }] };
}

function buildAskCard({ question, options, token, context }) {
  const elements = [];
  const note = contextNote(context);
  if (note) elements.push(note);
  elements.push({ tag: "div", text: { tag: "lark_md", content: question } });
  const descBlock = optionDescriptionsBlock(options);
  if (descBlock) elements.push(descBlock);
  elements.push({
    tag: "action",
    actions: [
      ...options.map((opt) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: "primary",
        value: { __ask_user: true, token, value: opt.value },
      })),
      {
        tag: "button",
        text: { tag: "plain_text", content: ESCAPE_LABEL },
        type: "danger",
        value: { __ask_user: true, token, value: ESCAPE_VALUE },
      },
    ],
  });
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: header("需要你确认"),
    elements,
  };
}

function buildAnsweredCard({ question, context, options, selectedValue }) {
  const elements = [];
  const note = contextNote(context);
  if (note) elements.push(note);
  elements.push({ tag: "div", text: { tag: "lark_md", content: question } });
  elements.push(settledOptionsBlock(options || [], selectedValue));
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: header("已确认"),
    elements,
  };
}

function buildTimedOutEscapedCard({ question, context, options }) {
  const elements = [];
  const note = contextNote(context);
  if (note) elements.push(note);
  elements.push({ tag: "div", text: { tag: "lark_md", content: question } });
  // No business option was selected; show them all with ▫️ and append a
  // trailing line explaining the timeout outcome so the picture is complete.
  elements.push(settledOptionsBlock(options || [], null, [
    "",
    "⏱ **5 分钟未点击** — 按设计判定为「选项均不合适」，agent 已停手；请直接输入下一步指令。",
  ]));
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: header("超时已停下，等你输入", "orange"),
    elements,
  };
}

function buildEscapedCard({ question, context, options }) {
  const elements = [];
  const note = contextNote(context);
  if (note) elements.push(note);
  elements.push({ tag: "div", text: { tag: "lark_md", content: question } });
  // All business options were declined; show them as ▫️ and add an extra
  // "✅ 都不合适（已选）" line at the bottom to make the escape choice explicit.
  elements.push(settledOptionsBlock(options || [], null, [
    "",
    `✅ ⛔ **${ESCAPE_LABEL}**（已选）— agent 已停手；请直接输入下一步指令。`,
  ]));
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: header("已停下，等你输入", "orange"),
    elements,
  };
}

module.exports = { buildAskCard, buildAnsweredCard, buildEscapedCard, buildTimedOutEscapedCard, ESCAPE_VALUE, ESCAPE_LABEL };
