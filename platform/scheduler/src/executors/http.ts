import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ExecutorResult, HttpConfig } from "./types.js";

export function executeHttp(config: HttpConfig): Promise<ExecutorResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch (err) {
      resolve({ success: false, output: "", error: `invalid url: ${config.url}` });
      return;
    }

    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const bodyStr = config.body !== undefined ? JSON.stringify(config.body) : undefined;
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (bodyStr !== undefined && headers["Content-Length"] === undefined && headers["content-length"] === undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: config.method,
        headers,
        timeout: config.timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve({ success: true, output: text, error: null });
          } else {
            resolve({ success: false, output: text, error: `HTTP ${status}: ${text}` });
          }
        });
        res.on("error", (err) => {
          resolve({ success: false, output: "", error: err.message });
        });
      },
    );

    req.on("error", (err) => {
      resolve({ success: false, output: "", error: err.message });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`request timeout after ${config.timeout}ms`));
    });

    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}
