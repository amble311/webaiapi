/**
 * API 请求/响应日志 —— `legacy-python/src/utils/api_logger.py` 的移植。
 *
 * ⚠️⚠️ **本文件的核心契约：原样记录、不加工、不截断**（用户明确要求）。
 * 这里的每一行格式都被 `grep` 依赖过，改格式前请先读
 * `docs/hard-constraints.md` 的「日志」一节。
 *
 * 输出文件：`<项目根>/logs/api_requests.log`，**每次启动重置**（见 {@link resetApiLog}）。
 *
 * 格式：
 * ```
 * [时间戳] ========== 第 N 轮 [request_id] ==========
 * [>>> USER]  第 N 轮收到用户消息:
 *     <用户消息原文，逐行缩进 4 空格>
 *
 * [时间戳] ========== 第 N 轮 [request_id] ==========
 * [<<< AI]  第 N 轮网页回复消息:
 *   AI 平台: chatglm
 *   原始文本长度: 1234
 *     <AI 原始回复，逐行缩进 4 空格>
 * ```
 *
 * 方向标记：
 * - `>>> USER` 用户发给网关的消息（原始）
 * - `<<< AI` 网页 AI 的回复（原始）
 * - `>>> REQUEST` / `<<< RESPONSE` 客户端请求 / 网关响应
 * - `>>> AI` / `<<< AI` 发给平台 / 平台返回
 * - `!!! ERROR` 错误
 *
 * 与原实现的差异：
 * - `api_logger.py` 里有个 `_truncate_json()` **从未被调用**（死代码），不移植。
 * - 日志目录：Python 写死 `<源码根>/logs`；TS 侧优先用 `settings.logDir`
 *   （绝对路径直接用，相对路径按项目根解析），默认值与 Python 一致。
 * - 时间戳格式完全一致：`YYYY-MM-DD HH:mm:ss.SSS`（Python 是 `%f` 取前 3 位）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settings } from '../config.js';

/** 模块所在目录（`dist/log/` 或 `src/log/`），用于定位项目根。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 项目根：`src/log/` 或 `dist/log/` 往上两级。 */
const PROJECT_ROOT = join(MODULE_DIR, '..', '..');

/**
 * API 日志目录。
 *
 * 解析顺序：`settings.logDir` 为绝对路径则直接用；否则按项目根解析。
 * 这与 Python 版「写死 `<源码根>/logs`」等价（默认 `logDir = "logs"`）。
 */
function logDir(): string {
  const configured = settings.logDir || 'logs';
  return isAbsolute(configured) ? configured : join(PROJECT_ROOT, configured);
}

/** `logs/api_requests.log` 的绝对路径。 */
export function apiLogPath(): string {
  return join(logDir(), 'api_requests.log');
}

function ensureDir(): string {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `YYYY-MM-DD HH:mm:ss.SSS`（与 Python `%Y-%m-%d %H:%M:%S.%f` 取前 3 位一致）。 */
export function formatTimestamp(date: Date = new Date()): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.` +
    `${p(date.getMilliseconds(), 3)}`
  );
}

/** 追加写（失败不影响主流程）。 */
function append(lines: string[]): void {
  try {
    ensureDir();
    appendFileSync(apiLogPath(), `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 日志失败绝不能让请求失败
  }
}

/**
 * 重置日志（**每次启动调用一次**）。
 *
 * 这是既定行为：`api_requests.log` 每次启动清空，只保留本次运行的记录，
 * 避免排查时被历史轮次干扰。旧文件不备份（用户明确要求）。
 */
export function resetApiLog(): void {
  try {
    ensureDir();
    writeFileSync(apiLogPath(), '', 'utf8');
  } catch {
    // 忽略
  }
}

/** 把多模态 content 取成纯文本（只取 `type=text` 项，与 Python 一致）。 */
function contentToText(content: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (rec['type'] === 'text') parts.push(String(rec['text'] ?? ''));
      }
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  return String(content);
}

/** 逐行缩进（Python 里就是 `f"    {_line}"`）。 */
function indent(text: string, prefix = '    '): string[] {
  return text.split('\n').map((line) => `${prefix}${line}`);
}

/** 取消息的 `tool_calls` 名字列表（容错，结构可能不规范）。 */
function toolCallNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc) => {
    const fn = (tc as Record<string, unknown> | null)?.['function'];
    const name = (fn as Record<string, unknown> | undefined)?.['name'];
    return typeof name === 'string' ? name : '?';
  });
}

/* ==================================================================== */
/* 公开接口                                                              */
/* ==================================================================== */

/** 记录 API 请求（客户端 → 网关）。消息列表**原样记录**，不做任何加工/截断。 */
export function logApiRequest(params: {
  requestId: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  stream: boolean;
  tools?: Array<Record<string, unknown>> | null;
  workspacePath?: string;
}): void {
  const { requestId, model, messages, stream, tools, workspacePath } = params;
  const timestamp = formatTimestamp();

  const lines = [
    `\n[${timestamp}] ========== API 请求 [${requestId}] ==========`,
    '[>>> REQUEST]',
    `  模型: ${model}`,
    `  流式: ${stream}`,
    `  消息数: ${messages.length}`,
  ];

  if (tools && tools.length > 0) {
    const names = tools.map((t) => {
      const fn = t['function'] as Record<string, unknown> | undefined;
      return typeof fn?.['name'] === 'string' ? (fn['name'] as string) : '?';
    });
    lines.push(`  工具数: ${tools.length} | 工具: ${names.slice(0, 5).join(', ')}`);
  }

  if (workspacePath) lines.push(`  工作目录: ${workspacePath}`);

  // 原样记录，不截断
  lines.push('\n  [消息列表]:');
  messages.forEach((msg, i) => {
    const role = typeof msg['role'] === 'string' ? (msg['role'] as string) : '?';
    const contentStr = contentToText(msg['content']);
    const names = toolCallNames(msg['tool_calls']);
    const tcInfo = names.length > 0 ? ` [工具调用: ${names.join(', ')}]` : '';
    lines.push(`    [${i}] ${role}${tcInfo}:`);
    lines.push(...indent(contentStr, '      '));
  });

  append(lines);
}

