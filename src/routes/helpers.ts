/**
 * 路由层公共工具 —— `legacy-python/src/api/routes.py` 第 78~497 行的移植。
 *
 * 这里放的都是**纯函数与常量**，不依赖 Fastify / Provider，便于单测。
 * 预算相关的常量集中在这里，因为它们互相之间有约束关系（见各条注释）。
 */
import { createHash } from 'node:crypto';

import { logger } from '../log/logger.js';
import { getTextContent, messageToDict, type ChatMessage } from '../types/message.js';

/* ==================================================================== */
/* token 估算 / usage / 错误体                                          */
/* ==================================================================== */

/**
 * 估算文本的 token 数。
 *
 * 启发式（与原实现一致）：中文约 0.5 token/字，英文约 0.25 token/词。
 * 仅用于 OpenAI 兼容响应的 `usage` 字段，不参与任何决策。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const englishCount = (text.match(/[a-zA-Z]+/g) ?? []).length;
  const other = text.length - chineseCount - englishCount;
  return Math.trunc(chineseCount * 0.5 + englishCount * 0.25 + other * 0.3);
}

/** 构建 OpenAI 兼容的 usage 对象。 */
export function buildUsage(promptText: string, completionText: string): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/** 构建 OpenAI 兼容的错误响应体。 */
export function openaiErrorResponse(
  message: string,
  errorType = 'invalid_request_error',
  code?: string | null,
): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { message, type: errorType };
  if (code != null) error['code'] = code;
  return { error };
}

/* ==================================================================== */
/* 上下文 / 用户提问提取                                                */
/* ==================================================================== */

/**
 * 把历史消息格式化为上下文字符串（跨平台切换时注入，保持对话连续性）。
 */
export function formatHistoryContext(history: Array<Record<string, unknown>>): string {
  const lines = ['[以下是之前的对话历史，请基于此上下文回答最新问题]'];
  for (const msg of history) {
    const role = msg['role'] === 'user' ? 'User' : 'Assistant';
    const content = msg['content'];
    if (content) lines.push(`${role}: ${String(content)}`);
  }
  return lines.join('\n');
}

/**
 * 从消息列表里提取用户**真正的问题**。
 *
 * ⚠️ 多轮工具调用场景下，`messages` 的最后一条往往是 tool 结果或
 * `<system-reminder>`，**不能直接取 `messages[-1]`**。
 *
 * 优先级：
 * 1. 最后一条含 `<user_query>...</user_query>` 的用户消息里的 query 内容；
 * 2. 最后一条 role=user 且不以 `<system-reminder>` 开头的消息（完整内容）；
 * 3. 兜底：最后一条 role=user 的消息。
 */
export function extractUserQuestion(messages: ReadonlyArray<ChatMessage | MessageDictLike>): string {
  if (messages.length === 0) return '';

  const userMessages: string[] = [];
  for (const m of messages) {
    const md = messageToDict(m as ChatMessage);
    if (md.role !== 'user') continue;
    let text = md.content;
    if (Array.isArray(text)) {
      text = text
        .filter((p) => p && typeof p === 'object' && (p as Record<string, unknown>)['type'] === 'text')
        .map((p) => String((p as Record<string, unknown>)['text'] ?? ''))
        .join('\n');
    }
    userMessages.push(typeof text === 'string' ? text : getTextContent(text));
  }

  if (userMessages.length === 0) return '';

  // 1) 优先取带 <user_query> 的（从后往前）
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const text = userMessages[i] as string;
    // ⚠️ Python 用 re.DOTALL（`.` 匹配换行），TS 对应 `s` 标志
    const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
    if (m?.[1] !== undefined) return m[1].trim();
  }

  // 2) 最后一条非 system-reminder 的用户消息
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const stripped = (userMessages[i] as string).trim();
    if (stripped.startsWith('<system-reminder>')) continue;
    return stripped;
  }

  // 3) 兜底
  return (userMessages[userMessages.length - 1] as string).trim();
}

/** 宽松的消息形状（调用方可能传 pydantic 对象或裸 dict）。 */
export type MessageDictLike = Record<string, unknown>;

/* ==================================================================== */
/* 预算常量（互相有约束关系，改前务必读完注释）                        */
/* ==================================================================== */

