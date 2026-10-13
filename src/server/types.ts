/**
 * Fastify 类型扩展。
 *
 * `deadlineTs` 是「整个 HTTP 请求的绝对截止时间（毫秒）」——
 * 由超时中间件写入，路由层与 Provider 层用它把自己的等待预算**收敛**到剩余时间内。
 *
 * 为什么必须传下去：首轮 + 两轮策略的 reparse 是**两个完整往返**，
 * 各自按 240s 跑必然超过中间件的 300s，客户端只会拿到 504
 * （2026-09-27 19:16 的真实事故）。
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** 整个请求的绝对截止时间（epoch 毫秒）。未设置时表示不限。 */
    deadlineTs?: number;
    /** 本次请求的追踪 ID（贯穿日志与 SSE 注释行）。 */
    requestId?: string;
  }
}

export {};
