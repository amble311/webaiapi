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

/* ------------------------------------------------------------------ */
/* DeepSeek 原生 DSML 工具调用（2026-10-16 实测补）                    */
/* ------------------------------------------------------------------ */

/**
 * DeepSeek 的**原生**函数调用格式（它的特殊 token 用全角竖线 `｜` U+FF5C）：
 *
 * ```
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="list_dir">
 * <｜｜DSML｜｜ parameter name="target_directory" string="true">/home/amble/object/btc</｜｜DSML｜｜ parameter>
 * <｜｜DSML｜｜ parameter name="ignore_globs" string="true">（这里是忽略 glob 的 JSON 数组）</｜｜DSML｜｜ parameter>
 * </｜｜DSML｜｜ invoke>
 * </｜｜DSML｜｜ calls>
 * ```
 *
 * ⚠️ 为什么会遇到：我们注入的是自己的文本协议（`<tool_call>{…}</tool_call>`），
 * 但 deepseek 网页端模型在「要调工具了」时**有时会直接吐它自己训练里的原生格式** ——
 * 此时若不识别，整段 XML 会被当正文原样透传给客户端（用户看到一堆 `｜｜DSML｜｜`，
 * 2026-10-16 实测；那一轮 340 字符全是这个，一个工具调用都没解析出来）。
 *
 * 容错：竖线允许半角/全角、1~2 个，且允许竖线与 `DSML` 之间有空格。
 */
/** `<｜｜DSML｜｜`（竖线半角/全角、1~2 个、允许空格）。 */
const DSML_DELIM = '<[|｜]{1,2}\\s*DSML\\s*[|｜]{1,2}\\s*';
/**
 * 整块：`<…DSML｜｜ calls>` … `</…DSML｜｜ calls>`。
 *
 * ⚠️ 结束符**必须是带 calls 的那个**：实测模型会在中间写**无名闭合**
 * （`</｜｜DSML｜｜>` 关 invoke）—— 若这里允许 `calls` 缺失，块会在那里提前收尾，
 * 残留 `</…calls>` 留在正文里（2026-10-17 实测）。
 */
const DSML_CALLS_PATTERN = new RegExp(
  DSML_DELIM + 'calls\\s*>([\\s\\S]*?)</[|｜]{1,2}\\s*DSML\\s*[|｜]{1,2}\\s*calls\\s*>',
  'gu',
);
/**
 * 块内按分隔符切分：每段形如 `invoke name="x">` / `parameter name="y" …>值` /
 * `/parameter>` / `/invoke>`（闭合片段）。
 *
 * ⚠️ 必须允许 `<` 后面跟 `/`（闭合标签），否则闭合串会粘在**上一个参数值**的尾巴上
 * （实测 `timeout` 变成了 `180000</｜｜DSML｜｜ parameter>`）。
 */
/** 任意 DSML 标记（开/闭、任意标签名、允许属性）：用于**兜底剔标记**。 */
const DSML_TAG_TOKEN = /<\/?[|｜]{1,2}\s*DSML\s*[|｜]{1,2}[^>]*>/gu;

const DSML_PIECE_SPLIT = new RegExp('</?' + '[|｜]{1,2}\\s*DSML\\s*[|｜]{1,2}\\s*', 'gu');

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

/**
 * 解析 DSML 参数值：**数组/数字/布尔都认**。
 *
 * ⚠️ 不能直接用 `tryParseJson`：它是给 `<tool_call>{…}</tool_call>` 写的，**只面向对象**
 * （数组会返回 undefined 并打一行「JSON 解析失败」）——实测 `ignore_globs` 的
 * `["…", "…"]` 就是这样被退回成字符串的，客户端拿到字符串而 schema 要数组。
 */
function parseDsmlValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // 再试一次宽松解码（智能引号 / Python 风格的字面量）
    try {
      const decoded = rawDecodeJson(trimmed) as unknown;
      return decoded === undefined ? trimmed : decoded;
    } catch {
      return trimmed;
    }
  }
}

/**
 * 给 DSML 调用的参数赋值。
 *
 * `string="true"` 只是平台的类型标注，但模型**常把 JSON 数组/对象塞进字符串参数**
 * （实测 `ignore_globs`）→ 能解析成复合值时按复合值给客户端，否则保留字符串。
 */
