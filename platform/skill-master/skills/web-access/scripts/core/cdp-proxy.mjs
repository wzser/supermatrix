#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控受管 Chrome 配置
// 要求：已启动受管 Chrome profile
// Node.js 22+（使用原生 WebSocket）

import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

import { buildBrowserWsUrl, resolveBrowserWsUrl } from "./chrome-endpoint.mjs";
import { getActiveManagedBrowser } from "./browser-profile.mjs";

function parseProxyPort(envValue) {
  if (envValue === undefined || envValue === null || envValue === "") return 3456;
  const port = Number(envValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CDP_PROXY_PORT: ${envValue} (expected integer 1-65535)`);
  }
  return port;
}

let PORT = 3456;
try {
  PORT = parseProxyPort(process.env.CDP_PROXY_PORT);
} catch (error) {
  console.error(`[CDP Proxy] ${error.message}`);
  process.exit(1);
}
let ws = null;
let cmdId = 0;
const pending = new Map();
const sessions = new Map();

const WS = globalThis.WebSocket;
const TOKEN_ENV = "CDP_PROXY_TOKEN";
const TOKEN_HEADER = "x-cdp-proxy-token";
const TOKEN_FILE = path.join(os.tmpdir(), "web-access-cdp-proxy.token");
let proxyToken = null;

function readTokenFile() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

function writeTokenFile(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    console.error("[CDP Proxy] 写入 token 失败:", error?.message || error);
  }
}

function initProxyToken() {
  const envToken = String(process.env[TOKEN_ENV] || "").trim();
  if (envToken) {
    proxyToken = envToken;
    return;
  }
  const fileToken = readTokenFile();
  if (fileToken) {
    proxyToken = fileToken;
    return;
  }
  proxyToken = crypto.randomUUID();
}

function isAuthorized(reqToken) {
  const candidate = String(reqToken || "").trim();
  return proxyToken && candidate === proxyToken;
}

function ensureNode22() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) {
    console.error("[CDP Proxy] 错误：需要 Node.js 22+");
    console.error(`  当前版本：v${process.versions.node}`);
    process.exit(1);
  }
  if (!WS) {
    console.error("[CDP Proxy] 错误：当前 Node.js 未提供 WebSocket API");
    process.exit(1);
  }
}

async function discoverManagedChrome() {
  const active = await getActiveManagedBrowser();
  if (!active) {
    throw new Error(
      "No active managed profile. Run `node scripts/core/check-deps.mjs --profile <name>` first."
    );
  }

  return {
    port: active.remoteDebuggingPort,
    wsPath: active.wsPath || null,
    browserWsUrl: active.browserWsUrl || buildBrowserWsUrl({
      port: active.remoteDebuggingPort,
      wsPath: active.wsPath || null
    })
  };
}

let chromePort = null;
let chromeWsPath = null;
let connectingPromise = null;

async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;

  if (!chromePort) {
    const discovered = await discoverManagedChrome();
    chromePort = discovered.port;
    chromeWsPath = discovered.wsPath;
  }

  const wsUrl = await resolveBrowserWsUrl({
    port: chromePort,
    wsPath: chromeWsPath
  });
  if (!wsUrl) throw new Error("无法获取 Chrome WebSocket URL");

  try {
    const parsedWsUrl = new URL(wsUrl);
    chromeWsPath = parsedWsUrl.pathname || chromeWsPath;
  } catch {
    chromeWsPath = chromeWsPath || null;
  }

  return (connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      console.log(`[CDP Proxy] 已连接 Chrome (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      const msg = e.message || e.error?.message || "连接失败";
      console.error("[CDP Proxy] 连接错误:", msg, "（端口缓存已清除，下次将重新发现）");
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log("[CDP Proxy] 连接断开");
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error("WebSocket 已关闭"));
      }
      pending.clear();
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      sessions.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === "string" ? evt : evt.data || evt;
      const msg = JSON.parse(typeof data === "string" ? data : data.toString());

      if (msg.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      if (msg.method === "Fetch.requestPaused") {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }, sid).catch(() => {});
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.("open", onOpen);
      ws.removeEventListener?.("error", onError);
    }

    if (ws.on) {
      ws.on("open", onOpen);
      ws.on("error", onError);
      ws.on("close", onClose);
      ws.on("message", onMessage);
    } else {
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      ws.addEventListener("message", onMessage);
    }
  }));
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error("WebSocket 未连接"));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP 命令超时: " + method));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(msg));
  });
}

