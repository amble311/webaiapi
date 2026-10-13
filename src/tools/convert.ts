/**
 * 文本 → 工具调用转换 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * 两条互补的路径：
 * - {@link convertTextToToolCalls}：从文本里抠「带路径的代码块」，转成写文件调用
 * - {@link directConvertToToolCalls}：**零损失**地整段包成一次写文件调用
 *   （不依赖第二轮 AI，避免内容被改写或丢失）
 *
 * ⚠️ `docs/hard-constraints.md` 的提醒：这两个函数**没提取到工具调用时会把输入原样返回**，
 * 所以调用方只有「确实提取到了」才允许采纳其文本，否则不要把已解析的正文覆盖掉。
 */
import type { ToolCallPayload, ToolDefinition } from '../types/message.js';
import { toolNameOf, toolParamNames } from '../types/message.js';
import { detectToolNames, makeToolCallId, normalizeParamKey } from './names.js';
import { PY_W_CHARS } from './repair.js';

/** 常见源代码扩展名。 */
const CODE_EXTENSIONS: ReadonlyArray<string> = [
  '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.go', '.rs', '.c', '.cpp',
  '.h', '.rb', '.php', '.sh', '.bash', '.zsh', '.sql', '.html', '.css',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt', '.ini', '.cfg',
  '.env', '.gitignore', '.dockerfile', '.makefile',
];

/** 带文件路径的代码块：```lang path/to/file */
const CODE_BLOCK_WITH_PATH = /```(\w+)?[:\s]+([^\n]+?)\n(.*?)```/gsu;

/** 「文件: path」后跟代码块。 */
const FILE_REF_PATTERN =
  /(?:文件[:：]\s*|创建文件[:：]\s*|新建文件[:：]\s*|\/\/\s*|File:\s*)([^\n]+\.\w+)\s*\n```(\w+)?\s*\n(.*?)```/gsu;

/**
 * 判断字符串是否像文件路径。
 *
 * 注意：只用来**排除明显不是路径**的代码块首行，宁可放宽也不要漏判。
 */
export function looksLikeFilepath(s: string, _lang = ''): boolean {
  if (!s || s.length > 200) return false;
  const trimmed = s.trim();

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return false;
    return true;
  }

  const lower = trimmed.toLowerCase();
  if (CODE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;

  // 点开头但不是相对路径引用（如 .bashrc）
  if (trimmed.startsWith('.') && !trimmed.startsWith('..') && trimmed.length < 50) return true;

  return false;
}

/**
 * 路径类参数的归一化名集合。
 * ⚠️ 用归一化名（去除非字母、转小写）比较，而不是直接比对字面量 ——
 * Python 版写的是 `p in ("file_path","path","filepath","filename")`，
 * **匹配不到驼峰的 `filePath`**（CodeBuddy 正是这种命名），
 * 于是回退成 `file_path` 并原样发给客户端 → 客户端报「未知参数」。
 */
const PATH_PARAM_KEYS = new Set(['filepath', 'path', 'filename']);

/** 内容类参数的归一化名集合。 */
const CONTENT_PARAM_KEYS = new Set(['content', 'code', 'text', 'body']);

/** 按工具声明的参数名构建写文件参数（兼容 `file_path`/`filePath`、`content`/`code`）。 */
export function buildWriteArgs(
  paramNames: ReadonlyArray<string>,
  filepath: string,
  content: string,
): Record<string, string> {
  const args: Record<string, string> = {};

  let pathSet = false;
  for (const p of paramNames) {
    if (PATH_PARAM_KEYS.has(normalizeParamKey(p))) {
      args[p] = filepath;
      pathSet = true;
      break;
    }
  }
  if (!pathSet) args['file_path'] = filepath;

  let contentSet = false;
  for (const p of paramNames) {
    if (CONTENT_PARAM_KEYS.has(normalizeParamKey(p))) {
      args[p] = content;
      contentSet = true;
      break;
    }
  }
  if (!contentSet) args['content'] = content;

  return args;
}