/**
 * 网页端输入框长度上限（实测）。
 *
 * ChatGLM 输入框填 8.2 万字符时：`textarea.value` 正常写入，但按 Enter
 * **不会提交**（不报错、不产生新对话轮次），表现为「模型未返回任何内容」。
 * 实测 7 万字符仍可发送；这里取 64K（留安全余量，同时尽量保留上下文）。
 */
export const BROWSER_PROMPT_MAX_LEN = 64000;

/**
 * 整个 HTTP 请求的时间预算（秒）。
 *
 * 必须 < 超时中间件的 300s，并留出把 `[DONE]` 写回客户端的时间。
 *
 * 为什么要设总预算：一次请求内部可能串起**多个完整对话往返** ——
 * 首轮对话 + 两轮策略的 reparse。各轮在 provider 内部各自有 240s 硬超时，
 * 不设总预算则合计必然超 300s：实测首轮 176s + reparse 114s，
 * 被中间件在 300s 处掐断 → 客户端拿到 504，连首轮已经拿到的文本都没有。
 */
export const TOTAL_TIME_BUDGET = 270.0;

/**
 * 两轮策略（reparse）至少要有多少剩余时间才值得启动。
 *
 * 转换器那轮本身需要模型再生成一次（实测 20~120s），剩余太少时
 * 直接放行首轮的文本回答，比超时后什么都拿不到更有用。
 */
export const REPARSE_MIN_BUDGET = 60.0;

/**
 * 两轮策略自身的耗时上限（秒）。
 *
 * 实测 reparse 有可能一直「思考」到被总预算掐断却什么都没产出
 * （一次烧掉 140s，仍然 0 个工具调用）。给它独立上限，失败时能更快
 * 把首轮的文本回答还给客户端。
 */
export const REPARSE_MAX_BUDGET = 90.0;

/**
 * 历史压缩的预算门槛（秒）。
 *
 * 「压缩历史」不是免费的：一份 8 万字符的提示词要压缩 2 次，每次都是一轮完整对话，
 * 实测烧掉 117s，剩下的 150s 只够主对话跑一次 → 「两轮策略」因剩余时间不足被跳过，
 * 模型只交一份计划书就结束回合 → 用户看到「读了半天、一个文件都没改、任务终止」。
 *
 * 对策：剩余预算低于本值就不压缩，改用快速中间截断，把时间留给真正干活的环节。
 */
export const COMPRESS_MIN_BUDGET = 170.0;

/** 单块压缩的时间上限（秒），避免无限等待。 */
export const COMPRESS_CHUNK_MAX_SECONDS = 60.0;

/** 自驱动续跑至少要留多少剩余预算（一轮完整对话，比 reparse 稍多）。 */
export const CONTINUE_MIN_BUDGET = 80.0;
export const CONTINUE_MAX_BUDGET = 100.0;

/**
 * 同一用户请求下允许的最大工具调用轮数。
 *
 * ⚠️ 旧值 8 太小：模型一次想读 4 个文件时我们**只下发第一个**，
 * 8 轮就被截停，然后回一句「操作已完成。」—— 实测用户「帮我修复这几处」，
 * 读了 8 个文件后就被截停，**一个文件都没改**。
 */
export const TOOL_ROUND_LIMIT = 24;

/* ==================================================================== */
/* 只读工具判定                                                        */
/* ==================================================================== */

/**
 * 「只读」工具名（归一化后比对：去掉非字母并小写）。
 *
 * 这些调用不改任何状态，同一条回复里的多个调用可以**一起下发**，
 * 由客户端并行执行 —— 省下大量轮次（读取 6 个文件从 6 轮降到 1 轮）。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read', 'readfile', 'readfiles', 'getfilecontent', 'getfilecontents',
  'listdir', 'listfiles', 'listdirectory', 'ls', 'glob', 'findfile', 'findfiles',
  'searchfile', 'searchfiles', 'searchcontent', 'searchcodebase', 'grep',
  'codesearch', 'readlints', 'view', 'cat', 'stat', 'diff',
]);

/** 工具名是否属于「只读」类（可安全地在同一轮里批量下发）。 */
export function isReadOnlyTool(name: string): boolean {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return READ_ONLY_TOOLS.has(n);
}

