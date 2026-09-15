import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeHelper = path.resolve(
  import.meta.dirname,
  "../../scripts/kimi-sea-runtime.cjs",
);

describe("Kimi SEA compact runtime helper", () => {
  it("installs one listener and reuses runTurnBody for an autonomous main-agent turn", () => {
    const program = String.raw`
const install = Function("return " + require("fs").readFileSync(process.argv[1]))();
const updates = [];
const session = {
  listeners: [],
  onEvent(listener) { this.listeners.push(listener); },
};
const conn = {
  extNotification(method, payload) {
    updates.push({ method, payload });
    return Promise.resolve();
  },
};
class AcpSession {
  constructor(id) {
    this.id = id;
    this.session = session;
    this.conn = conn;
    this.calls = [];
  }
  runTurnBody(...args) {
    this.calls.push(args);
    return args[2]();
  }
}
(async () => {
  const first = new AcpSession("first");
  const second = new AcpSession("second");
  install(first, (event) => event.agentId === "main");
  install(second, (event) => event.agentId === "main");
  await second.runTurnBody("second", conn, () => Promise.resolve());
  session.listeners[0]({ type: "turn.started", agentId: "main", turnId: "turn-1", reason: "notification" });
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({
    listeners: session.listeners.length,
    promptActive: Boolean(session.__smAcpPromptTurnActive),
    autonomousArgs: first.calls[0],
    updates,
  }));
})();
`;
    const result = spawnSync("node", ["-e", program, runtimeHelper], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      listeners: number;
      promptActive: boolean;
      autonomousArgs: [string, unknown, unknown, boolean];
      updates: Array<{ method: string; payload: { origin: string; turnId: string } }>;
    };
    expect(output.listeners).toBe(1);
    expect(output.promptActive).toBe(false);
    expect(output.autonomousArgs[0]).toBe("first");
    expect(output.autonomousArgs[3]).toBe(true);
    expect(output.updates).toEqual([
      expect.objectContaining({
        method: "_sm_turn",
        payload: expect.objectContaining({ origin: "notification", turnId: "turn-1" }),
      }),
    ]);
  });
});
