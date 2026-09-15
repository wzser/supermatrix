const test = require("node:test");
const assert = require("node:assert");
const { PendingStore } = require("../src/pendingStore");

function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire: (id) => { const fn = timers.get(id); timers.delete(id); fn(); },
  };
}

test("deliver resolves with answered status and removes token", async () => {
  const ft = fakeTimers();
  const store = new PendingStore({ timeoutMs: 1000, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  const p = store.register("tok", "DEFAULT");
  assert.strictEqual(store.size(), 1);
  assert.strictEqual(store.deliver("tok", "prod"), true);
  assert.deepStrictEqual(await p, { status: "answered", value: "prod" });
  assert.strictEqual(store.size(), 0);
});

test("timeout resolves with timedout status and the default value", async () => {
  const ft = fakeTimers();
  const store = new PendingStore({ timeoutMs: 1000, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  const p = store.register("tok", "DEFAULT");
  ft.fire(1); // fire the registered timer
  assert.deepStrictEqual(await p, { status: "timedout", value: "DEFAULT" });
  assert.strictEqual(store.size(), 0);
});

test("deliver on unknown token returns false", () => {
  const ft = fakeTimers();
  const store = new PendingStore({ timeoutMs: 1000, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  assert.strictEqual(store.deliver("nope", "x"), false);
});

test("deliver after timeout is a no-op (returns false)", async () => {
  const ft = fakeTimers();
  const store = new PendingStore({ timeoutMs: 1000, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  const p = store.register("tok", "DEFAULT");
  ft.fire(1);
  await p;
  assert.strictEqual(store.deliver("tok", "late"), false);
});
