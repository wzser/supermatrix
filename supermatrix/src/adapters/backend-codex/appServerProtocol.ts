// Transport-agnostic JSON-RPC 2.0 client state for one `codex app-server`
// stdio child (codex-cli 0.146.0). One protocol instance serves exactly one
// SuperMatrix run: a single thread may be established (thread/start XOR
// thread/resume, once) and all request/response correlation state lives here,
// so the process layer only moves newline-delimited lines. The legacy one-way
// `codex exec --json` helpers in process.ts keep their contract untouched —
// bidirectional correlation state cannot live there without changing it.

export type AppServerNotification = { method: string; params?: unknown };

export type JsonRpcErrorShape = { code: number; message: string; data?: unknown };

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, err: JsonRpcErrorShape) {
    super(`${method}: ${err.message}`);
    this.name = "AppServerRpcError";
    this.code = err.code;
    this.data = err.data;
  }
}

export type UserInputItem =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export type InitializeParams = { clientInfo: { name: string; version: string } };
export type ThreadStartParams = Record<string, unknown>;
export type ThreadResumeParams = { threadId: string } & Record<string, unknown>;
export type TurnStartParams = { threadId: string; input: UserInputItem[] } & Record<string, unknown>;
export type TurnSteerParams = { threadId: string; expectedTurnId: string; input: UserInputItem[] };
export type TurnInterruptParams = { threadId: string; turnId?: string };

export type AppServerProtocolOptions = {
  writeLine: (line: string) => void;
  onNotification?: (notification: AppServerNotification) => void;
};

export type AppServerProtocol = {
  /** Feed one stdout line from the app-server child. Non-JSON noise is ignored. */
  handleLine(line: string): void;
  /**
   * Reject every pending request and poison the transport: later requests
   * reject immediately with the same error. Idempotent — the first error wins.
   */
  failAllPending(error: Error): void;
  pendingCount(): number;
  initialize(params: InitializeParams): Promise<unknown>;
  /** The `initialized` notification (no response expected). */
  initialized(): void;
  threadStart(params?: ThreadStartParams): Promise<unknown>;
  threadResume(params: ThreadResumeParams): Promise<unknown>;
  turnStart(params: TurnStartParams): Promise<unknown>;
  turnSteer(params: TurnSteerParams): Promise<unknown>;
  turnInterrupt(params: TurnInterruptParams): Promise<unknown>;
};

type PendingRequest = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

function toRpcErrorShape(raw: unknown): JsonRpcErrorShape {
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    return {
      code: typeof obj.code === "number" ? obj.code : 0,
      message: typeof obj.message === "string" ? obj.message : JSON.stringify(raw),
      data: obj.data,
    };
  }
  return { code: 0, message: JSON.stringify(raw) };
}

export function createAppServerProtocol(opts: AppServerProtocolOptions): AppServerProtocol {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let failure: Error | undefined;
  let threadEstablished = false;

  const request = (method: string, params?: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const line = JSON.stringify(
      params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params },
    );
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      try {
        opts.writeLine(line);
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const notify = (method: string, params?: unknown): void => {
    if (failure) throw failure;
    opts.writeLine(
      JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }),
    );
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) {
        opts.onNotification?.(
          message.params === undefined ? { method } : { method, params: message.params },
        );
      } else {
        // Server-initiated request (e.g. an approval prompt). Out of scope for
        // this transport — production runs configure approvals off — but the
        // server must not be left waiting on a dangling request id.
        try {
          opts.writeLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `unsupported server request: ${method}` },
            }),
          );
        } catch {
          // stdin already gone; close handling will settle everything
        }
      }
      return;
    }
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return; // unknown or already-settled response id
    pending.delete(id);
    if ("error" in message && message.error !== undefined && message.error !== null) {
      entry.reject(new AppServerRpcError(entry.method, toRpcErrorShape(message.error)));
    } else {
      entry.resolve(message.result);
    }
  };

  const failAllPending = (error: Error): void => {
    failure ??= error;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      entry.reject(
        new Error(`${entry.method} failed before response: ${failure.message}`, { cause: failure }),
      );
    }
  };

  const establishThread = (method: "thread/start" | "thread/resume", params?: unknown): Promise<unknown> => {
    if (threadEstablished) {
      return Promise.reject(
        new Error(`one app-server transport serves one run: ${method} after a thread was already established`),
      );
    }
    threadEstablished = true;
    return request(method, params);
  };

  return {
    handleLine,
    failAllPending,
    pendingCount: () => pending.size,
    initialize: (params) => request("initialize", params),
    initialized: () => notify("initialized"),
    threadStart: (params) => establishThread("thread/start", params ?? {}),
    threadResume: (params) => establishThread("thread/resume", params),
    turnStart: (params) => request("turn/start", params),
    turnSteer: (params) => request("turn/steer", params),
    turnInterrupt: (params) => request("turn/interrupt", params),
  };
}