/** 从用户请求和内容推断文件名。 */
export function inferFilename(userRequest: string, content: string): string {
  const nameMatch = /(?:创建|新建|生成|write|create)\s+[：:]?\s*([^\s，,]+?\.\w+)/u.exec(userRequest);
  if (nameMatch) return nameMatch[1] as string;

  if (content.trim().startsWith('#')) {
    const titleMatch = /^#+\s+(.+)/mu.exec(content);
    if (titleMatch) {
      const title = (titleMatch[1] as string).trim();
      const clean = title.replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '_');
      return `${clean}.md`;
    }
    return 'README.md';
  }

  const firstLine = content.trim().split('\n')[0] ?? '';
  const lowerFirst = firstLine.toLowerCase();
  if (lowerFirst.includes('python') || firstLine.startsWith('import ') || firstLine.startsWith('from ')) {
    return 'main.py';
  }
  if (
    lowerFirst.includes('javascript') ||
    firstLine.startsWith('const ') ||
    firstLine.startsWith('function ')
  ) {
    return 'index.js';
  }
  if (firstLine.startsWith('<?xml') || firstLine.startsWith('<')) return 'config.xml';
  if (firstLine.includes('{') && (firstLine.includes('"') || firstLine.includes("'"))) {
    return 'config.json';
  }

  return 'README.md';
}

/** 计划性语言（出现即判定为「描述」而非「文件内容」）。 */
const PLANNING_PATTERNS: ReadonlyArray<RegExp> = [
  /我先/u, /让我先/u, /首先让我/u, /接下来我会/u,
  /我将先/u, /我先读取/u, /我先查看/u, /让我读取/u,
  /I'll (?:first |then )?read/i, /Let me (?:first |then )?read/i,
  /让我先检查/u, /首先读取/u,
];

/**
 * 判断 AI 回复是否像**文件内容**（而不是描述性/计划性文字）。
 *
 * 满足任一即触发：markdown 标题开头且够长、含带路径的代码块、
 * 3+ 个代码块、代码行占比 > 40%、看起来是完整 HTML。
 */