/* ==================================================================== */
/* 自驱动续跑                                                          */
/* ==================================================================== */

/**
 * 识别「只给计划、没有动手」的未完成回答。
 *
 * 实测：模型读了 7 轮文件后，最后的回答是一段**计划书** ——
 * 「仍有三处关键文件内容未知…需先补读」—— 里面没有任何工具调用。
 * 客户端收到纯文本即结束回合，用户看到「读了半天、一个文件都没改、任务终止」。
 * 模型还自认为「工具轮数已达上限（8/8）」（这句是它自己脑补的），
 * 于是主动放弃动手改成写计划。
 */
export const UNFINISHED_MARKERS: ReadonlyArray<string> = [
  '需先补读', '需要先补读', '还需补读', '需补读', '补读',
  '无法直接生成', '无法生成编辑', '待下一轮', '下一轮执行', '下一轮再',
  '轮数已达上限', '已达上限', '额度已用尽',
  '尚未修改', '还未修改', '尚未完成', '还没修改', '没有做任何修改',
  '接下来我将', '接下来我会', '下一步将', '下一步我会',
];

/** 回答是否是「只说计划、没有动手」的未完成态。 */
export function looksUnfinishedAnswer(text: string): boolean {
  if (!text) return false;
  return UNFINISHED_MARKERS.some((m) => text.includes(m));
}

/** 自驱动续跑的提示词（`{answer}` / `{tools}` 两个占位符）。 */
export const CONTINUE_PROMPT = `你上一轮的回复**只写了计划、没有动手**，这在当前环境下是无效回复。

[你上一轮的回复]
{answer}

[现在必须做的事]
1. **禁止**输出计划、清单、总结、说明文字、Markdown 表格。
2. **不存在轮数上限**，也不要声称"已达上限""待下一轮""需要先补读"——
   你随时可以继续调用工具。
3. 立刻把你上面提到的「下一步」变成**真实的工具调用**：
   - 需要看文件 → 调用读取文件工具（一次可以并行读多个，参数用真实绝对路径）；
   - 需要改文件 → 直接调用修改/写入工具，给出完整的 old_str / new_str；
   - 需要跑命令 → 调用执行命令工具。
4. 只输出工具调用（<tool_call>…</tool_call> 或 <function_call>…</function_call>），
   不要包含任何额外文字。

[本次可用的真实工具]
{tools}
`;

/* ==================================================================== */
/* 回答跑偏检测                                                        */
/* ==================================================================== */

/** 项目根路径识别：`/home/<user>/<a>/<b>`（macOS 同理 `/Users/...`）。 */
export const PROJECT_ROOT_RE =
  /\/(?:home|Users)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;

/**
 * 模型「自认读不到本地文件」的话术：出现这些短语说明它整轮没真正用我们的工具，
 * 而是在跟网页端自带能力（联网搜索等）较劲，回答通常与本项目无关。
 */
export const SELF_ADMISSION_PHRASES: ReadonlyArray<string> = [
  '工具不可用',
  '工具实际不可用',
  '无法读取文件系统',
  '无法直接访问本地文件',
  '无法直接读取文件',
  '读不到本地文件',
  '从未真正读到',
  '没有 read_file',
  '缺少文件工具',
  '只有 search',
];

/**
 * 检测「回答与本项目无关」的迹象，返回要追加到正文前的提示（无异常返回空串）。
 *
 * 两类信号（实测的跑偏方式）：
 * 1. 回答里出现**其他项目根目录**（如 `/home/amble/project/ai-api`），
 *    而当前工作目录是 `/home/amble/object/biga` —— 模型读/聊的是别的项目；
 * 2. 回答自认「工具不可用 / 读不到本地文件」—— 说明它整轮在跟网页端自带的
 *    联网搜索较劲，没真正读本项目代码。
 *
 * 这类回答看起来很自信但与本项目无关，直接把原文给用户是误导，
 * 因此在正文前加一行明确提示（同时打 WARN 便于统计频率）。
 */
