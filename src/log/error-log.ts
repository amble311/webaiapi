/**
 * 异常记录（`logs/errors.log`）—— 把「一次失败」的**结构化快照**落盘，便于事后分析。
 *
 * ## 为什么要单独的 `errors.log`
 * `debug_YYYYMMDD.log` 是逐行过程日志（噪音多、关键信息被淹没），`api_requests.log` 是原始报文。
 * 排查一次线上失败时，需要的是一条**带上下文**的记录：哪个请求、哪个模型/平台/账号、卡在哪个阶段、
 * 异常类型与堆栈、以及失败当时的现场（页面状态、耗时等）。
 *
 * ## 硬约束
 * - ⚠️ **绝不写凭证**：`bearer` / `cookie` / `token` / `authorization` / `password` / `secret` / `session`
 *   这类键一律替换成 `[redacted]`（含嵌套对象与数组）。
 * - ⚠️ 单条记录有长度上限（长文本截断），防止把几十 MB 的提示词写进日志。
 * - ⚠️ 文件超过 `MAX_LOG_BYTES` 时整体截断（简单轮转，不引入依赖）。
 * - ⚠️ 写日志本身**绝不抛错**（日志失败不能把业务带崩）。
 */
import { appendFileSync, existsSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { settings } from '../config.js';
import { logger } from './logger.js';

/** 一次失败的结构化上下文。 */
export interface ErrorContext {
  /** 请求 id（日志前缀 `[chatcmpl-xxx]` 里那个）。 */
  requestId?: string;
  /** 客户端请求的模型名。 */
  model?: string;
  /** 实际使用的平台（`chatgpt` / `deepseek` / …）。 */
  platform?: string;
  /** 账号 id。 */
  accountId?: string;
  /** 失败阶段（如 `send` / `stream` / `failover` / `compress` / `login`）。 */
  phase?: string;
  /** 额外现场信息（会被脱敏 + 截断）。 */
  extra?: Record<string, unknown>;
}

/** 敏感字段（命中就替换）。 */
const SENSITIVE_KEY = /(bearer|cookie|token|authorization|password|secret|session|apikey|api_key)/i;

/** 单个字符串值的最长保留长度。 */
const MAX_STRING = 800;

/** 日志文件大小上限（超过就整体截断）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** `errors.log` 的绝对路径。 */
export function resolveErrorsLogPath(logDir: string = settings.logDir): string {
  const dir = isAbsolute(logDir) ? logDir : resolve(process.cwd(), logDir);
  return join(dir, 'errors.log');
}

/**
 * 脱敏 + 截断（**纯函数**，可单测）。
 *
 * @param value 任意值
 * @param depth 当前深度（超过 4 层就折叠，避免巨型对象）
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…（截断，共 ${value.length} 字符）` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return '[function]';
  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return '[深度过深已折叠]';

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeValue(item, depth + 1);
  }
  return out;
}

/** 从任意异常里取出 message / name / stack。 */
export function describeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: String(error.message ?? '').slice(0, 2000),
      stack: String(error.stack ?? '')
        .split('\n')
        .slice(0, 20)
        .join('\n'),
    };
  }
  return { name: typeof error, message: String(error).slice(0, 2000), stack: '' };
}

/** 组装一条结构化记录（**纯函数**，可单测）。 */
export function buildErrorRecord(
  context: ErrorContext,
  error: unknown,
  options: { id?: string; now?: () => Date } = {},
): Record<string, unknown> {
  const now = options.now ?? (() => new Date());
  const described = describeError(error);
  return {
    id: options.id ?? randomUUID().slice(0, 8),
    ts: now().toISOString(),
    requestId: context.requestId ?? null,
    model: context.model ?? null,
    platform: context.platform ?? null,
    accountId: context.accountId ?? null,
    phase: context.phase ?? null,
    error: described,
    extra: context.extra ? (sanitizeValue(context.extra) as Record<string, unknown>) : null,
  };
}

/**
 * 记录一次异常：写 `errors.log`（JSON 一行）+ `logger.error`。
 *
 * @returns 本次记录 id（也会打在日志里，便于和客户端报错对账）
 */
export function logError(context: ErrorContext, error: unknown): string {
  const record = buildErrorRecord(context, error);
  const id = String(record['id']);
  const line = JSON.stringify(record);

  const summary =
    `[error:${id}] ${context.phase ?? '-'} ` +
    `${context.model ?? '-'}/${context.platform ?? '-'}` +
    (context.requestId ? ` req=${context.requestId}` : '') +
    ` :: ${describeError(error).message}`;
  logger.error(summary);

  try {
    const file = resolveErrorsLogPath();
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      truncateSync(file, 0); // 简单轮转：超限直接清空（不引入依赖）
    }
    appendFileSync(file, `${line}\n`, 'utf8');
  } catch (writeError) {
    // ⚠️ 日志写失败绝不能影响业务
    logger.debug(`[error-log] 写入失败: ${String(writeError)}`);
  }

  return id;
}
