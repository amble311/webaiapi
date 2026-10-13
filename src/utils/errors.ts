/**
 * 自定义异常 —— `legacy-python/src/utils/exceptions.py` 的移植。
 *
 * TypeScript 没有「继承 Exception 并按类型捕获」的惯用法，这里保留类层次
 * （`instanceof` 判断依然好用），但**新增 `code` 字段**：路由层需要把不同异常
 * 映射成不同的 HTTP 状态码与 OpenAI 错误码，靠字符串比较太脆。
 *
 * 与原实现的差异：
 * - Python 侧 `LoginRequiredException` / `LoginExpiredException` / `RateLimitException` /
 *   `NetworkException` / `ResponseTimeoutException` / `NoAvailableInstanceError` /
 *   `AccountBannedError` 定义了但**从未被抛出**（只有 `ModelNotFoundError` 与
 *   `PlatformUnavailableException` 在用）。这里保留它们（成本极低，且是公开 API 的
 *   一部分语义），但标注清楚。
 */
export class AIAPIServiceError extends Error {
  /** OpenAI 风格错误码（`buildOpenAiError` 的 `code`）。 */
  readonly code: string;

  /** 建议的 HTTP 状态码。 */
  readonly statusCode: number;

  constructor(message: string, options: { code?: string; statusCode?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'internal_error';
    this.statusCode = options.statusCode ?? 500;
    // 让 `instanceof` 在编译到 ES5 目标时也可靠（这里目标是 ES2023，仅为稳妥保留）
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 需要登录。 */
export class LoginRequiredError extends AIAPIServiceError {
  constructor(message = '需要登录后才能使用') {
    super(message, { code: 'login_required', statusCode: 401 });
  }
}

/** 登录已过期。 */
export class LoginExpiredError extends AIAPIServiceError {
  constructor(message = '登录已过期，请重新登录') {
    super(message, { code: 'login_expired', statusCode: 401 });
  }
}

/** 触发限流。 */
export class RateLimitError extends AIAPIServiceError {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(message, { code: 'rate_limit_exceeded', statusCode: 429 });
  }
}

/** 网络异常。 */
export class NetworkError extends AIAPIServiceError {
  constructor(message = '网络异常') {
    super(message, { code: 'network_error', statusCode: 502 });
  }
}

/** 响应超时。 */
export class ResponseTimeoutError extends AIAPIServiceError {
  constructor(message = '请求超时：服务器未能在规定时间内完成响应') {
    super(message, { code: 'request_timeout', statusCode: 504 });
  }
}

/** 模型未找到（**在用**：`ModelRouter` 路由失败时抛出，映射为 404）。 */
export class ModelNotFoundError extends AIAPIServiceError {
  constructor(model: string) {
    super(`模型 '${model}' 不存在或不可用`, { code: 'model_not_found', statusCode: 404 });
  }
}

/** Provider 未找到。 */
export class ProviderNotFoundError extends AIAPIServiceError {
  constructor(provider: string) {
    super(`Provider '${provider}' 不存在`, { code: 'provider_not_found', statusCode: 404 });
  }
}

/** 没有可用的浏览器实例。 */
export class NoAvailableInstanceError extends AIAPIServiceError {
  constructor(message = '没有可用的浏览器实例') {
    super(message, { code: 'no_available_instance', statusCode: 503 });
  }
}

/** 账号被封禁。 */
export class AccountBannedError extends AIAPIServiceError {
  constructor(message = '账号已被封禁') {
    super(message, { code: 'account_banned', statusCode: 403 });
  }
}

/** 无效请求（映射为 400）。 */
export class InvalidRequestError extends AIAPIServiceError {
  constructor(message = '无效请求') {
    super(message, { code: 'invalid_request_error', statusCode: 400 });
  }
}

/** 认证失败（映射为 401）。 */
export class AuthenticationError extends AIAPIServiceError {
  constructor(message = '认证失败') {
    super(message, { code: 'invalid_api_key', statusCode: 401 });
  }
}

/**
 * 平台所有账号都不可用（**在用**）。
 *
 * 当某平台的所有账号都失败（凭证失效 / 限流 / 被封）时抛出：
 * - `mix` 模型：router 捕获后切换到下一个优先级平台
 * - 平台名模型（如 `chatglm`）：不跨平台，直接返回错误给用户
 */
export class PlatformUnavailableError extends AIAPIServiceError {
  readonly platform: string;

  constructor(platform: string, message = '') {
    super(
      message
        ? `平台 '${platform}' 不可用: ${message}`
        : `平台 '${platform}' 不可用（所有账号均失败）`,
      { code: 'platform_unavailable', statusCode: 503 },
    );
    this.platform = platform;
  }
}

/** 把任意抛出物转成错误消息（`catch (e)` 的 `e` 类型不确定）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
