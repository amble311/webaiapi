/**
 * 调试日志 —— `legacy-python/src/utils/debug_logger.py` 的移植。
 *
 * 仅当 `DEBUG_LOGS=true` 时写入，输出到 `~/.ai-api/logs/debug_YYYYMMDD.log`。
 *
 * 与 `api-logger.ts` 的分工（**不要混**）：
 * - `api-logger` 写**项目内** `logs/api_requests.log`，**原样、不截断**，每次启动重置；
 * - `debug-logger` 写**用户目录** `~/.ai-api/logs/`，**带截断**（500/300/200 字符），
 *   按天分文件、跨重启累积。前者是「事实记录」，后者是「排查辅助」。
 *
 * 与原实现的差异：
 * - Python 的 `@lru_cache(maxsize=1)` 在 TS 里没有直接对应物；这里改用
 *   **惰性 + 可重置的模块级缓存**（`resetDebugLoggerCache()` 供测试用），
 *   语义等价（首次调用时定值，且 config 变更后测试可重置）。
 * - 时间戳 `%H:%M:%S.%f`[:-3] → `HH:mm:ss.SSS`。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { settings } from '../config.js';

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

let cachedLogDir: string | null = null;
let cachedEnabled: boolean | null = null;

/** 重置缓存（测试用；对应 Python 的 `lru_cache` 失效）。 */
export function resetDebugLoggerCache(): void {
  cachedLogDir = null;
  cachedEnabled = null;
}

/** 日志目录：`~/.ai-api/logs`。 */
function debugLogDir(): string {
  if (cachedLogDir === null) {
    cachedLogDir = join(homedir(), '.ai-api', 'logs');
  }
  return cachedLogDir;
}

/** 是否启用调试日志。 */
function isEnabled(): boolean {
  if (cachedEnabled === null) {
    try {
      cachedEnabled = Boolean(settings.debugLogs);
    } catch {
      cachedEnabled = (process.env['DEBUG_LOGS'] ?? 'false').toLowerCase() === 'true';
    }
  }
  return cachedEnabled;
}

/** `debug_YYYYMMDD.log` 的绝对路径。 */
export function debugLogPath(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  return join(debugLogDir(), `debug_${stamp}.log`);
}

/** `HH:mm:ss.SSS`（Python 的 `%H:%M:%S.%f` 取前 3 位）。 */
function timeOnly(date: Date = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.` +
    `${p(date.getMilliseconds(), 3)}`
  );
}

/** 截断过长文本（与原实现一致：追加 `... (共 N 字符)`）。 */
function truncate(text: string, maxLen = 500): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... (共 ${text.length} 字符)`;
}

