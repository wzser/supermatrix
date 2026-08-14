import pino from "pino";
import type { Logger } from "../../ports/Logger.ts";

type PinoInstance = {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
  child: (fields: object) => PinoInstance;
};

export function createPinoLogger(
  level: "debug" | "info" | "warn" | "error",
  sink?: (line: string) => void
): Logger {
  const stream = sink
    ? { write: (line: string) => sink(line.trimEnd()) }
    : undefined;
  const instance: PinoInstance = stream ? pino({ level }, stream) : pino({ level });
  return wrap(instance);
}

function wrap(instance: PinoInstance): Logger {
  return {
    debug(msg, fields) {
      instance.debug(fields ?? {}, msg);
    },
    info(msg, fields) {
      instance.info(fields ?? {}, msg);
    },
    warn(msg, fields) {
      instance.warn(fields ?? {}, msg);
    },
    error(msg, fields) {
      instance.error(fields ?? {}, msg);
    },
    child(fields) {
      return wrap(instance.child(fields));
    },
  };
}