function assignDsmlParam(args: Record<string, unknown>, param: RegExpExecArray): void {
  const key = (param[1] ?? '').trim();
  if (!key) return;
  const attrs = param[2] ?? '';
  const rawValue = (param[3] ?? '').trim();
  const wantsString = /string\s*=\s*"true"/i.test(attrs);
  const composite = /^[[{]/.test(rawValue);
  args[key] = wantsString && !composite ? rawValue : parseDsmlValue(rawValue);
}

/**
 * 从 DSML 块体里收集 invoke / parameter。
 *
 * 按分隔符切分，**不依赖闭合标签的名字**（实测模型会写无名闭合 `</｜｜DSML｜｜>`）。
 * 未闭合的块也用同一个函数（尽力解析）。
 */
function collectDsmlBody(body: string): {
  invocations: Array<{ name: string; args: Record<string, unknown> }>;
  /** 参数「值」在 body 里的区间（相对偏移）—— 未闭合块要把它们从正文里剥掉。 */
  valueSpans: Array<[number, number]>;
} {
  const invocations: Array<{ name: string; args: Record<string, unknown> }> = [];
  const valueSpans: Array<[number, number]> = [];
  let current: { name: string; args: Record<string, unknown> } | null = null;

  /* 用 matchAll 而不是 split：需要每段的**位置**（未闭合块只删参数值，保留正文）。 */
  const pieces: Array<{ text: string; start: number }> = [];
  let lastEnd = 0;
  for (const m of body.matchAll(DSML_PIECE_SPLIT)) {
    const at = m.index ?? 0;
    pieces.push({ text: body.slice(lastEnd, at), start: lastEnd });
    lastEnd = at + m[0].length;
  }
  pieces.push({ text: body.slice(lastEnd), start: lastEnd });

  for (const piece of pieces) {
    const raw = piece.text;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const invoke = /^invoke\s+name="([^"]+)"\s*>([\s\S]*)$/u.exec(trimmed);
    if (invoke) {
      const name = (invoke[1] ?? '').trim();
      if (!name) {
        current = null;
        continue;
      }
      current = { name, args: {} };
      invocations.push(current);
      const rest = (invoke[2] ?? '').trim();
      if (rest) {
        const inlineParam = /^parameter\s+name="([^"]+)"([^>]*)>([\s\S]*)$/u.exec(rest);
        if (inlineParam) assignDsmlParam(current.args, inlineParam);
      }
      continue;
    }

    const param = /^parameter\s+name="([^"]+)"([^>]*)>([\s\S]*)$/u.exec(trimmed);
    if (param && current) {
      assignDsmlParam(current.args, param);
      /* 值在 body 里的绝对区间：piece.start + 前导空白 + 「>」之后 + 值的前导空白 */
      const lead = raw.length - raw.trimStart().length;
      const value = param[3] ?? '';
      const valueLead = value.length - value.trimStart().length;
      const valueLen = value.trim().length;
      if (valueLen > 0) {
        const gt = trimmed.indexOf('>');
        const valueStart = piece.start + lead + gt + 1 + valueLead;
        valueSpans.push([valueStart, valueStart + valueLen]);
      }
    }
  }

  return { invocations, valueSpans };
}

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

  // --- Pattern 1.5：DeepSeek 原生 DSML（见 DSML_DELIM 的说明） ---
  for (const match of normalized.matchAll(DSML_CALLS_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;

    /* ⚠️⚠️ 解析方式：**按分隔符切分**，不依赖闭合标签的名字
     * （2026-10-17 实测事故：模型写的是 `</｜｜DSML｜｜>` —— **无名闭合**，
     *  而 parameter 的闭合却带名字。早期用「成对标签」正则 → invoke 体永远匹配不上
     *  → 整轮 **0 个工具调用** → 客户端收到纯文本就结束回合，用户看到「突然停止」。）
     *
     * 切分后每段形状：`calls>` / `invoke name="bash">` /
     * `parameter name="command" string="true">一段值` / 各种闭合片段（一律忽略）。
     * 值天然止于下一个分隔符，所以不需要再剥离标签。
     *
     * ⚠️ 顺序很重要：**先把 invoke/parameter 全部收集完，再统一 buildToolCall**
     * （在 invoke 那一刻构造会拿到空 args）。 */
    const body = match[1] ?? '';
    for (const inv of collectDsmlBody(body).invocations) {
      const tc = buildToolCall(inv.name, inv.args, maps);
      if (tc) toolCalls.push(tc);
    }

    // 整段 DSML 都要从可见正文里删掉：绝不把原始标记透给用户
    if (body.trim()) removalSpans.push([start, end]);
  }

  /* --- Pattern 1.6：**未闭合**的 DSML（模型被打断 / 只写了个开头） ---
   * 实测 2026-10-17（用户截图）：回复末尾只有一个孤零零的 `<｜｜DSML｜｜ calls>` ——
   * 没有闭合、没有 invoke → 上面的整块正则匹配不上 → 原始标记**原样透给用户** ✗。
   * 处理：① 从开标记起**尽力解析** invoke（能认出就认，别丢调用）；
   *       ② 标记本身一律剔掉（对用户永远没有意义）。
   * ⚠️ 兜底扫描那一遍是**最后一道保险**：正文里任何残留的 DSML 标记都不许出现。 */
  const unclosedOpen = new RegExp(DSML_DELIM + 'calls\\s*>', 'gu');
  for (const m of normalized.matchAll(unclosedOpen)) {
    const start = m.index ?? 0;
    if (spansOverlap(start, start + m[0].length, removalSpans)) continue;
    const parsed = collectDsmlBody(normalized.slice(start));
    for (const inv of parsed.invocations) {
      const tc = buildToolCall(inv.name, inv.args, maps);
      if (tc) toolCalls.push(tc);
    }
    /* 未闭合块：连**参数值**一起剥掉（否则 shell 命令之类的值会留在正文里）。 */
    for (const [vs, ve] of parsed.valueSpans) {
      const absStart = start + vs;
      const absEnd = start + ve;
      if (spansOverlap(absStart, absEnd, removalSpans)) continue;
      removalSpans.push([absStart, absEnd]);
    }
  }

  /* 兜底：剔掉所有残留的 DSML 标记（不重叠才加 —— 应用删除是从后往前 splice）。 */
  for (const tag of normalized.matchAll(DSML_TAG_TOKEN)) {
    const start = tag.index ?? 0;
    const end = start + tag[0].length;
    if (spansOverlap(start, end, removalSpans)) continue;
    removalSpans.push([start, end]);
  }

  // --- Pattern 2 ---  // --- Pattern 2 ---
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
