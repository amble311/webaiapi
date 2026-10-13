/**
 * 工具调用构造 —— `legacy-python/src/utils/tool_calls.py` 的 `_build_tool_call`。
 *
 * 负责把「AI 输出的工具名 + 参数」规范成 OpenAI `tool_calls` 结构：
 * 1. 过滤 IDE 内部工具（返回一条带 error 的调用，避免 AI 无限等结果）
 * 2. 工具名别名映射（`edit_file` → `SearchReplace`）
 * 3. **动态映射到客户端真实工具名**（`Write` → `write_to_file`）
 * 4. 参数名归一化 + 映射到客户端真实参数名（`file_path` → `filePath`）
 * 5. 清理参数值里的 DOM HTML 残留
 */
import { logger } from '../log/logger.js';
import type { ToolCallPayload, ToolDefinition } from '../types/message.js';
import { cleanDomHtml } from './clean.js';
import {
  type ToolMaps,
  EMPTY_TOOL_MAPS,
  TOOL_NAME_ALIASES,
  TRAE_INTERNAL_TOOLS,
  makeToolCallId,
  normalizeParamKey,
  normalizeToolArguments,
} from './names.js';

/**
 * 构造 OpenAI 格式的 tool_call。
 *
 * @param name AI 输出的工具名
 * @param args AI 输出的参数（对象或 JSON 字符串）
 * @param maps 本次请求的工具映射表（替代 Python 版的模块级全局变量）
 * @returns 规范化后的 tool_call；`name` 为空时返回 `null`
 */
export function buildToolCall(
  name: string | null | undefined,
  args: unknown,
  maps: ToolMaps = EMPTY_TOOL_MAPS,
): ToolCallPayload | null {
  if (!name) return null;

  // === 1. IDE 内部工具：在网页 API 环境里不可用 ===
  // 返回一条带 error 的调用，告诉 AI「这个工具不存在」，避免它无限等待执行结果
  if (TRAE_INTERNAL_TOOLS.has(name)) {
    logger.warn({ name }, '[tool_calls] 忽略 Trae 内部工具');
    return {
      id: makeToolCallId(),
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify({
          error: `工具 '${name}' 仅在 Trae IDE 环境中可用，当前为网页 API 环境。`,
          suggestion: '请使用文本方式回复用户，不要调用此工具。',
        }),
      },
    };
  }

  // === 2. 工具名别名 → 标准名 ===
  let toolName = TOOL_NAME_ALIASES[name] ?? name;

  // === 3. 标准名 → 客户端真实工具名 ===
  if (toolName === 'Write' && maps.name['write']) toolName = maps.name['write'];
  else if (toolName === 'SearchReplace' && maps.name['edit']) toolName = maps.name['edit'];
  else if (toolName === 'Read' && maps.name['read']) toolName = maps.name['read'];

  // === 4. 参数归一化 ===
  let argsObj: Record<string, unknown>;
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      argsObj =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { _raw: args };
    } catch {
      argsObj = { _raw: args };
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    argsObj = { ...(args as Record<string, unknown>) };
  } else {
    argsObj = {};
  }

  argsObj = normalizeToolArguments(toolName, argsObj);

  // === 5. 映射到客户端真实参数名（file_path → filePath） ===
  const clientParams = maps.param[toolName];
  if (clientParams && Object.keys(clientParams).length > 0) {
    const mappedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(argsObj)) {
      const clientKey = clientParams[normalizeParamKey(key)] ?? key;
      if (!(clientKey in mappedArgs)) mappedArgs[clientKey] = value;
    }
    argsObj = mappedArgs;
  }

  // === 6. 清理参数值里的 DOM HTML 标签 ===
  for (const [key, value] of Object.entries(argsObj)) {
    if (typeof value === 'string') {
      const cleaned = cleanDomHtml(value);
      if (cleaned !== value) argsObj[key] = cleaned;
    }
  }

  return {
    id: makeToolCallId(),
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify(argsObj),
    },
  };
}

/** 便捷：给一批调用做「工具名是否在客户端列表中」的预检（只读，不修改）。 */
export function isKnownToolName(
  name: string,
  tools: ReadonlyArray<ToolDefinition> | null | undefined,
): boolean {
  if (!tools || tools.length === 0) return true;
  return tools.some((t) => t?.function?.name === name);
}
