/**
 * JSON 修复与 DOM 损坏抢救 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * 这是整个工具协议层最「脏」也最值钱的一块：AI 输出的 JSON 经常坏，
 * 而 ChatGLM 把 `<tool_call>` 当 HTML 元素消费后会把里面 JSON 毁得更彻底。
 *
 * ⚠️ 移植注意：Python 的 `re` 与 JS 的 `RegExp` 有差异，本文件里凡是
 * 原先用 `\w` 的地方都改成了 {@link PY_W_CHARS}（Unicode 语义的字母/数字/下划线），
 * 并统一带 `u` 标志，否则中文内容会被错误切分。
 */
import { logger } from '../log/logger.js';
import { cleanDomHtml } from './clean.js';

// 注意：本文件的正则全部带 `u` 标志（`\p{...}` 需要），并且凡是 Python 用 `\w` 的地方
// 都改用 PY_W_CHARS —— JS 的 `\w` 只有 ASCII，会导致中文内容被错误切分。

/**
 * Python `re` 的 `\w` 等价「内容」（Unicode 字母 / 数字 / 下划线）；JS 的 `\w` 只有 ASCII。
 *
 * ⚠️ 这是**类内容**不是类本身 —— 要嵌进别的字符类时用它：
 * `` `[/${PY_W_CHARS}.\\-]+` ``。单独使用时用 {@link PY_W}。
 */
export const PY_W_CHARS = String.raw`\p{L}\p{N}_`;

/** 等价于 Python `\w` 的完整字符类，可直接放进正则。 */
export const PY_W = `[${PY_W_CHARS}]`;

/** 合法的 JSON 字符串转义字符（反斜杠后只能跟这些）。 */
const VALID_JSON_ESCAPES = new Set(['"', '\\', 'b', 'f', 'n', 'r', 't', 'u', '/']);

/**
 * DOM 损坏指示器：key 前后出现转义引号、值前出现「预览」前缀。
 * 这些模式在正常 JSON 里不会出现，可作为可靠信号。
 */
export const DOM_CORRUPTION_INDICATOR = new RegExp(
  // ⚠️ 一律写成 `[${PY_W_CHARS}]+`：直接写 `${PY_W_CHARS}+` 时量词只作用于最后一个原子（`_`）
  String.raw`\{\s*"\\+"|` + // {"\" —— 转义引号紧跟 {
    String.raw`\\+"[${PY_W_CHARS}]+\\+"|` + // \"name\" —— key 被转义引号包围
    String.raw`\b[${PY_W_CHARS}]+\\+"[${PY_W_CHARS}]+"`, // Re\"Read —— 值前出现预览前缀
  'u',
);

/**
 * DOM 预览损坏指示器（无反斜杠版）：`"pat"path":`、`"nam"name":`。
 * 正常 JSON 的 key 只有一对引号，出现两对即损坏。
 */
export const DOM_PREVIEW_KEY_INDICATOR = /"[A-Za-z_]{1,20}"[A-Za-z_]{1,20}"\s*:/;

/** 破碎标签迹象 —— 用于决定是否启用 Pattern 6/7 兜底。 */
export const BROKEN_TAG_INDICATOR = /t?ool_call|<\/?t+ool_call/i;

/** 智能引号集合（DOM 渲染产物）。 */
const SMART_QUOTES = '\u201c\u201d\u2018\u2019';

/** 判断文本是否含智能引号。 */
export function hasSmartQuotes(text: string): boolean {
  return [...SMART_QUOTES].some((ch) => text.includes(ch));
}

/**
 * 尝试把字符串解析为 JSON（宽容处理代码围栏、非法转义、尾部逗号）。
 *
 * 解析失败时的兜底顺序与原实现一致：
 * 1. 去掉代码围栏后直接 parse
 * 2. 修复非法转义后 parse
 * 3. 若含 DOM 损坏特征 → 返回 undefined（交给 Pattern 7 抢救，不要用正则兜底）
 * 4. 否则用正则提取参数（SearchReplace 缺字段时视为损坏，也返回 undefined）
 */
