/**
 * 速率限制中间件 —— `legacy-python/src/middleware/rate_limit.py` 的移植。
 *
 * 令牌桶算法，按客户端标识（API Key 优先，否则 IP）分别限流。
 *
 * 配置：`RATE_LIMIT_PER_MINUTE=60` / `RATE_LIMIT_ENABLED=true`
 *
 * 与原实现的差异：
 * - `BaseHTTPMiddleware.dispatch` → Fastify `onRequest` 钩子的工厂函数。
 * - Python 用 `time.monotonic()`（不受系统时间调整影响）；TS 用
 *   `performance.now()` 达到同样效果（`Date.now()` 会被 NTP 调时影响）。
 * - `asyncio.Lock` → {@link Mutex}：JS 是单线程，`consume()` 本身不需要锁，
 *   但清理与取桶的「读改写」序列仍需要原子化，保留锁以免将来加入 await 时出错。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { logger } from '../../log/logger.js';
import { Mutex } from '../../utils/mutex.js';

/** 单调时钟（毫秒），等价于 Python `time.monotonic()`。 */
function monotonicMs(): number {
  return performance.now();
}

/** 令牌桶。 */
export class TokenBucket {
  private tokens: number;

  private lastTime: number;

  constructor(
    /** 令牌生成速率（每秒）。 */
    private readonly rate: number,
    /** 桶容量。 */
    private readonly capacity: number,
    now: () => number = monotonicMs,
  ) {
    this.tokens = capacity;
    this.lastTime = now();
  }

  /** 尝试消费 1 个令牌。 */
  consume(now: () => number = monotonicMs): boolean {
    const t = now();
    const elapsed = (t - this.lastTime) / 1000;
    this.lastTime = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 最后使用时间（清理过期桶用）。 */
  get lastUsed(): number {
    return this.lastTime;
  }
}

/** 速率限制选项。 */
export interface RateLimitOptions {
  requestsPerMinute: number;
  enabled: boolean;
  /**
   * 不参与限流的路径。默认与 Python 版一致：
   * `/health`、`/status`、`/v1/health`、`/v1/status`、`/`。
   */
  skipPaths?: ReadonlySet<string>;
}

const DEFAULT_SKIP = new Set(['/health', '/status', '/v1/health', '/v1/status', '/']);

/** 限流器（可在测试中直接实例化，不依赖 Fastify）。 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  private readonly lock = new Mutex();

  private lastCleanup = monotonicMs();

  /** 清理间隔（秒）。 */
  private readonly cleanupInterval = 600;

  /** 判定是否放行（纯逻辑，便于单测）。 */
  async allow(clientKey: string): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      this.cleanup();
      let bucket = this.buckets.get(clientKey);
      if (!bucket) {
        bucket = new TokenBucket(this.requestsPerMinute / 60, this.requestsPerMinute);
        this.buckets.set(clientKey, bucket);
      }
      return bucket.consume();
    } finally {
      release();
    }
  }

  /** 清理超过 5 分钟未使用的桶。 */
  private cleanup(): void {
    const now = monotonicMs();
    if (now - this.lastCleanup < this.cleanupInterval * 1000) return;
    this.lastCleanup = now;

    const cutoff = now - 300_000;
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastUsed < cutoff) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) logger.debug(`清理 ${removed} 个过期速率限制桶`);
  }

  constructor(private readonly requestsPerMinute: number) {}
}

/**
 * 取客户端标识：API Key 优先，否则回退到 IP。
 *
 * 与服务端反向代理的配合：Fastify 默认不信任 `X-Forwarded-For`，
 * 需要时在 `app.ts` 里设置 `trustProxy`，届时 `request.ip` 会自动取真实 IP。
 */
export function clientKeyOf(request: FastifyRequest): string {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return `key:${auth.slice(7)}`;
  }
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) {
    return `key:${xApiKey}`;
  }
  return `ip:${request.ip || 'unknown'}`;
}

/** 构造 Fastify `onRequest` 钩子。 */
export function makeRateLimitHook(
  options: RateLimitOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const skip = options.skipPaths ?? DEFAULT_SKIP;
  const limiter = new RateLimiter(options.requestsPerMinute);
  if (options.enabled) {
    logger.info(`速率限制: ${options.requestsPerMinute} req/min per client`);
  }

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!options.enabled) return;
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) return;
    if (skip.has(request.url.split('?')[0] ?? '')) return;

    const clientKey = clientKeyOf(request);
    if (!(await limiter.allow(clientKey))) {
      logger.info(`速率限制触发: ${clientKey} (${request.method} ${request.url})`);
      // ⚠️ 429 + Retry-After，格式与原实现一致（OpenAI 兼容）
      void reply
        .code(429)
        .header('retry-after', '60')
        .send({
          error: {
            message: '请求过于频繁，请稍后再试',
            type: 'too_many_requests',
            code: 'rate_limit_exceeded',
          },
        });
    }
  };
}
