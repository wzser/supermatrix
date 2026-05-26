import { describe, it, expect } from "vitest";
import { executeHttp } from "../../src/executors/http.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer, type AddressInfo } from "node:http";

describe("executeHttp", () => {
  it("sends request and captures response", async () => {
    const app = new Hono();
    app.post("/test", (c) => c.json({ ok: true }));
    const server = serve({ fetch: app.fetch, port: 0 }) as ReturnType<typeof serve> & { address(): { port: number } };
    const port = (server.address() as { port: number }).port;

    try {
      const result = await executeHttp({
        url: `http://localhost:${port}/test`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { data: "test" },
        timeout: 5000,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("ok");
    } finally {
      server.close();
    }
  });

  it("reports failure on non-2xx response", async () => {
    const app = new Hono();
    app.post("/fail", (c) => c.json({ error: "not found" }, 404));
    const server = serve({ fetch: app.fetch, port: 0 }) as ReturnType<typeof serve> & { address(): { port: number } };
    const port = (server.address() as { port: number }).port;

    try {
      const result = await executeHttp({
        url: `http://localhost:${port}/fail`,
        method: "POST",
        timeout: 5000,
      });
      expect(result.success).toBe(false);
    } finally {
      server.close();
    }
  });

  it("aborts when body read exceeds timeout", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      setTimeout(() => res.end("late body"), 5000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await executeHttp({
        url: `http://127.0.0.1:${port}/`,
        method: "GET",
        timeout: 200,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout/i);
    } finally {
      server.close();
    }
  });

  it("reports connection errors without hanging", async () => {
    const result = await executeHttp({
      url: "http://127.0.0.1:1/unreachable",
      method: "GET",
      timeout: 10_000,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
