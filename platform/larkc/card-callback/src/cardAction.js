"use strict";

// Parse a Feishu card-action callback into the { token, value } we embedded in
// the button. The node-sdk CardActionHandler flattens the event to the top
// level (see InteractiveCardActionEvent in its types), so our payload is at
// data.action.value. The `__ask_user` marker is the discriminator: the WS entry
// inspects every card click app-wide, so a normal CARD_ACTION button must not be
// hijacked to the broker just because it happens to carry a `token` field — we
// require the marker, not token alone. Returns null when the payload isn't ours.
function extractClick(data) {
  const v = data && data.action && data.action.value;
  if (v && v.__ask_user === true && typeof v.token === "string") return { token: v.token, value: v.value };
  return null;
}

module.exports = { extractClick };
