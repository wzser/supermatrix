export function createFakeLifecycle() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record = (method: string) => async (args: unknown) => {
    calls.push({ method, args });
    if (method === "create") {
      return { session: { name: (args as { name: string }).name, id: "sess_" + (args as { name: string }).name } };
    }
  };
  return {
    calls,
    create: record("create"),
    delete: record("delete"),
    reset: record("reset"),
    restart: record("restart"),
  };
}