/** 追加写（失败静默）。 */
function append(lines: string[]): void {
  try {
    mkdirSync(debugLogDir(), { recursive: true });
    appendFileSync(debugLogPath(), `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 调试日志失败绝不能影响主流程
  }
}

/** 格式化消息列表（每条截断到 `maxEach`）。 */
function formatMessages(messages: Array<Record<string, unknown>>, maxEach = 300): string {
  const parts: string[] = [];
  messages.forEach((msg, i) => {
    const role = typeof msg['role'] === 'string' ? (msg['role'] as string) : '?';
    const rawContent = msg['content'];
    const content =
      Array.isArray(rawContent)
        ? JSON.stringify(rawContent).slice(0, maxEach)
        : truncate(String(rawContent ?? ''), maxEach);

    let tcInfo = '';
    const toolCalls = msg['tool_calls'];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const names = toolCalls.map((tc) => {
        const fn = (tc as Record<string, unknown>)?.['function'] as
          | Record<string, unknown>
          | undefined;
        return typeof fn?.['name'] === 'string' ? (fn['name'] as string) : '?';
      });
      tcInfo = ` [tool_calls: ${names.join(', ')}]`;
    }

    // ⚠️ 注意原实现的行为：`tool_call_id` 存在时会**覆盖**掉 `tool_calls` 信息
    //    （是同名变量被重新赋值，看起来像 bug，但保持一致以免日志对照时困惑）
    const toolCallId = msg['tool_call_id'];
    if (typeof toolCallId === 'string' && toolCallId) {
      tcInfo = ` [tool_call_id: ${toolCallId}]`;
    }

    parts.push(`  [${i}] ${role}${tcInfo}: ${content}`);
  });
  return parts.join('\n');
}

/** 格式化工具调用（`arguments` 尽量解析成对象再序列化，失败则原样截断）。 */
function formatToolCalls(toolCalls: Array<Record<string, unknown>>, maxArgs = 200): string {
  const parts: string[] = [];
  for (const tc of toolCalls) {
    const fn = (tc['function'] ?? {}) as Record<string, unknown>;
    const name = typeof fn['name'] === 'string' ? fn['name'] : '?';
    let argsStr: string;
    const rawArgs = fn['arguments'];
    if (typeof rawArgs === 'string') {
      try {
        argsStr = JSON.stringify(JSON.parse(rawArgs));
      } catch {
        argsStr = rawArgs;
      }
    } else {
      try {
        argsStr = JSON.stringify(rawArgs ?? {});
      } catch {
        argsStr = String(rawArgs);
      }
    }
    parts.push(`  - ${name}: ${truncate(argsStr, maxArgs)}`);
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* 公开接口                                                            */
/* ------------------------------------------------------------------ */

/** 记录客户端请求。 */
export function logClientRequest(params: {
  requestId: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  tools?: Array<Record<string, unknown>> | null;
  extra?: Record<string, unknown>;
}): void {
  if (!isEnabled()) return;
  const { requestId, model, messages, stream = true, tools, extra } = params;

  const lines = [
    `[${timeOnly()}] [>>> 客户端请求] [${requestId}]`,
    `  模型: ${model} | 流式: ${stream}`,
    `  消息数: ${messages.length}`,
  ];

  if (tools && tools.length > 0) {
    const names = tools.map((t) => {
      const fn = t['function'] as Record<string, unknown> | undefined;
      return typeof fn?.['name'] === 'string' ? (fn['name'] as string) : '?';
    });
    lines.push(
      `  工具数: ${tools.length} | 工具: ${names.slice(0, 10).join(', ')}` +
        (names.length > 10 ? '...' : ''),
    );
  }

  lines.push('  消息内容:');
  lines.push(formatMessages(messages));

  if (extra) {
    const keys = Object.keys(extra).filter(
      (k) => !['model', 'messages', 'stream', 'tools'].includes(k),
    );
    if (keys.length > 0) {
      const picked: Record<string, unknown> = {};
      for (const k of keys) picked[k] = extra[k];
      lines.push(`  额外参数: ${safeJson(picked)}`);
    }
  }

  lines.push('');
  append(lines);
}

/** 记录返回给客户端的响应。 */
export function logClientResponse(params: {
  requestId: string;
  model: string;
  finishReason: string;
  content?: string;
  toolCalls?: Array<Record<string, unknown>> | null;
  duration?: number;
}): void {
  if (!isEnabled()) return;
  const { requestId, model, finishReason, content, toolCalls, duration = 0 } = params;

  const lines = [
    `[${timeOnly()}] [<<< 客户端响应] [${requestId}]`,
    `  模型: ${model} | 完成原因: ${finishReason} | 耗时: ${duration.toFixed(1)}s`,
  ];

  if (content) lines.push(`  文本内容: ${truncate(content, 500)}`);

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`  工具调用数: ${toolCalls.length}`);
    lines.push('  工具调用:');
    lines.push(formatToolCalls(toolCalls));
  }

  lines.push('');
  append(lines);
}

/** 记录发送给网页 AI 的内容。 */
export function logAiRequest(params: {
  requestId: string;
  platform: string;
  messages: Array<Record<string, unknown>>;
  workspacePath?: string;
}): void {
  if (!isEnabled()) return;
  const { requestId, platform, messages, workspacePath } = params;

  const lines = [
    `[${timeOnly()}] [>>> 发送给AI] [${requestId}] 平台=${platform}`,
    `  工作目录: ${workspacePath || '(未设置)'}`,
    `  消息数: ${messages.length}`,
    '  消息内容:',
  ];

  for (const msg of messages) {
    const role = typeof msg['role'] === 'string' ? (msg['role'] as string) : '?';
    const content = msg['content'];
    const text = String(content ?? '');

    if (role === 'system') {
      lines.push(`  [system] (${text.length} 字符): ${truncate(text, 800)}`);
    } else if (role === 'user') {
      lines.push(`  [user]: ${truncate(text, 300)}`);
    } else if (role === 'assistant') {
      const tc = msg['tool_calls'];
      if (Array.isArray(tc) && tc.length > 0) {
        const names = tc.map((t) => {
          const fn = (t as Record<string, unknown>)?.['function'] as
            | Record<string, unknown>
            | undefined;
          return typeof fn?.['name'] === 'string' ? (fn['name'] as string) : '?';
        });
        lines.push(`  [assistant] tool_calls: ${names.join(', ')}`);
        lines.push(`    文本: ${truncate(text, 200)}`);
      } else {
        lines.push(`  [assistant]: ${truncate(text, 300)}`);
      }
    } else if (role === 'tool') {
      lines.push(`  [tool]: ${truncate(text, 300)}`);
    }
  }

  lines.push('');
  append(lines);
}

/** 记录网页 AI 的原始回复。 */
export function logAiResponse(params: {
  requestId: string;
  platform: string;
  rawText: string;
  parsedToolCalls?: Array<Record<string, unknown>> | null;
  parsedText?: string;
  duration?: number;
}): void {
  if (!isEnabled()) return;
  const { requestId, platform, rawText, parsedToolCalls, parsedText, duration = 0 } = params;

  const lines = [
    `[${timeOnly()}] [<<< AI原始回复] [${requestId}] 平台=${platform} | 耗时: ${duration.toFixed(1)}s`,
    `  原始文本长度: ${rawText.length}`,
    `  原始文本: ${truncate(rawText, 1000)}`,
  ];

  if (parsedText) lines.push(`  解析文本: ${truncate(parsedText, 500)}`);

  if (parsedToolCalls && parsedToolCalls.length > 0) {
    lines.push(`  解析工具调用数: ${parsedToolCalls.length}`);
    lines.push('  解析工具调用:');
    lines.push(formatToolCalls(parsedToolCalls, 300));
  }

  lines.push('');
  append(lines);
}

/** 记录错误。 */
export function logError(requestId: string, error: string, context = ''): void {
  if (!isEnabled()) return;

  const lines = [
    `[${timeOnly()}] [!!! 错误] [${requestId}]`,
    `  错误: ${error}`,
  ];
  if (context) lines.push(`  上下文: ${truncate(context, 500)}`);
  lines.push('');
  append(lines);
}

/** 记录工具调用结果。 */
export function logToolCallResult(params: {
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  duration?: number;
}): void {
  if (!isEnabled()) return;
  const { requestId, toolName, toolArgs, result, duration = 0 } = params;

  append([
    `[${timeOnly()}] [工具执行结果] [${requestId}]`,
    `  工具: ${toolName} | 耗时: ${duration.toFixed(1)}s`,
    `  参数: ${truncate(safeJson(toolArgs), 300)}`,
    `  结果: ${truncate(result, 500)}`,
    '',
  ]);
}

/** `JSON.stringify` 的容错版本（对应 Python `default=str`）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
  } catch {
    return String(value);
  }
}
