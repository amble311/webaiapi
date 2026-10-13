/**
 * 日志 —— 替代 Python 版的 loguru。
 *
 * 与原实现的差异：
 * - Python 用 loguru（`logger.info` / `logger.warning`），TS 用 pino。
 * - 测试环境自动静音：pino 在 import 时就绑定 level，若不静音，单测输出会被
 *   大量 `[tool_calls] ...` 噪音淹没。
 * - `logs/api_requests.log` 那种「原样记录、不做任何加工」的日志**不走 pino**，
 *   由 `src/log/api-logger.ts` 直接追加写文件（见 docs/hard-constraints.md「日志」）。
 */
import pino from 'pino';

const isTest = Boolean(process.env['VITEST']) || process.env['NODE_ENV'] === 'test';

/** 解析日志级别，非法值回退 info。 */
export function resolveLogLevel(raw: string | undefined): pino.LevelWithSilent {
  if (!raw) return isTest ? 'silent' : 'info';

  const normalized = raw.trim().toLowerCase();
  const allowed: pino.LevelWithSilent[] = [
    'silent',
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
  ];
  return (allowed as string[]).includes(normalized)
    ? (normalized as pino.LevelWithSilent)
    : 'info';
}

export const logger = pino({
  level: isTest ? 'silent' : resolveLogLevel(process.env['LOG_LEVEL']),
  base: undefined, // 去掉 pid/hostname，日志更接近 loguru 的可读输出
});

export type Logger = typeof logger;
