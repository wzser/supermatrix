"use strict";

class PendingStore {
  constructor({ timeoutMs = 300000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Map(); // token -> { resolve, timerId }
  }

  register(token, defaultValue) {
    return new Promise((resolve) => {
      const timerId = this.setTimer(() => {
        if (this.pending.delete(token)) {
          resolve({ status: "timedout", value: defaultValue });
        }
      }, this.timeoutMs);
      this.pending.set(token, { resolve, timerId });
    });
  }

  deliver(token, value) {
    const entry = this.pending.get(token);
    if (!entry) return false;
    this.pending.delete(token);
    this.clearTimer(entry.timerId);
    entry.resolve({ status: "answered", value });
    return true;
  }

  has(token) { return this.pending.has(token); }
  size() { return this.pending.size; }
}

module.exports = { PendingStore };
