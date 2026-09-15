export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UserError extends DomainError {}

export class SystemError extends DomainError {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}