const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP("Target.attachToTarget", { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error("attach 失败: " + JSON.stringify(resp.error));
}

async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP(
      "Fetch.enable",
      {
        patterns: [
          { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: "Request" },
          { urlPattern: `http://localhost:${chromePort}/*`, requestStage: "Request" }
        ]
      },
      sessionId
    );
    portGuardedSessions.add(sessionId);
  } catch {
    // Fetch 域启用失败不影响主流程
  }
}

async function waitForLoad(sessionId, timeoutMs = 15000) {
  await sendCDP("Page.enable", {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done("timeout"), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP(
          "Runtime.evaluate",
          {
            expression: "document.readyState",
            returnByValue: true
          },
          sessionId
        );
        if (resp.result?.result?.value === "complete") {
          done("complete");
        }
      } catch {
        // 忽略
      }
    }, 500);
  });
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

function isAllowedHost(hostHeader, port) {
  const normalized = String(hostHeader || "").trim().toLowerCase();
  return normalized === `localhost:${port}` || normalized === `127.0.0.1:${port}`;
}

const ENDPOINTS = {
  "/health": "GET - 健康检查",
  "/targets": "GET - 列出所有页面 tab",
  "/new?url=": "GET - 创建新后台 tab（自动等待加载）",
  "/close?target=": "GET - 关闭 tab",
  "/navigate?target=&url=": "GET - 导航（自动等待加载）",
  "/back?target=": "GET - 后退",
  "/info?target=": "GET - 页面标题/URL/状态",
  "/eval?target=": "POST body=JS表达式 - 执行 JS",
  "/click?target=": "POST body=CSS选择器 - 点击元素",
  "/clickAt?target=": "POST body=CSS选择器 - 点击元素中心点",
  "/setFiles?target=": "POST body={selector,files[]} - 设置文件输入",
  "/scroll?target=&y=&direction=": "GET - 滚动页面",
  "/screenshot?target=&file=": "GET - 截图"
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (!isAllowedHost(req.headers.host, PORT)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Invalid Host header" }));
      return;
    }
    if (!isAuthorized(req.headers[TOKEN_HEADER])) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Missing or invalid proxy token" }));
      return;
    }

    if (pathname === "/health") {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({ status: "ok", connected, sessions: sessions.size, chromePort }));
      return;
    }

    let setFilesBody = null;
    if (pathname === "/setFiles") {
      const rawBody = await readBody(req);
      try {
        setFilesBody = JSON.parse(rawBody);
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "JSON 解析失败" }));
        return;
      }
    }

    if (pathname === "/targets") {
      await connect();
      const resp = await sendCDP("Target.getTargets");
      const pages = resp.result.targetInfos.filter((t) => t.type === "page");
      res.end(JSON.stringify(pages, null, 2));
    } else if (pathname === "/new") {
      await connect();
      const targetUrl = q.url || "about:blank";
      const resp = await sendCDP("Target.createTarget", { url: targetUrl, background: true });
      const targetId = resp.result.targetId;

      if (targetUrl !== "about:blank") {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch {
          // 非致命，继续
        }
      }

      res.end(JSON.stringify({ targetId }));
    } else if (pathname === "/close") {
      await connect();
      const resp = await sendCDP("Target.closeTarget", { targetId: q.target });
      sessions.delete(q.target);
      res.end(JSON.stringify(resp.result));
    } else if (pathname === "/navigate") {
      await connect();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP("Page.navigate", { url: q.url }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify(resp.result));
    } else if (pathname === "/back") {
      await connect();
      const sid = await ensureSession(q.target);
      await sendCDP("Runtime.evaluate", { expression: "history.back()" }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    } else if (pathname === "/eval") {
      await connect();
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || "document.title";
      const resp = await sendCDP(
        "Runtime.evaluate",
        {
          expression: expr,
          returnByValue: true,
          awaitPromise: true
        },
        sid
      );
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    } else if (pathname === "/click") {
      await connect();
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "POST body 需要 CSS 选择器" }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP(
        "Runtime.evaluate",
        {
          expression: js,
          returnByValue: true,
          awaitPromise: true
        },
        sid
      );
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    } else if (pathname === "/clickAt") {
      await connect();
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "POST body 需要 CSS 选择器" }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP(
        "Runtime.evaluate",
        {
          expression: js,
          returnByValue: true,
          awaitPromise: true
        },
        sid
      );
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: coord.x,
          y: coord.y,
          button: "left",
          clickCount: 1
        },
        sid
      );
      await sendCDP(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: coord.x,
          y: coord.y,
          button: "left",
          clickCount: 1
        },
        sid
      );
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    } else if (pathname === "/setFiles") {
      await connect();
      const sid = await ensureSession(q.target);
      const body = setFilesBody;
      if (!body || !body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "需要 selector 和 files 字段" }));
        return;
      }
      await sendCDP("DOM.enable", {}, sid);
      const doc = await sendCDP("DOM.getDocument", {}, sid);
      const node = await sendCDP(
        "DOM.querySelector",
        {
          nodeId: doc.result.root.nodeId,
          selector: body.selector
        },
        sid
      );
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "未找到元素: " + body.selector }));
        return;
      }
      await sendCDP(
        "DOM.setFileInputFiles",
        {
          nodeId: node.result.nodeId,
          files: body.files
        },
        sid
      );
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    } else if (pathname === "/scroll") {
      await connect();
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || "3000", 10);
      const direction = q.direction || "down";
      let js;
      if (direction === "top") {
        js = "window.scrollTo(0, 0); \"scrolled to top\"";
      } else if (direction === "bottom") {
        js = "window.scrollTo(0, document.body.scrollHeight); \"scrolled to bottom\"";
      } else if (direction === "up") {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP(
        "Runtime.evaluate",
        {
          expression: js,
          returnByValue: true
        },
        sid
      );
      await new Promise((r) => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    } else if (pathname === "/screenshot") {
      await connect();
      const sid = await ensureSession(q.target);
      const format = q.format || "png";
      const resp = await sendCDP(
        "Page.captureScreenshot",
        {
          format,
          quality: format === "jpeg" ? 80 : undefined
        },
        sid
      );
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, "base64"));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader("Content-Type", "image/" + format);
        res.end(Buffer.from(resp.result.data, "base64"));
      }
    } else if (pathname === "/info") {
      await connect();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP(
        "Runtime.evaluate",
        {
          expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
          returnByValue: true
        },
        sid
      );
      res.end(resp.result?.result?.value || "{}");
    } else {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: "未知端点",
          endpoints: ENDPOINTS
        })
      );
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => {
      s.close();
      resolve(true);
    });
    s.listen(port, "127.0.0.1");
  });
}