export function looksLikeFileContent(text: string): boolean {
  if (text.length < 300) return false;

  const head = text.slice(0, 500);
  if (PLANNING_PATTERNS.some((p) => p.test(head))) return false;

  if (text.trim().startsWith('#') && text.length > 500) return true;

  const stripped = text.trim();
  if (
    (stripped.startsWith('<!DOCTYPE') || stripped.startsWith('<html')) &&
    text.length > 500
  ) {
    return true;
  }
  if (stripped.startsWith('html\n') && stripped.slice(0, 200).includes('<!DOCTYPE')) return true;

  if (/```(\w+)[:\s]+([^\n]+?)\n/u.test(text)) return true;

  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount >= 6) return true; // 3 个代码块 = 6 个围栏

  const lines = text.split('\n');
  if (lines.length > 20) {
    const codeLike = lines.filter(
      (l) =>
        l.trim() !== '' &&
        !/^\s*[^\x00-\x7F]/u.test(l) &&
        /^\s*(\/\/|#|<|>|from |import |def |class |const |let |var |if |for |while |return )/u.test(
          l,
        ),
    ).length;
    if (codeLike / lines.length > 0.4) return true;
  }

  return false;
}

/**
 * 找出客户端**真实的**写文件工具名与它的参数名列表。
 *
 * ⚠️ 与原设计不同处：Python 版直接 `tool_names.get("write_file") or "write_file"`，
 *    **硬编码了 `write_file`**。当客户端用的是 `write_to_file`（CodeBuddy）时，
 *    产出的调用指向一个客户端不存在的工具 —— 正是「转换成功但 IDE 不执行」的成因。
 *    这里改为优先用参数特征探测（`detectToolNames`），再退回名字匹配。
 */
function resolveWriteTool(tools: ReadonlyArray<ToolDefinition>): {
  name: string;
  params: string[];
} {
  const detected = detectToolNames(tools);
  const candidate = detected['write'] ?? detected['edit'];
  if (candidate) {
    const tool = tools.find((t) => toolNameOf(t) === candidate);
    return { name: candidate, params: tool ? toolParamNames(tool) : [] };
  }

  for (const key of ['write_file', 'edit_file']) {
    const tool = tools.find((t) => toolNameOf(t).toLowerCase() === key);
    if (tool) return { name: toolNameOf(tool), params: toolParamNames(tool) };
  }

  return { name: 'write_file', params: [] };
}

/**
 * 从纯文本回复里提取「带路径的代码块」并转成写文件调用。
 *
 * 没提取到时返回 `(原文本, [])` —— 调用方务必检查是否真的提取到了。
 */
export function convertTextToToolCalls(
  text: string,
  tools: ReadonlyArray<ToolDefinition>,
): { text: string; toolCalls: ToolCallPayload[] } {
  type Pair = { path: string; code: string; start: number; end: number };
  const pairs: Pair[] = [];

  for (const match of text.matchAll(CODE_BLOCK_WITH_PATH)) {
    const lang = match[1] ?? '';
    const filepath = (match[2] ?? '').trim();
    const code = match[3] ?? '';
    if (looksLikeFilepath(filepath, lang)) {
      pairs.push({ path: filepath, code, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }

  for (const match of text.matchAll(FILE_REF_PATTERN)) {
    pairs.push({
      path: (match[1] ?? '').trim(),
      code: match[3] ?? '',
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  // 按起点去重（同一块可能被两个正则同时命中）
  const seen = new Set<number>();
  const unique: Pair[] = [];
  for (const pair of pairs) {
    if (seen.has(pair.start)) continue;
    seen.add(pair.start);
    unique.push(pair);
  }

  const writeTool = resolveWriteTool(tools);

  const toolCalls: ToolCallPayload[] = unique.map((pair) => ({
    id: makeToolCallId(),
    type: 'function' as const,
    function: {
      name: writeTool.name,
      arguments: JSON.stringify(buildWriteArgs(writeTool.params, pair.path, pair.code)),
    },
  }));

  if (toolCalls.length === 0) return { text, toolCalls: [] };

  // 移除已提取的代码块，保留其余文本
  const remainingParts: string[] = [];
  let lastEnd = 0;
  for (const pair of [...unique].sort((a, b) => a.start - b.start)) {
    if (pair.start > lastEnd) remainingParts.push(text.slice(lastEnd, pair.start).trim());
    lastEnd = pair.end;
  }
  if (lastEnd < text.length) remainingParts.push(text.slice(lastEnd).trim());

  return { text: remainingParts.filter(Boolean).join('\n'), toolCalls };
}

/**
 * 把第一轮回复**整段**包成一次写文件调用（零损失）。
 *
 * 仅在回复看起来像文件内容时才触发；描述性文字不触发。
 */
export function directConvertToToolCalls(
  firstResponse: string,
  tools: ReadonlyArray<ToolDefinition>,
  userRequest = '',
): { text: string; toolCalls: ToolCallPayload[] } {
  if (!looksLikeFileContent(firstResponse)) {
    return { text: firstResponse, toolCalls: [] };
  }

  // 客户端真实的写文件工具 + 它的真实参数名（可能是 filePath/file_path、content/code）
  const { name: writeTool, params: writeParams } = resolveWriteTool(tools);

  // 策略1：提取带路径的代码块
  const pairs: Array<{ path: string; code: string }> = [];
  for (const match of firstResponse.matchAll(CODE_BLOCK_WITH_PATH)) {
    const lang = match[1] ?? '';
    const filepath = (match[2] ?? '').trim();
    const code = match[3] ?? '';
    if (looksLikeFilepath(filepath, lang)) pairs.push({ path: filepath, code });
  }

  if (pairs.length > 0) {
    const toolCalls: ToolCallPayload[] = pairs.map((pair) => ({
      id: makeToolCallId(),
      type: 'function' as const,
      function: {
        name: writeTool,
        arguments: JSON.stringify(buildWriteArgs(writeParams, pair.path, pair.code)),
      },
    }));
    return { text: '', toolCalls };
  }

  // 策略2：整个回复作为一个文件
  const filename = inferFilename(userRequest, firstResponse);
  return {
    text: '',
    toolCalls: [
      {
        id: makeToolCallId(),
        type: 'function',
        function: {
          name: writeTool,
          arguments: JSON.stringify(buildWriteArgs(writeParams, filename, firstResponse)),
        },
      },
    ],
  };
}

/** 从文本中抽取出现过的疑似文件路径（供 reparse 提示词使用）。 */
export function collectFilePathsInText(
  text: string,
  limit = Number.POSITIVE_INFINITY,
): Set<string> {
  const out = new Set<string>();
  // 注意用 PY_W_CHARS 而非 \w：中文文件名（如 文档.md）也要能匹配
  const pattern = new RegExp(
    String.raw`[/~][${PY_W_CHARS}./-]+\.[${PY_W_CHARS}]{1,10}`,
    'gu',
  );
  for (const m of text.matchAll(pattern)) {
    const p = m[0];
    // ⚠️ 与原设计不同处：还要排除 `//host/path`。
    //    正则从 URL 的第一个 `/` 开始匹配，得到的是 `//x.com/a.ts`，
    //    而它不以 "http" 开头，Python 版的 `startswith('http')` 拦不住它。
    if (p.startsWith('//')) continue;
    if (!p.startsWith('http') && p.length < 200) out.add(p);
    if (out.size >= limit) break;
  }
  return out;
}
