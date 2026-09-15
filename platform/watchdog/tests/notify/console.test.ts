import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createNotifyClient } from "../../src/notify/console.js";

describe("Console notify client", () => {
  it("posts to the configured instance port instead of a fixed endpoint", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ messageId: "local-message" }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind a port");
      const client = createNotifyClient({
        apiBase: `http://127.0.0.1:${address.port}`,
        timeoutMs: 1000,
      });

      await expect(client.notify({
        source: "isolated-watchdog",
        title: "local test",
        body: "no remote write",
      })).resolves.toEqual({ messageId: "local-message" });

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/api/notify");
      expect(JSON.parse(requests[0].body)).toMatchObject({ source: "isolated-watchdog" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
