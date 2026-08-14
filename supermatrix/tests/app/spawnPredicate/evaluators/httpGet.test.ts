import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { evaluateHttpGetPredicate } from "../../../../src/app/spawnPredicate/evaluators/httpGet.ts";
import { validateSpawnPredicate } from "../../../../src/app/spawnPredicate/schema.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("http-get predicate evaluator", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ready") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("service ready\n");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing\n");
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await close(server);
  });

  test("matches expected status and body text", async () => {
    const predicate = validateSpawnPredicate({
      type: "http-get",
      url: `${baseUrl}/ready`,
      expected_status: 200,
      body_contains_all: ["service ready"],
    }).predicate;
    if (predicate.type !== "http-get") throw new Error("expected http-get predicate");

    await expect(evaluateHttpGetPredicate(predicate)).resolves.toMatchObject({
      matched: true,
    });
  });

  test("rejects unexpected status", async () => {
    const predicate = validateSpawnPredicate({
      type: "http-get",
      url: `${baseUrl}/ready`,
      expected_status: 204,
      body_contains_all: ["service ready"],
    }).predicate;
    if (predicate.type !== "http-get") throw new Error("expected http-get predicate");

    await expect(evaluateHttpGetPredicate(predicate)).resolves.toMatchObject({
      matched: false,
    });
  });
});