async function main() {
  ensureNode22();
  initProxyToken();
  const available = await checkPortAvailable(PORT);
  if (!available) {
    try {
      const probe = await new Promise((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${PORT}/health`,
          {
            timeout: 2000,
            headers: {
              [TOKEN_HEADER]: proxyToken
            }
          },
          (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve({ statusCode: res.statusCode, body: d }));
          }
        );
        req.on("error", () => resolve({ statusCode: 0, body: "" }));
        req.end();
      });
      if (probe.statusCode === 200 && probe.body.includes('"ok"')) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
      if (probe.statusCode === 401) {
        console.error(
          `[CDP Proxy] 端口 ${PORT} 已被认证中的 proxy 占用，但当前 token 不匹配或不可用`
        );
        console.error(`[CDP Proxy] 请检查 ${TOKEN_ENV} 或 token 文件: ${TOKEN_FILE}`);
        process.exit(1);
      }
    } catch {
      // 端口占用但非 proxy，继续报错
    }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  writeTokenFile(proxyToken);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    connect().catch((e) =>
      console.error("[CDP Proxy] 初始连接失败:", e.message, "（将在首次请求时重试）")
    );
  });
}

process.on("uncaughtException", (e) => {
  console.error("[CDP Proxy] 未捕获异常:", e.message);
});
process.on("unhandledRejection", (e) => {
  console.error("[CDP Proxy] 未处理拒绝:", e?.message || e);
});

await main();