export function tryParseJson(raw: string): Record<string, unknown> | undefined {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .split('\n')
      .filter((line) => !line.trim().startsWith('```'))
      .join('\n')
      .trim();
  }

  const direct = safeJsonParse(cleaned);
  if (direct) return direct;

  const repaired = safeJsonParse(repairJson(cleaned));
  if (repaired) return repaired;

  logger.warn(
    { head: cleaned.slice(0, 300) },
    '[tool_calls] JSON 解析失败',
  );

  // 有 DOM 损坏特征时不要用正则兜底（会提取到错误的短预览值）
  if (
    DOM_PREVIEW_KEY_INDICATOR.test(cleaned) ||
    DOM_CORRUPTION_INDICATOR.test(cleaned) ||
    hasSmartQuotes(cleaned)
  ) {
    logger.info('[tool_calls] 检测到 DOM 损坏特征，跳过正则兜底，等待 Pattern 7 修复');
    return undefined;
  }

  const extracted = extractToolCallByRegex(cleaned);
  if (extracted) {
    // SearchReplace 缺 old_str/new_str 说明值被 DOM 损坏了 → 交给 Pattern 7
    if (extracted['name'] === 'SearchReplace') {
      const args = (extracted['arguments'] ?? {}) as Record<string, unknown>;
      if (!args['old_str'] || !args['new_str']) {
        logger.info(
          '[tool_calls] 正则兜底提取的 SearchReplace 不完整（缺少 old_str 或 new_str），跳过，等待 Pattern 7 修复',
        );
        return undefined;
      }
    }
    logger.info({ name: extracted['name'] }, '[tool_calls] 正则兜底提取成功');
    return extracted;
  }

  return undefined;
}

function safeJsonParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 修复 AI 输出的常见 JSON 问题（等价于 `_repair_json`）。
 *
 * - 字符串值内的真实换行 → `\n` / `\r` / `\t`
 * - **非法转义序列**（如 `\d` `\w` `\s` 等正则字符）→ 双反斜杠转义
 * - 尾部逗号 → 删除
 * - 被截断在 `\` 处 → 补一个反斜杠
 */
export function repairJson(text: string): string {
  const result: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (escapeNext) {
      result.push('\\');
      if (!VALID_JSON_ESCAPES.has(ch.toLowerCase())) {
        // 非法转义 → 再加一个反斜杠来转义反斜杠本身
        result.push('\\');
      }
      result.push(ch);
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result.push(ch);
      continue;
    }

    if (inString) {
      if (ch === '\n') result.push('\\n');
      else if (ch === '\r') result.push('\\r');
      else if (ch === '\t') result.push('\\t');
      else result.push(ch);
    } else {
      result.push(ch);
    }
  }

  let repaired = result.join('');
  if (escapeNext) repaired += '\\';

  // 尾部逗号
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  return repaired;
}

/**
 * JSON 解析完全失败时的最后兜底：用正则从损坏文本里抠出参数。
 *
 * 提取到的值若含智能引号（DOM 损坏标志）则返回 undefined，
 * 交给 `repairDomCorruptedJson` 做完整修复。
 */
export function extractToolCallByRegex(
  text: string,
): Record<string, unknown> | undefined {
  const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(text);
  if (!nameMatch) return undefined;
  let name = nameMatch[1] as string;

  // 工具名损坏（含智能引号 / 冒号+key）时尝试抠出真实名
  if (hasSmartQuotes(name) || name.includes(': ')) {
    const realName = /:\s*[\u201c"]([A-Za-z_][A-Za-z0-9_]*)[\u201d"]/.exec(name);
    if (realName) {
      name = realName[1] as string;
    } else {
      return undefined;
    }
  }

  /** 提取字段值，处理转义引号与未转义的真实换行。 */
  const extractField = (fieldNames: ReadonlyArray<string>): string | undefined => {
    for (const fname of fieldNames) {
      const pattern = new RegExp(
        `"${escapeRegExp(fname)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
        'su',
      );
      const m = pattern.exec(text);
      if (m) {
        const rawVal = m[1] as string;
        return rawVal
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\//g, '/')
          .replace(/\\\\/g, '\\');
      }
    }
    return undefined;
  };

  const args: Record<string, unknown> = {};

  const filePath = extractField(['file_path', 'path', 'filepath']);
  if (filePath) args['file_path'] = filePath;

  const lowerName = name.toLowerCase();
  if (['searchreplace', 'str_replace', 'edit_file'].includes(lowerName)) {
    const oldStr = extractField(['old_str', 'old_string', 'old']);
    const newStr = extractField(['new_str', 'new_string', 'new']);
    if (oldStr) args['old_str'] = oldStr;
    if (newStr) args['new_str'] = newStr;
  } else if (['write_file', 'create_file', 'writefile'].includes(lowerName)) {
    const content = extractField(['content', 'code', 'text']);
    if (content) args['content'] = content;
  }

  if (Object.keys(args).length === 0) return undefined;

  // 值含智能引号 → 视为损坏，交给 Pattern 7
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && hasSmartQuotes(v)) {
      logger.info('[tool_calls] 正则提取的值包含智能引号（DOM 损坏），返回 undefined 让 Pattern 7 处理');
      return undefined;
    }
  }

  return { name, arguments: args };
}

