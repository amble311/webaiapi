/**
 * API Key 认证 —— `legacy-python/src/middleware/auth.py` 的移植（OpenAI 兼容）。
 *
 * 认证方式（优先级与原实现一致）：
 * 1. `Authorization: Bearer {key}`
 * 2. `x-api-key: {key}`
 *
 * 配置：`API_KEYS=key1,key2` / `API_KEY_REQUIRED=true`（默认 false，兼容无认证模式）。
 *
 * 与原实现的差异：
 * - FastAPI 的 `Depends(security)` → 显式调用 {@link verifyApiKey}（由路由自行调用或
 *   交给 `onRequest` 钩子）。
 * - Python 的 `import hmac` 从未被使用（`key in self.keys` 是普通集合查找）。
 *   TS 侧同样用 Set，但**保留一个说明**：这不是恒定时间比较，若将来把 API Key
 *   当成真正的密钥用，应改为 `timingSafeEqual`。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { logger } from '../../log/logger.js';
import { AuthenticationError } from '../../utils/errors.js';

/** 从请求头里取 API Key（`Authorization: Bearer` 优先，其次 `x-api-key`）。 */
export function extractApiKey(request: FastifyRequest): string | null {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const key = auth.slice(7).trim();
    if (key) return key;
  }
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey;
  return null;
}

/** API Key 管理器。 */
export class ApiKeyManager {
  private keys = new Set<string>();

  /** 是否强制认证（未配置密钥时自动为 false）。 */
  required = false;

  /**
   * 校验密钥。
   *
   * ## 语义（三条，顺序有意义）
   * 1. **一个密钥都没配（`keys.size === 0`）且不强制 → 认证功能整体关闭，
   *    忽略请求里带的任何 Key**。
   *    ⚠️ 旧实现在这里会 401（理由是「传了错密钥说明客户端有意图，静默放行
   *    会掩盖配置错误」）。但 OpenAI 兼容客户端**几乎总会**带一个
   *    `Authorization` 头（不少还强制要求填非空值），于是出现两边各说各话：
   *    服务端日志说「认证已禁用」，客户端却收到 401「API Key 无效或已过期」
   *    —— 实测 xzh 就是这么死的。**「禁用」必须真的禁用。**
   * 2. 配了密钥但没传 → 按 `required` 决定（不强制则放行）。
   * 3. 配了密钥且传了 → 必须在集合里（真认证，传错一定 401）。
   */
  isValid(key: string | null | undefined): boolean {
    if (this.keys.size === 0 && !this.required) return true;
    if (!key) return !this.required;
    return this.keys.has(key);
  }

  /** 添加密钥。 */
  addKey(key: string): void {
    const trimmed = key.trim();
    if (!trimmed) return;
    this.keys.add(trimmed);
    logger.info(
      trimmed.length > 12
        ? `API Key 已添加: ${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`
        : `API Key 已添加: ${trimmed}`,
    );
  }

  /** 移除密钥（返回是否真的移除了）。 */
  removeKey(key: string): boolean {
    return this.keys.delete(key);
  }

  /** 已配置的密钥数量。 */
  get count(): number {
    return this.keys.size;
  }
}

let manager: ApiKeyManager | null = null;

/** 获取 API Key 管理器（单例）。 */
export function getApiKeyManager(): ApiKeyManager {
  manager ??= new ApiKeyManager();
  return manager;
}

/**
 * 校验请求的 API Key，返回使用的密钥（未传且不强制时返回 null）。
 *
 * 失败时抛 {@link AuthenticationError}（401，`invalid_api_key`）。
 */
export function verifyApiKey(request: FastifyRequest): string | null {
  const mgr = getApiKeyManager();
  const apiKey = extractApiKey(request);

  if (!apiKey && mgr.required) {
    throw new AuthenticationError(
      '缺少 API Key。请设置 Authorization: Bearer {key} 或 x-api-key: {key}',
    );
  }

  if (apiKey && !mgr.isValid(apiKey)) {
    throw new AuthenticationError('API Key 无效');
  }

  return apiKey;
}

/**
 * Fastify 钩子：认证所有请求（除豁免路径）。
 *
 * 豁免名单与原实现一致：健康检查 / 状态 / 根路径。
 */
export function makeApiKeyHook(
  skipPaths: ReadonlySet<string>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (skipPaths.has(request.url.split('?')[0] ?? '')) return;
    verifyApiKey(request);
  };
}
