/**
 * 从 AI 文本里解析工具调用 —— `legacy-python/src/utils/tool_calls.py` 的 `parse_tool_calls_from_text`。
 *
 * 一共 7 层 Pattern，一层比一层宽容（都是被真实输出逼出来的）：
 * 1. `<tool_call>{...}</tool_call>`（我们注入的标准格式）
 * 2. `<tool_call name="X">{...}</tool_call`（模型把名字写成 XML 属性）
 * 3. `{"name":"X","arguments":{...}}</tool_call`（名字在 JSON 里，闭合标签残缺）
 * 4. `tool_call>{...}</tool_call`（少了开头的 `<`）
 * 5. `tool_call>{...}`（完全没有闭合标签）
 * 6. 标签全碎：直接在正文里扫 `{"name": ...}` 并 raw_decode
 * 7. 超级兜底：`<tool_call>` 被当 HTML 消费、内部 JSON 被渲染破坏 → 先修复再扫
 *
 * 返回值与原实现的 Tuple 不同：改为 `{ text, toolCalls }` 对象，避免调用方解构时写错顺序。
 */
import { logger } from '../log/logger.js';
import type { ToolCallPayload } from '../types/message.js';
import { buildToolCall } from './build.js';
import { normalizeToolCallTags, stripLeftoverToolTags } from './clean.js';
import { type ToolMaps, EMPTY_TOOL_MAPS } from './names.js';
import {
  BROKEN_TAG_INDICATOR,
  DOM_CORRUPTION_INDICATOR,
  DOM_PREVIEW_KEY_INDICATOR,
  hasSmartQuotes,
  repairDomCorruptedJson,
  tryParseJson,
} from './repair.js';

/**
 * Pattern 1：`<tool_call>{...}</tool_call>`（全局版，DOTALL）
 *
 * ⚠️ 结尾必须带 `>`。Python 原版是 `re.escape("</tool_call>")`，
 * 漏掉 `>` 会导致删除工具调用块后正文里残留一个孤立的 `>`。
 */
const P1_TOOL_CALL_PATTERN = /<tool_call>\s*(.*?)\s*<\/tool_call>/gsu;

/** Pattern 2：`<tool_call name="X">{...}</tool_call` */
const XML_TOOL_CALL_PATTERN =
  /<tool_call\s+name\s*=\s*["']([^"']+)["']\s*>(.*?)<\/tool_call/gsu;

/** Pattern 3：`{...}</tool_call`（名字在 JSON 内部） */
const JSON_TOOL_CALL_PATTERN = /(\{.*?\})\s*<\/tool_call/gsu;

/** Pattern 4：宽容版，`tool_call>` 前没有 `<` */
const LENIENT_TOOL_PATTERN = /tool_call>\s*(.*?)\s*<\/tool_call/gsu;