/** 转义正则字面量（等价于 Python `re.escape`，覆盖所有元字符）。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 提取复杂多行字段时用作值边界的已知 key 列表。 */
const KNOWN_KEYS_FOR_BOUNDARY: ReadonlyArray<string> = [
  'name', 'arguments',
  'path', 'file_path', 'filePath', 'filepath',
  'old_str', 'new_str', 'old_string', 'new_string',
  'oldText', 'newText', 'old_text', 'new_text',
  'search', 'replace', 'find', 'replacement',
  'content', 'command', 'pattern', 'query', 'url',
  'description', 'explanation', 'information_request',
  'output_mode', 'glob', 'type', 'multiline',
  'offset', 'limit', '-n', '-i', '-C', '-B', '-A',
  'head_limit',
  'cwd', 'target_terminal', 'command_type',
  'blocking', 'requires_approval',
  'questions', 'options', 'header',
  'merge', 'summary', 'todos',
  'preview_url', 'command_id',
  'objective', 'token_budget', 'status',
  'server_name', 'tool_name', 'args',
  'target_directories', 'ignore',
  'skill', 'subagent_type', 'response_language',
];

/**
 * 从 DOM 损坏的 JSON 中提取复杂多行字段值（等价于 `_extract_complex_field_from_corrupted`）。
 *
 * 三种损坏模式：
 * - A：key 重复（预览值 + 完整值）
 * - B：值提前闭合（值里的引号未转义）→ 靠「下一个已知 key」定位边界
 * - C：无损坏，普通 `"field": "value"`
 */
