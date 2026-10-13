/**
 * 占位符工具调用过滤 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * AI 有时会把提示词里的**格式示例**原样抄出来：
 * `{"name": "工具名称", "arguments": {"参数1": "值1"}}`，
 * IDE 会去执行一个不存在的工具并报错，必须在返回前拦截。
 *
 * ⚠️ **判定必须从严**：只认「整值就是占位符」，**绝不做子串包含判断**。
 * 真实文件内容里出现「新代码」「文件内容」等词完全正常，
 * 子串判断会把合法的 `write_to_file` 误杀（曾导致工具调用被整体丢弃，
 * 客户端只收到纯文本而不再继续执行工具）。
 */
import { logger } from '../log/logger.js';
import type { ToolCallPayload } from '../types/message.js';

/** 占位符「整值」集合：仅当参数值**整体等于**其中之一时才判定为占位符。 */
export const PLACEHOLDER_VALUES: ReadonlyArray<string> = [
  '真实文件路径',
  '文件内容',
  '要替换的代码',
  '新代码',
  'your_file_path',
  'your_file',
  'path/to/file',
  'path/to/your/file',
  'example.com/path',
  '参数1',
  '参数2',
  '值1',
  '值2',
];

/** 只有这些「路径类」字段才做占位符判定。 */
export const PLACEHOLDER_PATH_KEYS: ReadonlyArray<string> = [
  'file_path',
  'filepath',
  'path',
  'filename',
  'file',
];

/** 占位符工具名。 */
export const PLACEHOLDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  '工具名称',
  '工具名',
  '工具',
  '参数1',
  '<工具名>',
  'tool_name',
  'toolname',
  'your_tool',
  'tool',
  'function_name',
]);

/** 纯尖括号模板，如 `<file_path>` / `<此处填写真实文件路径>`。 */
const ANGLE_PLACEHOLDER = /^<[^<>]{1,50}>$/;

function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

/**
 * 判断工具调用是否为「示例占位符」而非真实调用。
 *
 * 两种情况都应丢弃：
 * 1. **工具名本身是占位符**（如 `工具名称`），或含未填充的尖括号
 * 2. **参数值是占位符**（如 `真实文件路径` / `文件内容`）
 */
export function isPlaceholderToolCall(toolCall: ToolCallPayload): boolean {
  let name = '';
  let rawArgs: unknown = '{}';
  try {
    name = String(toolCall?.function?.name ?? '');
    rawArgs = toolCall?.function?.arguments ?? '{}';
  } catch {
    return false;
  }

  const nameStripped = name.trim();
  if (PLACEHOLDER_TOOL_NAMES.has(nameStripped)) return true;
  if (nameStripped.includes('<') || nameStripped.includes('>')) return true;

  const args = parseArguments(rawArgs);
  if (!args) return false; // 解析不了就不判定，宁可放过

  for (const [key, val] of Object.entries(args)) {
    if (typeof val !== 'string') continue;

    const v = val.trim();
    if (!v) continue;

    // 纯尖括号模板
    if (v.length <= 60 && ANGLE_PLACEHOLDER.test(v)) return true;

    // 路径类字段：整值等于示例词，或明显是示例路径
    if (PLACEHOLDER_PATH_KEYS.includes(key.toLowerCase())) {
      if (PLACEHOLDER_VALUES.includes(v)) return true;
      if (v.startsWith('your_file') || v.startsWith('example.com')) return true;
    }
  }

  return false;
}

/** 过滤掉占位符工具调用，返回 `[有效, 被丢弃]`。 */
export function filterPlaceholderToolCalls(
  toolCalls: ReadonlyArray<ToolCallPayload> | null | undefined,
): { valid: ToolCallPayload[]; dropped: ToolCallPayload[] } {
  const valid: ToolCallPayload[] = [];
  const dropped: ToolCallPayload[] = [];

  for (const tc of toolCalls ?? []) {
    if (isPlaceholderToolCall(tc)) dropped.push(tc);
    else valid.push(tc);
  }

  if (dropped.length > 0) {
    const detail = dropped.map((tc) => {
      let args: string | unknown = tc.function?.arguments ?? '';
      if (typeof args === 'string' && args.length > 200) args = `${args.slice(0, 200)}...`;
      return `${tc.function?.name}(${String(args)})`;
    });
    logger.warn(
      { count: dropped.length },
      `[tool_calls] 丢弃 ${dropped.length} 个占位符工具调用（参数整值为示例文本）：${detail.join(' | ')}`,
    );
  }

  return { valid, dropped };
}