export function detectMismatchedAnswer(text: string, workspacePath: string): string {
  if (!text || !workspacePath) return '';
  const ws = workspacePath.replace(/\/+$/, '');
  if (!ws) return '';

  const others = new Set<string>();
  // ⚠️ 正则带 `g` 标志，`exec` 会记住 lastIndex → 必须每次重置
  PROJECT_ROOT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROJECT_ROOT_RE.exec(text)) !== null) {
    const root = m[0].replace(/\/+$/, '');
    // 互为前缀视为同一个项目（工作目录可能是项目子目录，反之亦然）
    if (ws.startsWith(root) || root.startsWith(ws)) continue;
    others.add(root);
  }

  const wsBase = ws.split('/').pop() ?? '';
  const wsMentions = countOccurrences(text, ws) + (wsBase.length > 3 ? countOccurrences(text, wsBase) : 0);

  if (others.size > 0 && wsMentions === 0) {
    const listed = [...others].sort().slice(0, 2);
    return (
      `[提示] 本次回答可能与本项目无关：回答里出现了其他项目路径 ` +
      `${JSON.stringify(listed)}，而当前工作目录是 \`${ws}\`。` +
      '模型可能使用了网页端自带的联网搜索或读到了其他项目的记忆，建议重发一次请求。\n\n'
    );
  }

  const hit = SELF_ADMISSION_PHRASES.find((p) => text.includes(p));
  if (hit) {
    return (
      `[提示] 模型自述「${hit}」：本次回答很可能**不是**基于本项目代码` +
      `（当前工作目录 \`${ws}\`），建议重发一次请求。\n\n`
    );
  }
  return '';
}

/** 统计子串出现次数（Python `str.count`）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/* ==================================================================== */
/* 提示词截断                                                          */
/* ==================================================================== */

/**
 * 截断注入给网页端的 prompt，防止超过输入框上限导致消息发不出去。
 *
 * 截断策略：保留头部（工具调用协议 + 工具列表，决定能否产出工具调用）
 * 与尾部（最近的对话内容，含 `<user_query>`），仅丢弃中间部分。
 */
export function truncatePromptForBrowser(text: string, maxLen = BROWSER_PROMPT_MAX_LEN): string {
  if (!text || text.length <= maxLen) return text;

  const marker = `\n\n... [上下文过长，已省略中间 ${text.length - maxLen} 字符] ...\n\n`;
  const headLen = Math.trunc(maxLen * 0.45);
  const tailLen = maxLen - headLen - marker.length;
  if (tailLen <= 0) return text.slice(0, maxLen);

  const truncated = text.slice(0, headLen) + marker + text.slice(-tailLen);
  logger.warn(
    `[prompt] 注入内容过长(${text.length} 字符)，已截断至 ${truncated.length} 字符` +
      `（保留头部 ${headLen} + 尾部 ${tailLen}）`,
  );
  return truncated;
}

/* ==================================================================== */
/* 会话复用（只补发增量）                                              */
/* ==================================================================== */
//
// 背景：ChatGLM 的网页会话会保留我们上一次发进去的**完整提示词**以及它自己的回复，
// 所以同一会话的后续请求只需补发「新增消息」。
//
// 收益（实测）：27 个工具的长对话，提示词从 ~24KB 降到几 KB，
// 既省网页输入框额度，又显著降低模型「只描述不调用工具」的概率。

interface SessionSendRecord {
  /** 已发进网页会话的消息条数（下次只发 `slice(count)`）。 */
  count: number;
  /** 已发送部分**逐条**的指纹（校验客户端没改写历史）。 */
  fps: string[];
  platform: string;
  ts: number;
}

const SESSION_SEND_STATE = new Map<string, SessionSendRecord>();

/** 最多记住多少个会话。 */
const SESSION_STATE_MAX = 50;

/** 30 分钟没再用的记录视为过期（网页会话多半也没了）。 */
const SESSION_STATE_TTL = 1800.0;

/**
 * 只有 ChatGLM 用「网页对话」承载上下文。
 *
 * 其他平台即使共用同一个浏览器页面也不能套用增量协议
 * （它们各自会导航到自己的站点，会话互不相通）。
 */
const SESSION_REUSE_PLATFORMS: ReadonlySet<string> = new Set(['chatglm']);

/** 把 `provider.platform` 归一成站点名（`chatglm-browser` → `chatglm`）。 */
export function platformOf(platformName: string): string {
  if (!platformName) return '';
  let name = extractPlatformName(platformName).trim().toLowerCase();
  for (const suffix of ['-browser', '_browser', '-web', '_web']) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name;
}