export function extractComplexFieldFromCorrupted(
  text: string,
  field: string,
): string | undefined {
  const normalized = text.replace(/\u201c/g, '"').replace(/\u201d/g, '"');
  const esc = escapeRegExp(field);

  // 模式 A: "field": "preview"field": "full_value"
  const patternA = new RegExp(
    `"${esc}"\\s*:\\s*".*?"${esc}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    'su',
  );
  const ma = patternA.exec(normalized);
  if (ma) return cleanDomHtml(ma[1] as string);

  // 模式 B: 值提前闭合 → 提取到「下一个已知 key」或闭合大括号之前
  const startMatch = new RegExp(`"${esc}"\\s*:\\s*"`, 'u').exec(normalized);
  if (startMatch) {
    const rest = normalized.slice(startMatch.index + startMatch[0].length);

    let nextKeyPos = rest.length;
    for (const key of KNOWN_KEYS_FOR_BOUNDARY) {
      if (key === field) continue;
      const bm = new RegExp(`",\\s*"${escapeRegExp(key)}"\\s*:`, 'u').exec(rest);
      if (bm && bm.index < nextKeyPos) nextKeyPos = bm.index;
    }
    const closeBrace = /"\s*\}/u.exec(rest);
    if (closeBrace && closeBrace.index < nextKeyPos) nextKeyPos = closeBrace.index;

    const value = rest.slice(0, nextKeyPos);
    if (value) return cleanDomHtml(value);
  }

  // 模式 C: 无损坏
  const patternC = new RegExp(`"${esc}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'su');
  const mc = patternC.exec(normalized);
  if (mc) return cleanDomHtml(mc[1] as string);

  return undefined;
}

/**
 * 从 DOM 损坏的 JSON 中提取文件路径值（等价于 `_extract_path_from_corrupted`）。
 *
 * 路径值会出现多个「预览前缀」，**最长的那一个**才是完整路径。
 */
export function extractPathFromCorrupted(text: string): string | undefined {
  const paths: string[] = [
    ...text.matchAll(/\/[A-Za-z0-9/._\-~]+/g),
  ].map((m) => m[0]);
  paths.push(...[...text.matchAll(/[A-Za-z]:[/\\][A-Za-z0-9/._\-~\\]+/g)].map((m) => m[0]));

  if (paths.length === 0) return undefined;

  const unique = [...new Set(paths)];
  return unique.reduce((longest, p) => (p.length > longest.length ? p : longest), '');
}

/** DOM 损坏修复时识别的已知工具名。 */
const KNOWN_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'SearchReplace', 'Grep', 'Glob',
  'RunCommand', 'TodoWrite', 'WebSearch', 'WebFetch',
  'List', 'DeleteFile', 'Bash', 'LS',
  'write_file', 'edit_file',
  'EditFile', 'WriteFile', 'create_file',
  'Task', 'Skill', 'SearchCodebase',
  'CheckCommandStatus', 'StopCommand', 'GetDiagnostics',
  'AskUserQuestion', 'NotifyUser', 'OpenPreview',
  'get_goal', 'create_goal', 'update_goal', 'run_mcp',
]);

/** DOM 损坏修复时识别的已知参数 key。 */
const KNOWN_ARG_KEYS = new Set([
  'path', 'file_path', 'filePath', 'command', 'old_str', 'new_str',
  'old_string', 'new_string', 'content', 'url', 'query', 'pattern',
  'file_paths', 'todos', 'description', 'name', 'arguments',
  'oldText', 'newText', 'old_text', 'new_text',
  'search', 'replace', 'find', 'replacement',
  'start_line', 'end_line', 'output_mode',
  'explanation', 'questions', 'preview_url', 'command_id',
  'objective', 'status', 'token_budget',
  'server_name', 'tool_name', 'args',
  'subagent_type', 'response_language',
  'information_request', 'target_directories',
  'ignore', 'offset', 'limit', 'merge', 'summary',
  'glob', 'type', 'head_limit', 'multiline',
  'cwd', 'target_terminal', 'command_type', 'blocking',
  'wait_ms_before_async', 'requires_approval',
  'output_character_count', 'skip_character_count',
  'output_priority', 'filter', 'num', 'lr',
  '-B', '-A', '-C', '-n', '-i',
]);

const PATH_FIELDS = ['path', 'file_path', 'filePath'] as const;

const OLD_STR_KEYS = ['old_str', 'old_string', 'oldText', 'old_text', 'search', 'find'];
const NEW_STR_KEYS = ['new_str', 'new_string', 'newText', 'new_text', 'replace', 'replacement'];

/** 需要从原始损坏文本里重新提取完整值（而非用 token 短前缀）的字段。 */
const COMPLEX_FIELDS = [
  'old_str', 'new_str', 'old_string', 'new_string', 'content', 'command',
  'oldText', 'newText', 'old_text', 'new_text',
  'search', 'replace', 'find', 'replacement',
  'explanation', 'description', 'query', 'information_request',
];

const SIMPLE_FIELDS = ['path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description'];

/** 别名 → 标准字段名。 */
function canonicalField(field: string): string {
  if (['old_string', 'oldText', 'old_text', 'search', 'find'].includes(field)) return 'old_str';
  if (['new_string', 'newText', 'new_text', 'replace', 'replacement'].includes(field)) {
    return 'new_str';
  }
  return field;
}

/** 手动反转义（`JSON.parse` 失败时的兜底）。 */
function manualUnescape(value: string): string {
  return value
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\t/g, '\t')
    .replace(/\\\\"/g, '"')
    .replace(/\\\\\//g, '/')
    .replace(/\\\\\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

/**
 * 修复被 DOM 渲染破坏的 tool_call JSON（等价于 `_repair_dom_corrupted_json`）。
 *
 * 策略：**不逐字符修复**（`\"` → `"` 会产生 `""` 破坏引号配对），
 * 而是从损坏文本里按 token 提取已知 key/value，再重建 JSON。
 *
 * 修复顺序（每一步都有踩坑原因）：
 * 1. 先归一化智能引号
 * 2. **再清理 HTML 标签** —— 必须在引号归一化/取 token 之前，
 *    否则 span 的属性引号会打乱后续处理（曾导致 Pattern 7 修复失败、长度不变）
 * 3. token 提取 → 找工具名 / 参数对
 * 4. 路径字段用「最长 `/-前缀字符串`」修正（token 只能拿到 `/ho` 这种短前缀）
 * 5. 工具名缺失时按参数推断
 * 6. 复杂字段用正则重新提取完整值，并移除 token 阶段的短垃圾值
 */
export function repairDomCorruptedJson(text: string): string {
  if (!text || !text.includes('{')) return text;

  let working = text.replace(/\u201c/g, '"').replace(/\u201d/g, '"');
  working = working.replace(/\u2018/g, "'").replace(/\u2019/g, "'");
  working = cleanDomHtml(working);

  const start = working.indexOf('{');
  const end = working.lastIndexOf('}');
  if (start < 0 || end <= start) return text;
  const segment = working.slice(start, end + 1);

  // 把所有引号（含转义）换成空格，便于按 token 切分
  const cleaned = segment.replace(/\\"|"/g, ' ');
  const tokens = [
    ...cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*|\/[A-Za-z0-9/._\-]*/g),
  ].map((m) => m[0]);
  if (tokens.length === 0) return text;

  let nameValue: string | undefined;
  for (const tok of tokens) {
    if (KNOWN_TOOL_NAMES.has(tok)) {
      nameValue = tok;
      break;
    }
  }

  const args: Record<string, string> = {};
  let j = 0;
  while (j < tokens.length) {
    const tok = tokens[j] as string;
    if (
      KNOWN_ARG_KEYS.has(tok) &&
      tok !== 'name' &&
      tok !== 'arguments' &&
      j + 1 < tokens.length
    ) {
      const val = tokens[j + 1] as string;
      if (!KNOWN_ARG_KEYS.has(val) && !KNOWN_TOOL_NAMES.has(val)) {
        args[tok] = val;
        j += 2;
        continue;
      }
    }
    j += 1;
  }

  // 路径字段：用最长的 /-前缀字符串覆盖 token 短前缀
  const pathValue = extractPathFromCorrupted(segment);
  if (pathValue) {
    const existingKey = PATH_FIELDS.find((k) => k in args);
    args[existingKey ?? 'file_path'] = pathValue;
  }

  // 工具名推断
  if (!nameValue) {
    const hasOld = OLD_STR_KEYS.some((k) => k in args);
    const hasNew = NEW_STR_KEYS.some((k) => k in args);
    const hasPath = PATH_FIELDS.some((k) => k in args);

    if (hasOld && hasNew) nameValue = 'SearchReplace';
    else if ('content' in args && hasPath) nameValue = 'write_file';
    else if ('command' in args) nameValue = 'RunCommand';
    else if (hasPath) nameValue = 'Read';
    else return text; // 无法推断 → 放弃修复
  }

  const extracted = new Set<string>();

  // 复杂多行字段：正则重取，覆盖 token 的短垃圾值
  for (const field of COMPLEX_FIELDS) {
    const norm = canonicalField(field);
    if (extracted.has(norm)) continue;

    const value = extractComplexFieldFromCorrupted(segment, field);
    if (value) {
      let unescaped = value;
      try {
        const undoubled = value.replace(/\\\\/g, '\\');
        unescaped = JSON.parse(`"${undoubled}"`) as string;
      } catch {
        unescaped = manualUnescape(value);
      }
      args[norm] = unescaped;
      extracted.add(norm);
    } else if (norm in args && (args[norm] as string).length < 50) {
      delete args[norm];
    }
  }

  // 简单字段：同样用正则重取（token 处理不了 "." 或 "**/*.html" 这类值）
  for (const field of SIMPLE_FIELDS) {
    if (extracted.has(field)) continue;

    const existing = args[field] ?? '';
    if (
      existing.length > 1 &&
      (existing.startsWith('/') || /^[A-Za-z]:[/\\]/.test(existing))
    ) {
      continue; // 已由路径提取正确设置
    }

    const value = extractComplexFieldFromCorrupted(segment, field);
    if (value) {
      args[field] = value;
      extracted.add(field);
    } else if (field in args && existing.length < 50) {
      delete args[field];
    }
  }

  // 清理所有值里的 DOM HTML
  for (const [key, val] of Object.entries(args)) {
    const cleanedVal = cleanDomHtml(val);
    if (cleanedVal !== val) args[key] = cleanedVal;
  }

  const repairedJson = JSON.stringify({ name: nameValue, arguments: args });
  return working.slice(0, start) + repairedJson + working.slice(end + 1);
}
