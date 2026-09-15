((owner, isFromMainAgent) => {
  // Native V2 engine layout (kimi-code 0.33.0+): the AcpSession owns a klient
  // agent facade (`owner.agent.events`) and drops events whose turn has no
  // in-flight prompt driver. Install a fake driver when the engine starts an
  // agent-initiated turn with no prompt active so the bundle's own handlers
  // stream its content as session/update — same visibility contract as the V1
  // forwarder below. `_sm_turn` is skipped here: the V2 client wrapper has no
  // extNotification surface.
  if (owner.agent != null && typeof owner.agent.events?.on === "function") {
    if (owner.__smV2Forwarding) return;
    owner.__smV2Forwarding = true;
    owner.agent.events.on("turn.started", (event) => {
      if (owner.driver !== void 0 && !owner.driver.settled) return;
      owner.driver = { settled: false, turnId: event.turnId, early: [], resolve() {}, reject() {} };
    });
    return;
  }

  // Legacy V1 layout (<=0.30.0): the forwarder is installed at most once per
  // SDK Session; prompt turns are suppressed via the shared Session flag so
  // content events keep flowing only through runTurnBody's own subscription.
  const session = owner.session;
  if (session.__smTurnForwarding) return;

  const conn = owner.conn;
  const RUN_TURN_BODY_WRAPPED = "__smAcpRunTurnBodyWrapped";
  const prototype = Object.getPrototypeOf(owner);
  if (!prototype[RUN_TURN_BODY_WRAPPED]) {
    const originalRunTurnBody = prototype.runTurnBody;
    if (typeof originalRunTurnBody !== "function") {
      throw new TypeError("AcpSession.runTurnBody is unavailable");
    }
    Object.defineProperty(prototype, RUN_TURN_BODY_WRAPPED, { value: true });
    prototype.runTurnBody = function smRunTurnBody(...args) {
      const autonomous = args[3] === true;
      if (!autonomous) this.session.__smAcpPromptTurnActive = true;
      return originalRunTurnBody.apply(this, args).finally(() => {
        if (!autonomous) this.session.__smAcpPromptTurnActive = false;
      });
    };
  }

  session.__smTurnForwarding = true;
  session.onEvent((event) => {
    if (!isFromMainAgent(event)) return;
    const phase = event.type === "turn.started" ? "started" : event.type === "turn.ended" ? "ended" : null;
    if (phase === null) return;
    if (typeof conn.extNotification === "function") {
      conn.extNotification("_sm_turn", {
        sessionId: owner.id,
        turnId: event.turnId,
        phase,
        reason: event.reason,
        origin: session.__smAcpPromptTurnActive ? "prompt" : "notification",
      }).catch(() => {});
    }
    if (phase === "started" && !session.__smAcpPromptTurnActive) {
      owner.runTurnBody(owner.id, conn, () => Promise.resolve(), true).catch(() => {});
    }
  });
})
