import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import type { MutationActorClass } from "../db/taskStore.js";

const LOCK_HINT =
  "写入已锁定(有意为之,非故障):所有任务的 新建/修改/删除/手动触发" +
  "(POST、PATCH、DELETE /tasks 及 POST /tasks/:id/run)现仅 scheduler 可操作;只读 GET 不受影响。" +
  "oneshot 单次任务仅新建可自助(限 loopback session);修改/删除/手动触发仍需 scheduler。" +
  "需要 scheduler 代办,请通过 spawn2.0(POST http://localhost:3501/api/spawn2.0)发 target:\"scheduler\"," +
  "在 prompt 里说明诉求。";

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = host?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  return normalized === "localhost" || normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."));
}

export function mutationActorClass(
  adminToken: string | undefined,
  providedToken: string | undefined,
): MutationActorClass {
  if (!adminToken) return "write_lock_unconfigured";
  return tokenMatches(providedToken, adminToken)
    ? "scheduler_admin"
    : "loopback_session_oneshot";
}

export function createWriteLock(deps: {
  adminToken?: string;
  host: string;
}): MiddlewareHandler {
  const { adminToken, host } = deps;
  return async (c, next) => {
    // 未配置 token → no-op(放行)。运行态由入口 assertAdminToken 强制必配,
    // 服务永远锁着;此处放行只为单测可不带 token 直接构造 app。勿改成硬 403。
    if (!adminToken) return next();
    if (tokenMatches(c.req.header("X-Scheduler-Auth"), adminToken)) return next();

    if (c.req.method === "POST" && c.req.path === "/tasks") {
      const body = (await c.req.json().catch(() => undefined)) as
        | { oneshot?: unknown }
        | undefined;
      const taskType = typeof (body as { type?: unknown } | undefined)?.type === "string"
        ? (body as { type: string }).type
        : "";
      if (body?.oneshot === true && taskType === "session" && isLoopbackHost(host)) return next();
    }
    return c.json({ ok: false, error: "locked", hint: LOCK_HINT }, 403);
  };
}