/** 记录第 N 轮交互开始（用户消息原文）。 */
export function logRoundStart(requestId: string, roundNum: number, userMessage: string): void {
  const timestamp = formatTimestamp();
  const lines = [
    `\n[${timestamp}] ========== 第 ${roundNum} 轮 [${requestId}] ==========`,
    `[>>> USER]  第 ${roundNum} 轮收到用户消息:`,
    ...indent(String(userMessage)),
  ];
  append(lines);
}

/** 记录网页 AI 的完整回复（原始文本，逐行原样）。 */
export function logAiPlatformResponseComplete(params: {
  requestId: string;
  platform: string;
  roundNum: number;
  rawText: string;
}): void {
  const { requestId, platform, roundNum, rawText } = params;
  const timestamp = formatTimestamp();
  const lines = [
    `\n[${timestamp}] ========== 第 ${roundNum} 轮 [${requestId}] ==========`,
    `[<<< AI]  第 ${roundNum} 轮网页回复消息:`,
    `  AI 平台: ${platform}`,
    `  原始文本长度: ${rawText.length}`,
    ...indent(String(rawText)),
  ];
  append(lines);
}

/** 记录网关返回给客户端的响应。 */
export function logApiResponse(params: {
  requestId: string;
  model: string;
  content?: string | null;
  toolCalls?: Array<Record<string, unknown>> | null;
  finishReason?: string;
  duration?: number;
}): void {
  const {
    requestId,
    model,
    content,
    toolCalls,
    finishReason = 'stop',
    duration = 0,
  } = params;
  const timestamp = formatTimestamp();

  const lines = [
    `\n[${timestamp}] ========== API 响应 [${requestId}] ==========`,
    '[<<< RESPONSE]',
    `  模型: ${model}`,
    `  完成原因: ${finishReason}`,
    `  耗时: ${duration.toFixed(1)}s`,
  ];

  if (content) {
    lines.push(`\n  [回复内容] (${content.length} 字符):`);
    lines.push(...indent(content));
  }

  if (toolCalls && toolCalls.length > 0) {
    lines.push(`\n  [工具调用] (${toolCalls.length} 个):`);
    toolCalls.forEach((tc, i) => {
      const fn = (tc['function'] ?? {}) as Record<string, unknown>;
      const name = typeof fn['name'] === 'string' ? fn['name'] : '?';
      const args = JSON.stringify(fn['arguments'] ?? '{}');
      lines.push(`    [${i}] ${name}: ${args}`);
    });
  }

  append(lines);
}

/** 记录发送给平台的内容。 */
export function logAiPlatformRequest(params: {
  requestId: string;
  platform: string;
  messages: Array<Record<string, unknown>>;
}): void {
  const { requestId, platform, messages } = params;
  const timestamp = formatTimestamp();

  const lines = [
    `\n[${timestamp}] ========== 发送给 AI 平台 [${requestId}] ==========`,
    '[>>> AI]',
    `  平台: ${platform}`,
    `  消息数: ${messages.length}`,
    '\n  [消息内容]:',
  ];

  messages.forEach((msg, i) => {
    const role = typeof msg['role'] === 'string' ? (msg['role'] as string) : '?';
    lines.push(`    [${i}] ${role}:`);
    lines.push(...indent(contentToText(msg['content']), '      '));
  });

  append(lines);
}

/** 记录平台的回复（原始文本 + 解析出的工具调用）。 */
export function logAiPlatformResponse(params: {
  requestId: string;
  platform: string;
  rawText: string;
  parsedToolCalls?: Array<Record<string, unknown>> | null;
  duration?: number;
}): void {
  const { requestId, platform, rawText, parsedToolCalls, duration = 0 } = params;
  const timestamp = formatTimestamp();

  const lines = [
    `\n[${timestamp}] ========== AI 平台回复 [${requestId}] ==========`,
    '[<<< AI]',
    `  平台: ${platform}`,
    `  耗时: ${duration.toFixed(1)}s`,
    `  原始文本长度: ${rawText.length}`,
    '\n  [原始文本]:',
    ...indent(rawText),
  ];

  if (parsedToolCalls && parsedToolCalls.length > 0) {
    lines.push(`\n  [解析工具调用] (${parsedToolCalls.length} 个):`);
    parsedToolCalls.forEach((tc, i) => {
      const fn = (tc['function'] ?? {}) as Record<string, unknown>;
      const name = typeof fn['name'] === 'string' ? fn['name'] : '?';
      const args = JSON.stringify(fn['arguments'] ?? '{}');
      lines.push(`    [${i}] ${name}: ${args}`);
    });
  }

  append(lines);
}

/** 记录错误。 */
export function logApiError(requestId: string, error: string, context = ''): void {
  const timestamp = formatTimestamp();
  const lines = [
    `\n[${timestamp}] ========== API 错误 [${requestId}] ==========`,
    '[!!! ERROR]',
    `  错误: ${error}`,
  ];
  if (context) lines.push(`  上下文: ${context.slice(0, 500)}`);
  append(lines);
}
