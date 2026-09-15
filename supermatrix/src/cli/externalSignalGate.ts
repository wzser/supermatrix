export type ExternalShutdownSignal = "SIGINT" | "SIGTERM";

export type ExternalSignalGateDeps = {
  captureFirstSigterm(signal: ExternalShutdownSignal): void;
  onDenied(signal: ExternalShutdownSignal, signalCount: number): void;
};

/**
 * Deliberate SuperMatrix lifecycle changes enter through /reload after the
 * codexroot maintenance gate. Raw same-uid signals carry no caller identity,
 * so they are observation-only and fail closed. SIGKILL cannot be intercepted;
 * that remains an explicit OS-isolation boundary. Do not treat that limitation
 * as permission to use kill -9: submit the request through spawn2.0
 * target=codexroot so the maintenance gate can drain and audit it.
 */
export function createExternalSignalGate(deps: ExternalSignalGateDeps) {
  let signalCount = 0;
  let sigtermCaptured = false;

  return (signal: ExternalShutdownSignal): void => {
    signalCount += 1;
    if (signal === "SIGTERM" && !sigtermCaptured) {
      sigtermCaptured = true;
      deps.captureFirstSigterm(signal);
    }
    deps.onDenied(signal, signalCount);
  };
}