/** Pattern 5：极宽容，`tool_call>` + JSON 且**完全没有闭合标签** */
const NO_CLOSE_TOOL_PATTERN = /<?>?tool_call>\s*(\{)/gsu;

/** 扫描 `{"name": ...}` 起点用的正则（Pattern 6/7）。 */
const JSON_NAME_START = /\{\s*"name"\s*:\s*"/gu;

/**
 * 等价于 Python `json.JSONDecoder().raw_decode(text, pos)`。
 *
 * 从 `text[pos]` 开始解析**第一个完整的 JSON 值**，返回其结束位置（**绝对下标**）。
 * Python 的 `raw_decode` 允许后面还有别的内容，JS 的 `JSON.parse` 不允许，
 * 所以这里自己扫括号配平（正确处理字符串与转义），再对切片做 `JSON.parse`。
 *
 * @param pos 起始下标；ChatGLM 的 SSE 报文会把多个 JSON 直接拼在一行，
 *   需要从任意位置连续往后扫（`pos` 让调用方免于反复 `slice`，避免 O(n²)）。
 */
export function rawDecodeJson(
  text: string,
  pos = 0,
): { value: unknown; end: number } | undefined {
  let i = pos;
  while (i < text.length && /\s/.test(text[i] as string)) i += 1;

  const first = text[i];
  if (first !== '{' && first !== '[') return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let j = i; j < text.length; j += 1) {
    const ch = text[j] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(i, j + 1)), end: j + 1 };
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

type Span = [number, number];

function spansOverlap(start: number, end: number, spans: ReadonlyArray<Span>): boolean {
  return spans.some(([s, e]) => start < e && end > s);
}

/** 结果对象。 */
export interface ParseResult {
  /** 移除工具调用块之后的剩余正文。 */
  text: string;
  /** OpenAI 格式的工具调用列表。 */
  toolCalls: ToolCallPayload[];
}

/**
 * 从 AI 回复文本中解析工具调用。
 *
 * @param text AI 完整回复
 * @param maps 本请求的工具映射表（决定了标准名会映射到哪个客户端真实工具名）
 */
export function parseToolCallsFromText(
  text: string,
  maps: ToolMaps = EMPTY_TOOL_MAPS,
): ParseResult {
  // === 预处理：修复 DOM 提取导致的标签破碎 ===
  const normalized = normalizeToolCallTags(text);

  const toolCalls: ToolCallPayload[] = [];
  const removalSpans: Span[] = [];
  let repaired = '';

  /** 统一的「从 JSON 对象构造调用」步骤，成功才登记待删除区间。 */
  const tryAdd = (data: Record<string, unknown> | undefined, start: number, end: number): boolean => {
    if (!data) return false;
    const tc = buildToolCall(
      data['name'] as string | undefined,
      data['arguments'] ?? {},
      maps,
    );
    if (!tc) return false;
    toolCalls.push(tc);
    removalSpans.push([start, end]);
    return true;
  };

  // --- Pattern 1 ---
  for (const match of normalized.matchAll(P1_TOOL_CALL_PATTERN)) {
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;

    // 有 DOM 损坏特征就跳过，交给 Pattern 7；否则 tryParseJson 的正则兜底会拿到短预览值
    if (
      DOM_PREVIEW_KEY_INDICATOR.test(raw) ||
      DOM_CORRUPTION_INDICATOR.test(raw) ||
      hasSmartQuotes(raw)
    ) {
      continue;
    }

    const start = match.index ?? 0;
    tryAdd(tryParseJson(raw), start, start + match[0].length);
  }

  // --- Pattern 2 ---
  for (const match of normalized.matchAll(new RegExp(XML_TOOL_CALL_PATTERN.source, 'gsu'))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;

    const name = (match[1] ?? '').trim();
    const rawArgs = (match[2] ?? '').trim();
    const parsed = rawArgs ? tryParseJson(rawArgs) : undefined;
    const args = parsed && typeof parsed === 'object' ? parsed : {};

    const tc = buildToolCall(name, args, maps);
    if (tc) {
      toolCalls.push(tc);
      removalSpans.push([start, end]);
    }
  }

  // --- Pattern 4 ---
  // ⚠️ 与原设计不同处：这里**先跑 Pattern 4 再跑 Pattern 3**。
  //    Pattern 4 的匹配区间包含开头的 `tool_call>`，区间更大，
  //    先注册它就能把整段（含破碎标签）一次删干净；
  //    若按 Python 的顺序先跑 Pattern 3（只从 `{` 开始），
  //    残留的 `tool_call>` 会被 stripLeftoverToolTags 清掉、但最后会多留一个 `>` 在正文里。
  for (const match of normalized.matchAll(new RegExp(LENIENT_TOOL_PATTERN.source, 'gsu'))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;

    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    const data = tryParseJson(raw);
    if (!data) continue;

    tryAdd(data, start, end);
  }

  // --- Pattern 3 ---
  for (const match of normalized.matchAll(new RegExp(JSON_TOOL_CALL_PATTERN.source, 'gsu'))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;

    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    const data = tryParseJson(raw);
    if (!data) continue;

    tryAdd(data, start, end);
  }

  // --- Pattern 5 ---
  for (const match of normalized.matchAll(new RegExp(NO_CLOSE_TOOL_PATTERN.source, 'gsu'))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;

    const jsonStart = start + match[0].length - 1; // 指向 "{"
    const decoded = rawDecodeJson(normalized.slice(jsonStart));
    if (!decoded) continue;

    const data = decoded.value as Record<string, unknown>;
    if (!data || typeof data !== 'object') continue;

    const tc = buildToolCall(data['name'] as string | undefined, data['arguments'] ?? {}, maps);
    if (tc) {
      toolCalls.push(tc);
      removalSpans.push([start, jsonStart + decoded.end]);
    }
  }

  // --- Pattern 6：标签全碎时从正文里扫 JSON ---
  if (toolCalls.length === 0 && BROKEN_TAG_INDICATOR.test(normalized)) {
    logger.info('[tool_calls] 标签破碎但未提取到工具调用，启用 Pattern 6 兜底扫描');
    scanStandaloneJson(normalized, toolCalls, removalSpans, maps);
  }

  // --- Pattern 7：修复被 DOM 破坏的 JSON 后再扫 ---
  if (
    toolCalls.length === 0 &&
    (BROKEN_TAG_INDICATOR.test(normalized) ||
      DOM_CORRUPTION_INDICATOR.test(normalized) ||
      DOM_PREVIEW_KEY_INDICATOR.test(normalized))
  ) {
    repaired = repairDomCorruptedJson(normalized);
    if (repaired && repaired !== normalized) {
      logger.info(
        { from: normalized.length, to: repaired.length },
        '[tool_calls] Pattern 7 DOM 损坏修复',
      );

      const before = toolCalls.length;
      scanStandaloneJson(repaired, toolCalls, removalSpans, maps);

      for (const tc of toolCalls.slice(before)) {
        const name = tc.function.name;
        let argKeys: string[] = [];
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments);
          if (parsed && typeof parsed === 'object') argKeys = Object.keys(parsed);
        } catch {
          // 忽略：只为日志
        }
        logger.info({ name, argKeys }, '[tool_calls] Pattern 7 修复后提取');

        if (name === 'SearchReplace') {
          try {
            const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            logger.info(
              {
                filePath: parsed['file_path'],
                oldStrLen: String(parsed['old_str'] ?? '').length,
                newStrLen: String(parsed['new_str'] ?? '').length,
              },
              '[tool_calls] SearchReplace 参数',
            );
          } catch {
            // 忽略
          }
        }
      }
    }
  }

  // === 移除所有命中的区间（从后往前，避免位置失效） ===
  let remaining = toolCalls.length > 0 && repaired && repaired !== normalized ? repaired : normalized;
  for (const [start, end] of [...removalSpans].sort((a, b) => b[0] - a[0])) {
    remaining = remaining.slice(0, start) + remaining.slice(end);
  }

  return { text: stripLeftoverToolTags(remaining).trim(), toolCalls };
}

/**
 * 扫描形如 `{"name": "...", "arguments": {...}}` 的独立 JSON 对象。
 * Pattern 6 / Pattern 7 共用。
 */
function scanStandaloneJson(
  source: string,
  toolCalls: ToolCallPayload[],
  removalSpans: Span[],
  maps: ToolMaps,
): void {
  for (const match of source.matchAll(new RegExp(JSON_NAME_START.source, 'gu'))) {
    const jsonStart = match.index ?? 0;
    if (spansOverlap(jsonStart, jsonStart + match[0].length, removalSpans)) continue;

    const decoded = rawDecodeJson(source.slice(jsonStart));
    if (!decoded) continue;

    const data = decoded.value as Record<string, unknown>;
    if (!data || typeof data !== 'object') continue;
    if (!('name' in data) || !('arguments' in data)) continue;

    const tc = buildToolCall(data['name'] as string | undefined, data['arguments'], maps);
    if (tc) {
      toolCalls.push(tc);
      removalSpans.push([jsonStart, jsonStart + decoded.end]);
      logger.info({ name: data['name'] }, '[tool_calls] 独立 JSON 兜底提取');
    }
  }
}
