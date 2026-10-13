/**
 * 请求超时中间件 —— `legacy-python/src/middleware/timeout.py` 的移植。
 *
 * 防止长请求无限挂起；超时后返回 OpenAI 格式的 504。
 *
 * ## 与原实现的对应关系
 * Python 用 ASGI 层 `asyncio.wait_for(app(...), timeout)` 包住整个应用。
 * Fastify 没有等价物，改用 `onRequest` 钩子 + `setTimeout` 兜底：
 * 到点后若响应还没开始写，就直接往 `reply.raw`（Node 的 `ServerResponse`）写 504。
 *
 * ## ⚠️ 这里踩过的两个坑，一个都不能回退
 * 1. **不能用框架的 JSON 序列化器塞 bytes**：旧实现调用
 *    `JSONResponse.render(b"")` → `TypeError: Object of type bytes is not JSON serializable`
 *    → 超时反而返回 500「内部服务器错误」。现在直接 `JSON.stringify` 出字符串再写。
 * 2. **响应必须真的发出去**：旧实现漏了 `await send(...)`，504 根本没到客户端，
 *    客户端只能一直等到自己超时。这里 `raw.writeHead(...)` + `raw.end(body)` 是同步的，
 *    但**仍然包了 try/catch**：客户端提前断开时写入会抛 EPIPE，不能让它冒泡成未捕获异常。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { logger } from '../../log/logger.js';

/** 超时中间件选项。 */
export interface TimeoutOptions {
  /** 超时秒数（<=0 表示禁用）。 */
  timeoutSeconds: number;
  /** 豁免路径（健康检查等）。 */
  skipPaths?: ReadonlySet<string>;
}

const DEFAULT_SKIP = new Set(['/health', '/status', '/v1/health', '/v1/status', '/']);

const TIMEOUT_BODY = JSON.stringify({
  error: {
    message: '请求超时：服务器未能在规定时间内完成响应',
    type: 'server_error',
    code: 'request_timeout',
  },
});

/**
 * 构造 Fastify `onRequest` 钩子。
 *
 * 副作用：即使超时被禁用（或路径被豁免），**不设置 `deadlineTs`** 也不影响路由 ——
 * 路由会退化成「按自己的默认预算跑」。
 */
export function makeTimeoutHook(
  options: TimeoutOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const skip = options.skipPaths ?? DEFAULT_SKIP;
  const { timeoutSeconds } = options;

  if (timeoutSeconds > 0) {
    logger.info(`请求超时中间件: timeout=${timeoutSeconds}s`);
  }

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = request.url.split('?')[0] ?? '';
    if (skip.has(path)) return;
    if (timeoutSeconds <= 0) return;

    // 把绝对截止时间交给下游（路由 / Provider 用它收敛自己的等待预算）
    request.deadlineTs = Date.now() + timeoutSeconds * 1000;

    const raw = reply.raw;
    const timer = setTimeout(() => {
      if (raw.writableEnded) return;

      // 已经开始写响应（SSE 已经吐出过 chunk）→ 无法再改状态码，
      // 直接收尾，避免「headers already sent」二次响应报错。
      if (raw.headersSent) {
        logger.warn(
          `请求超时: ${request.method} ${path} (超时 ${timeoutSeconds}s)，响应已开始，直接收尾`,
        );
        try {
          raw.end();
        } catch {
          // 客户端可能已断开
        }
        return;
      }

      logger.warn(`请求超时: ${request.method} ${path} (超时 ${timeoutSeconds}s)`);
      try {
        raw.writeHead(504, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(TIMEOUT_BODY),
        });
        raw.end(TIMEOUT_BODY);
      } catch (error) {
        logger.warn(`发送超时响应失败（客户端可能已断开）: ${String(error)}`);
      }
    }, timeoutSeconds * 1000);

    // 响应结束或连接关闭都要清掉定时器，否则会留下「跑到已结束的连接上」的悬空定时器
    const cleanup = (): void => clearTimeout(timer);
    raw.once('close', cleanup);
    raw.once('finish', cleanup);
  };
}
