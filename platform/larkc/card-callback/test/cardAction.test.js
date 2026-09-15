const test = require("node:test");
const assert = require("node:assert");
const { extractClick } = require("../src/cardAction");

// Shape per node-sdk's InteractiveCardActionEvent (types/index.d.ts): the
// CardActionHandler callback receives the event flattened to the top level, so
// our button payload lives at data.action.value (NOT data.event.action.value).
test("extractClick pulls our {token,value} from a real card-action event", () => {
  const data = {
    open_id: "ou_x",
    tenant_key: "t",
    open_message_id: "om_1",
    token: "card-interaction-token", // the card's own token, not ours
    action: { tag: "button", value: { __ask_user: true, token: "tok-abc", value: "prod" } },
  };
  assert.deepStrictEqual(extractClick(data), { token: "tok-abc", value: "prod" });
});

test("extractClick returns null for foreign / malformed payloads", () => {
  assert.strictEqual(extractClick(undefined), null);
  assert.strictEqual(extractClick({}), null);
  assert.strictEqual(extractClick({ action: {} }), null);
  assert.strictEqual(extractClick({ action: { value: {} } }), null); // no token
  // token present but no __ask_user marker → a normal CARD_ACTION, not ours.
  assert.strictEqual(extractClick({ action: { value: { token: "tok-abc", value: "prod" } } }), null);
});