/** 从 provider 的 platform 名里取平台名（目前是直通，保留钩子）。 */
export function extractPlatformName(providerPlatform: string): string {
  return providerPlatform;
}

/**
 * 规范化 JSON（键排序），等价于 Python `json.dumps(sort_keys=True, ensure_ascii=False)`。
 *
 * ⚠️ 仅在**本进程内**用于比对指纹，不与其他语言的实现互通，
 * 因此不需要和 Python 的字节序列完全一致。
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(', ')}]`;
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${canonicalJson(rec[k])}`).join(', ')}}`;
  }
  return JSON.stringify(String(value));
}

/** 单条消息的指纹（用于逐条比对历史是否被改写）。 */
export function msgFingerprint(msg: ChatMessage | MessageDictLike): string {
  let body: string;
  try {
    body = canonicalJson(messageToDict(msg as ChatMessage));
  } catch {
    body = String(msg);
  }
  return createHash('md5').update(body, 'utf8').digest('hex');
}

/**
 * 若这个会话的历史是上次的延续，返回「本次新增消息」的列表。
 *
 * @returns 新增消息；不可复用（无记录 / 历史被改写 / 无新增）时返回 `[]`。
 */
export function getSessionDelta(
  messages: ReadonlyArray<ChatMessage | MessageDictLike>,
  conversationId: string | null | undefined,
): Array<ChatMessage | MessageDictLike> {
  if (!conversationId) return [];
  const rec = SESSION_SEND_STATE.get(conversationId);
  if (!rec) return [];

  const now = Date.now() / 1000;
  if (now - rec.ts > SESSION_STATE_TTL) {
    SESSION_SEND_STATE.delete(conversationId);
    return [];
  }

  const count = Math.trunc(rec.count || 0);
  if (count <= 0 || count >= messages.length) return [];

  // 逐条比对：客户端可能改写历史（编辑消息 / 上下文压缩 / 换工作区），
  // 也可能只是 system 提示词里带了变化的环境信息。
  // 任何一条不一致都不能只发增量（否则网页会话里的上下文与真实历史不符）。
  const prevFps = rec.fps ?? [];
  for (let i = 0; i < Math.min(count, prevFps.length); i += 1) {
    const cur = msgFingerprint(messages[i] as ChatMessage);
    if (cur !== prevFps[i]) {
      const role = messageToDict(messages[i] as ChatMessage).role;
      logger.info(
        `[session] 会话 ${conversationId} 的第 ${i} 条消息（${role}）与上次不同` +
          '（历史被改写或环境信息变化），本轮发完整提示词',
      );
      SESSION_SEND_STATE.delete(conversationId);
      return [];
    }
  }

  return messages.slice(count);
}

/** 记录「这批消息已经发进 platform 的网页会话」，供下次算增量。 */
export function rememberSessionSend(
  conversationId: string | null | undefined,
  messages: ReadonlyArray<ChatMessage | MessageDictLike>,
  platform: string,
): void {
  if (!conversationId) return;

  const site = platformOf(platform);
  if (!SESSION_REUSE_PLATFORMS.has(site)) {
    SESSION_SEND_STATE.delete(conversationId);
    return;
  }

  // 过期清理 + 容量控制（简单 LRU：按 ts 丢最旧）
  const now = Date.now() / 1000;
  for (const [k, v] of SESSION_SEND_STATE) {
    if (now - v.ts > SESSION_STATE_TTL) SESSION_SEND_STATE.delete(k);
  }
  if (SESSION_SEND_STATE.size >= SESSION_STATE_MAX) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [k, v] of SESSION_SEND_STATE) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) SESSION_SEND_STATE.delete(oldestKey);
  }

  SESSION_SEND_STATE.set(conversationId, {
    count: messages.length,
    fps: messages.map((m) => msgFingerprint(m as ChatMessage)),
    platform: site,
    ts: now,
  });

  logger.info(
    `[session] 已记录会话 ${conversationId} 的发送进度: ${messages.length} 条消息（平台 ${site}）`,
  );
}

/** 清空会话发送记录（测试用）。 */
export function __clearSessionSendState(): void {
  SESSION_SEND_STATE.clear();
}

