export function errorMessage(err: unknown, fallback = "unknown error"): string {
  if (err instanceof Error) return err.message;
  const message = String(err);
  return message.length > 0 ? message : fallback;
}
