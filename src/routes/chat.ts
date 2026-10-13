/**
 * `/v1/chat/completions` —— `legacy-python/src/api/routes.py` 第 1308~3022 行的移植
 * （Python 侧是**一个 1,717 行的函数**，这里按阶段拆开）。
 *
 * ## 阶段划分（与 Python 的代码顺序一一对应）
 * 1. {@link preparePrompt}：入场（日志 / 期限）→ 会话 ID → 工作目录 → 工具文本 →
 *    轮数上限检查 → 提示词拼装 → 增量 → 超长压缩；
 * 2. {@link parseAndRecoverToolCalls}：解析工具调用 + 四层降级恢复
 *    （SSE 原文 → DOM 损坏降级 → 文本转换器 → 两轮策略 reparse → 自驱动续跑）；
 * 3. {@link streamResponse}：流式分支；
 * 4. {@link nonStreamResponse}：非流式分支。
 *
 * ## 一条贯穿全文件的规则
 * **优先用 SSE 文本，而不是流式增量拼接的 `fullResponse`。**
 * `fullResponse` 是逐块拼接的，模型中途改写回答时会变成
 * 「草稿1 + 草稿2 + 最终答案」的乱码；而 SSE 文本是未经渲染的最终报文。
 * 详见 `docs/hard-constraints.md`。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getDefaultWorkspacePaths } from '../config.js';
import { getHistoryDb } from '../controllers/history-db.js';
import { getRequestPool } from '../controllers/request-pool.js';
import { getModelRouter } from '../controllers/router.js';
import {
  logAiPlatformResponseComplete,
  logApiError,
  logApiRequest,
  logApiResponse,
  logRoundStart,
} from '../log/api-logger.js';
import {
  logAiRequest,
  logAiResponse,
  logClientRequest,
  logClientResponse,
  logError as debugLogError,
} from '../log/debug-logger.js';
import { logger } from '../log/logger.js';
import { getLastRawSse } from '../providers/chatglm-sse.js';
import type { ChatRequest } from '../providers/base.js';
import { formatMessagesAsText, formatToolsAsText } from '../tools/protocol.js';
import { parseToolCallsFromText } from '../tools/parse.js';
import { buildReparsePrompt } from '../tools/prompts.js';
import { directConvertToToolCalls, convertTextToToolCalls } from '../tools/convert.js';
import { filterPlaceholderToolCalls } from '../tools/placeholder.js';
import {
  createToolMaps,
  filterUnknownToolCalls,
  repairToolCallBySignature,
  type ToolMaps,
} from '../tools/names.js';
import {
  DOM_CORRUPTION_INDICATOR,
  DOM_PREVIEW_KEY_INDICATOR,
} from '../tools/repair.js';
import {
  FABRICATED_PATH_PREFIXES,
  extractFilePathsFromMessages,
  extractWorkspacePath,
} from '../tools/workspace.js';
import {
  getTextContent,
  messageToDict,
  type ChatMessage,
  type MessageDict,
  type ToolCallPayload,
  type ToolDefinition,
} from '../types/message.js';
import type { ChatCompletionRequest } from '../types/openai.js';
import { errorMessage } from '../utils/errors.js';
import { buildReparseInput, streamWithFailover } from './failover.js';
import {
  BROWSER_PROMPT_MAX_LEN,
  CONTINUE_MAX_BUDGET,
  CONTINUE_MIN_BUDGET,
  CONTINUE_PROMPT,
  REPARSE_MAX_BUDGET,
  REPARSE_MIN_BUDGET,
  TOTAL_TIME_BUDGET,
  TOOL_ROUND_LIMIT,
  detectMismatchedAnswer,
  extractUserQuestion,
  getSessionDelta,
  isReadOnlyTool,
  looksUnfinishedAnswer,
  rememberSessionSend,
  truncatePromptForBrowser,
} from './helpers.js';
import {
  markRequestTs,
  schedulePrecompress,
  shrinkPromptViaCompression,
} from './compress.js';
import { DONE, contentChunk, roleChunk, toolCallsChunk } from './sse.js';

/* ==================================================================== */
/* 类型                                                                */
/* ==================================================================== */

type MessageLike = ChatMessage | MessageDict | Record<string, unknown>;

/** 准备结果：要么被轮数上限截停，要么拿到可发送的请求。 */
export type PrepareResult =
  | { kind: 'limit_exceeded'; message: string; toolRoundCount: number }
  | { kind: 'ok'; prepared: PreparedRequest };

/** 准备完毕、可以直接发给 Provider 的请求。 */
export interface PreparedRequest {
  requestId: string;
  /** 整个 HTTP 请求的绝对截止时间（epoch 毫秒）。 */
  deadlineTs: number;
  request: ChatCompletionRequest;
  /** 逻辑会话 ID（会话复用用）。 */
  conversationId: string | null;
  /** 最终要发送的提示词（可能已被压缩/截断）。 */
  messageText: string;
  /** **压缩前**的提示词（后台预压缩的切分口径必须基于它）。 */
  rawMessageText: string;
  /** 只含新增消息的增量提示词（空串表示无法复用）。 */
  deltaText: string;
  workspacePath: string;
  knownFilePaths: string[];
  toolsText: string;
  /** 最后一轮用户消息之后的 assistant+tool_calls 轮数。 */
  toolRoundCount: number;
  lastMessage: MessageLike | null;
}

/* ==================================================================== */
/* 阶段 1：请求准备                                                    */
/* ==================================================================== */

/**
 * 入场准备：日志 → 会话 ID → 工作目录 → 工具文本 → 轮数上限 → 提示词 → 压缩。
 */
export async function preparePrompt(
  rawRequest: ChatCompletionRequest,
  request: FastifyRequest,
): Promise<PrepareResult> {
  const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // 记录「最近一次收到请求」的时间：后台预压缩靠它判断该不该让位
  markRequestTs();

  /* 本请求的绝对截止时间。
   * ⚠️ 与 Python 的差异：Python 用 `now + 270s`（假设中间件是 300s）。
   * 这里额外与超时中间件写下的 `deadlineTs` 取最小值 —— 中间件配成更短的值时
   * 也能正确收敛，不会出现「Provider 还在跑、中间件已经掐断」的死角。 */
  const ownDeadline = Date.now() + TOTAL_TIME_BUDGET * 1000;
  const deadlineTs = request.deadlineTs ? Math.min(request.deadlineTs, ownDeadline) : ownDeadline;

  const messages = rawRequest.messages as unknown as MessageLike[];
  const messageDicts = messages.map((m) => messageToDict(m as ChatMessage));

  logClientRequest({
    requestId,
    model: rawRequest.model,
    messages: messageDicts as unknown as Array<Record<string, unknown>>,
    stream: rawRequest.stream,
    tools: rawRequest.tools as Array<Record<string, unknown>> | undefined,
    extra: { workspace_path: rawRequest.workspace_path },
  });

  logApiRequest({
    requestId,
    model: rawRequest.model,
    messages: messageDicts as unknown as Array<Record<string, unknown>>,
    stream: rawRequest.stream,
    tools: rawRequest.tools as Array<Record<string, unknown>> | undefined,
    workspacePath: rawRequest.workspace_path ?? '',
  });

  logger.info(`[${requestId}] ========== 收到请求 ==========`);
  logger.info(
    `[${requestId}] 模型: ${rawRequest.model}, 流式: ${rawRequest.stream}, ` +
      `消息数: ${messages.length}, 工具数: ${rawRequest.tools?.length ?? 0}`,
  );

  // 详细消息结构（前 5 条）
  const summaryParts: string[] = [];
  messages.slice(0, 5).forEach((m, i) => {
    const md = messageToDict(m as ChatMessage);
    const role = md.role || '?';
    const preview = String(md.content ?? '').slice(0, 50);
    const hasTc = md.tool_calls ? '✓tc' : '';
    summaryParts.push(`${i}:${role}${hasTc}(${preview}...)`);
  });
  if (messages.length > 5) summaryParts.push(`... 还有 ${messages.length - 5} 条消息`);
  logger.info(`[${requestId}] 消息结构: ${summaryParts.join(' > ')}`);

  if (rawRequest.tools && rawRequest.tools.length > 0) {
    const names = (rawRequest.tools as ToolDefinition[]).map((t) => t.function?.name ?? '?');
    logger.info(
      `[${requestId}] 工具: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`,
    );
  }

  const modelRouter = getModelRouter();
  const historyDb = getHistoryDb();

  const lastMessage = messages.length > 0 ? (messages[messages.length - 1] as MessageLike) : null;
  const lastMessageDict = lastMessage ? messageToDict(lastMessage as ChatMessage) : null;
  let messageText = lastMessageDict ? getTextContent(lastMessageDict.content) : '';

  /* ===== conversation_id =====
   * 优先用客户端传入，否则基于首条 user 消息 hash。
   * ⚠️ 必须在构建提示词**之前**算出来：会话复用（只补发增量）靠它判断
   *    这批消息是否属于同一个网页会话。 */
  let conversationId: string | null = rawRequest.conversation_id ?? null;
  if (!conversationId && messages.length > 1) {
    const firstUser = messages.find((m) => messageToDict(m as ChatMessage).role === 'user');
    if (firstUser) {
      const firstContent = getTextContent(messageToDict(firstUser as ChatMessage).content);
      conversationId = `conv-${createHash('md5').update(firstContent, 'utf8').digest('hex').slice(0, 12)}`;
    }
  }

  /* ===== 工作目录 =====
   * 优先级：请求参数 > 系统消息 > 已知路径推导 > 配置默认值。 */
  const knownFilePaths = extractFilePathsFromMessages(messages as unknown as ChatMessage[]);
  let workspacePath = '';

  if (rawRequest.workspace_path) {
    workspacePath = rawRequest.workspace_path;
    logger.info(`[tool_calls] 使用请求参数中的工作目录: ${workspacePath}`);
  } else {
    workspacePath = extractWorkspacePath(messages as unknown as ChatMessage[]);
    if (workspacePath) {
      logger.info(`[tool_calls] 检测到工作目录: ${workspacePath}`);
    } else {
      // 调试：把系统消息里与路径有关的内容打出来（帮助理解客户端格式）
      for (const m of messages) {
        const md = messageToDict(m as ChatMessage);
        if (md.role !== 'system') continue;
        const content = String(md.content ?? '');
        logger.info(`[tool_calls] 系统消息长度=${content.length}, 前1000字符: ${content.slice(0, 1000)}`);
        for (const kw of ['working', 'director', 'workspace', 'project', '环境', '目录', 'Environ']) {
          const re = new RegExp(kw, 'gi');
          let match: RegExpExecArray | null;
          while ((match = re.exec(content)) !== null) {
            const start = Math.max(0, match.index - 50);
            const end = Math.min(content.length, match.index + kw.length + 100);
            const snippet = content.slice(start, end).replace(/\n/g, '\\n');
            logger.info(`[tool_calls] 系统消息路径线索 (关键词=${kw}): ...${snippet}...`);
          }
        }
        break; // 只看第一个 system 消息
      }

      // 从已知文件路径推导工作目录（只取公共父目录，且目录必须真实存在）
      if (knownFilePaths.length > 0) {
        const dirs = new Set<string>();
        for (const p of knownFilePaths) {
          const d = dirname(p);
          if (
            existsSync(d) &&
            statSync(d).isDirectory() &&
            !FABRICATED_PATH_PREFIXES.some((fp) => d.startsWith(fp.replace(/\/+$/, '')))
          ) {
            dirs.add(d);
          }
        }

        if (dirs.size > 0) {
          const sortedDirs = [...dirs].sort((a, b) => b.length - a.length);
          let candidate = sortedDirs[0] as string;
          for (const d of sortedDirs.slice(1)) {
            while (candidate && !d.startsWith(candidate)) {
              candidate = dirname(candidate);
            }
          }
          // 最终验证：候选目录必须深度 >= 3（避免 `/` 或 `/home`）
          if (
            candidate &&
            existsSync(candidate) &&
            statSync(candidate).isDirectory() &&
            (candidate.match(/\//g)?.length ?? 0) >= 3
          ) {
            workspacePath = candidate;
            logger.info(`[tool_calls] 从已知路径推导工作目录: ${workspacePath}`);
          } else {
            logger.warn(`[tool_calls] 推导的工作目录无效或太浅: ${candidate}, 跳过`);
          }
        }
      }
    }
  }

  // 最终兜底：配置的默认工作目录
  if (!workspacePath) {
    const defaultPaths = getDefaultWorkspacePaths();
    if (defaultPaths.length > 0) {
      workspacePath = defaultPaths[0] as string;
      logger.info(`[tool_calls] 无法从请求中提取工作目录，使用配置的默认值: ${workspacePath}`);
    }
  }

  if (knownFilePaths.length > 0) {
    logger.info(`[tool_calls] 检测到 ${knownFilePaths.length} 个已知文件路径`);
  }

  // ===== 工具描述注入 =====
  let toolsText = '';
  if (rawRequest.tools && rawRequest.tools.length > 0) {
    toolsText = formatToolsAsText(rawRequest.tools as ToolDefinition[], {
      workspacePath,
      knownFilePaths: knownFilePaths.length > 0 ? knownFilePaths : undefined,
    });
    logger.info(`请求包含 ${rawRequest.tools.length} 个工具定义，已注入工具描述`);
  }

  /* ===== 工具调用轮数统计 =====
   * 只统计**最后一次用户消息之后**的轮数，避免历史消息误触发。 */
  let lastUserIdx = -1;
  messages.forEach((m, i) => {
    if (messageToDict(m as ChatMessage).role === 'user') lastUserIdx = i;
  });

  let toolRoundCount = 0;
  if (lastUserIdx >= 0) {
    for (const m of messages.slice(lastUserIdx + 1)) {
      const md = messageToDict(m as ChatMessage);
      if (md.role === 'assistant' && md.tool_calls) toolRoundCount += 1;
    }
  }

  logger.info(
    `[tool_calls] 消息结构: ${messageDicts
      .map((md) => `${md.role}${md.tool_calls ? '✓tc' : ''}`)
      .join(' > ')}, last_user_idx=${lastUserIdx}, tool_round_count=${toolRoundCount}`,
  );

  /* ===== 轮数上限截停 =====
   * ⚠️ 结束语必须**如实说明被截停**：旧文案是「操作已完成。」，
   * 实测用户「帮我修复这几处」时读了 8 个文件就撞上限被截停，
   * 客户端显示「操作已完成。」但**一个文件都没改** —— 严重误导。 */
  if (toolRoundCount >= TOOL_ROUND_LIMIT) {
    logger.warn(
      `[tool_calls] 当前用户请求下工具调用已达 ${toolRoundCount} 轮` +
        `（上限 ${TOOL_ROUND_LIMIT}），返回截停说明`,
    );
    return {
      kind: 'limit_exceeded',
      toolRoundCount,
      message:
        `⚠️ 本轮工具调用已达上限（${toolRoundCount} 轮），` +
        '任务可能尚未完成。请回复「继续」让我接着处理，' +
        '或把任务拆小一点（例如一次只让我改一个文件）。',
    };
  }

  /* ===== 提示词拼装 ===== */
  let roundInstruction = ''; // 工具结果后的附加指令（增量提示词也要带上）
  if (messages.length > 1 || toolsText) {
    const contextText = formatMessagesAsText(messages as unknown as ChatMessage[]);
    messageText = toolsText ? `${toolsText}\n\n${contextText}` : contextText;

    if (toolRoundCount > 0) {
      /* 检查之前的工具调用是否全为只读。
       * ⚠️ 必须用统一的 `isReadOnlyTool()`：旧实现在这里另抄了一份硬编码名单，
       * 漏了 read_file / list_dir / read_lints 等真实工具名，判定会失真。 */
      let allReadOnly = true;
      if (lastUserIdx >= 0) {
        for (const m of messages.slice(lastUserIdx + 1)) {
          const md = messageToDict(m as ChatMessage);
          if (md.role !== 'assistant' || !md.tool_calls) continue;
          for (const tc of md.tool_calls) {
            if (!isReadOnlyTool(tc.function?.name ?? '')) {
              allReadOnly = false;
              break;
            }
          }
        }
      }

      if (allReadOnly && toolRoundCount >= 3) {
        /* 连续读了 3 轮却没修改 → 催一下，避免「只读不写」空转。
         * ⚠️ 两个坑：
         *   1. 不要硬编码工具名（曾写死 SearchReplace，而 CodeBuddy 的真实工具是
         *      replace_in_file，模型会照抄出一个客户端没有的工具名）。
         *   2. 不要说「不要再读取」——模型会理解成「必须收尾」，
         *      于是交一份「需先补读 X」的计划书，回合直接结束、什么都没改。 */
        roundInstruction =
          '\n\n[重要] 你已经连续读取了多轮文件，但还没有做任何修改。' +
          '**本次会话没有轮数上限**，你随时可以继续调用工具，' +
          '不要在回答里声称『轮数已达上限』或『待下一轮』。' +
          '如果信息已经足够，请立刻调用「修改文件」类工具（见上方工具列表）落地修改；' +
          '确实还缺关键文件就继续读取（可一次并行读多个），不要停下来。' +
          '禁止只输出计划、清单或『需先补读…』这类说明文字。';
        logger.info(`[tool_calls] 检测到 ${toolRoundCount} 轮只读不写，注入强制修改指令`);
      } else {
        roundInstruction =
          '\n\n[重要] 上述工具调用已经执行完毕，结果如上所示。' +
          '**本次会话没有轮数上限**（不要在回答里声称『工具轮数已达上限』' +
          '『待下一轮执行』『需先补读』），请继续用工具推进任务：' +
          '还需要看文件就直接调用读取工具（可一次并行读多个）；' +
          '需要修改就直接调用修改/写入工具；' +
          '只有在**全部工作确实完成**之后才输出总结文字；' +
          '不要把计划清单写进项目文件、也不要把它当成最终回答。';
      }
      messageText += roundInstruction;
    }
  } else if (toolsText) {
    messageText = `${toolsText}\n\n${messageText}`;
  }

  /* ===== 同一会话只补发增量 =====
   * 网页会话里已经有上一次发进去的完整提示词与模型自己的回复，
   * 因此这次只需要发「新增消息 + 工具协议」。
   * 只发增量是**有前提**的：由 provider 确认它确实复用了同一个网页会话，
   * 否则它会退回发完整提示词。 */
  let deltaText = '';
  const deltaMessages = getSessionDelta(messages as unknown as ChatMessage[], conversationId);
  if (deltaMessages.length > 0) {
    const deltaContext = formatMessagesAsText(deltaMessages as unknown as ChatMessage[]);
    deltaText = toolsText ? `${toolsText}\n\n${deltaContext}` : deltaContext;
    deltaText += roundInstruction;
    if (deltaText.length > BROWSER_PROMPT_MAX_LEN) {
      deltaText = truncatePromptForBrowser(deltaText);
    }
    logger.info(
      `[session] 会话 ${conversationId} 可复用：本轮只补发增量 ` +
        `${deltaMessages.length} 条消息（${deltaText.length} 字符，` +
        `完整提示词 ${messageText.length} 字符）`,
    );
  }

  /* ===== 超长压缩 =====
   * 记下**压缩前**的原文：① 预压缩是否值得做，要看压缩前的长度
   * （压缩后必然掉到上限以下，用它判断会永远为假）；
   * ② 后台预压缩的切分/缓存前缀必须基于原文，否则与下一轮的口径不一致。 */
  const rawMessageText = messageText;
  if (messageText.length > BROWSER_PROMPT_MAX_LEN) {
    messageText = await shrinkPromptViaCompression(
      messageText,
      modelRouter,
      rawRequest.model,
      historyDb,
      requestId,
      conversationId ?? '',
      deadlineTs,
    );
  } else {
    messageText = truncatePromptForBrowser(messageText);
  }

  return {
    kind: 'ok',
    prepared: {
      requestId,
      deadlineTs,
      request: rawRequest,
      conversationId,
      messageText,
      rawMessageText,
      deltaText,
      workspacePath,
      knownFilePaths,
      toolsText,
      toolRoundCount,
      lastMessage,
    },
  };
}

/* ==================================================================== */
/* 阶段 2：工具调用解析与降级恢复                                       */
/* ==================================================================== */

/** SSE 报文里原始 tool_call 的形状（来自 ChatGLM 的 SSE）。 */
interface RawSseToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** 客户端可执行的标准工具名（`arguments` 为空时用来判断"是否值得保留"）。 */
const TRAE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write', 'SearchReplace', 'Read', 'AskFollowupQuestion',
  'insert_content', 'search_content', 'list_dir',
  'write_to_file', 'write_file', 'create_file',
  'edit_file', 'replace_in_file',
]);

/** 标准名 → 别名（用于套用「客户端实际工具名」映射）。 */
const ALIAS_TO_STD: Record<string, string> = {
  write_file: 'Write',
  WriteFile: 'Write',
  create_file: 'Write',
  edit_file: 'SearchReplace',
  EditFile: 'SearchReplace',
  edit: 'SearchReplace',
  replace: 'SearchReplace',
  replace_in_file: 'SearchReplace',
};

/** JS 版 `str.count` 的等价物。 */
function contains(haystack: string, needle: string): boolean {
  return needle !== '' && haystack.includes(needle);
}

/**
 * 把 SSE 原始 `tool_calls` 转成 OpenAI 格式。
 *
 * 过滤规则（全部来自实测）：
 * - `finish` 是 SSE 结束信号；`search` 是 ChatGLM 内置搜索；
 *   `open` 空参数/仅含导航信息的是内部噪声 —— 三者都必须丢弃，
 *   否则会把它们当成客户端工具下发（客户端不认识 → 卡住）。
 * - ChatGLM 有时把**整个 tool_call JSON 塞进 `name` 字段**
 *   （`name = '{"name": "Write", "arguments": {...}}'`），要拆出来。
 * - `arguments` 为空的畸形调用，只有标准工具名才保留。
 * - 最后套用「标准名 → 客户端实际工具名」映射。
 */
function sseToolCallsToOpenAi(
  rawToolCalls: ReadonlyArray<RawSseToolCall>,
  toolMaps: Record<string, string>,
): ToolCallPayload[] {
  const out: ToolCallPayload[] = [];

  rawToolCalls.forEach((tc, i) => {
    if (!tc || typeof tc !== 'object' || !('name' in tc)) return;

    const nameRaw = typeof tc.name === 'string' ? tc.name : '';
    const argsRaw = tc.arguments;
    let actualName = nameRaw;
    let actualArgs: unknown = argsRaw;

    // ---- 过滤 ChatGLM 内部工具调用 ----
    if (nameRaw === 'finish') return;
    if (nameRaw === 'search') return;
    if (nameRaw === 'open') {
      const s = typeof argsRaw === 'string' ? argsRaw : '';
      if (!s || s === '{}' || s === '{') return;
      try {
        const parsed = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
        if (parsed && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>;
          if (rec['open'] || rec['ref_id']) return;
        }
      } catch {
        // 解析不了就按「不是内部调用」处理
      }
    }

    // ---- 处理 `name` 是 JSON 字符串的畸形格式 ----
    if (nameRaw.startsWith('{')) {
      try {
        const parsedName = JSON.parse(nameRaw) as Record<string, unknown>;
        if (parsedName && typeof parsedName['name'] === 'string') {
          actualName = parsedName['name'];
          if (parsedName['arguments']) {
            actualArgs =
              typeof parsedName['arguments'] === 'string'
                ? parsedName['arguments']
                : JSON.stringify(parsedName['arguments']);
          } else if (argsRaw) {
            actualArgs = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw);
          } else {
            actualArgs = '';
          }
        }
      } catch {
        // 保持原样
      }
    }

    const argsStr = typeof actualArgs === 'string' ? actualArgs : JSON.stringify(actualArgs ?? '');

    // ---- 空 arguments + 非标准名称 → 丢弃 ----
    if (!argsStr || argsStr === '{}' || argsStr === '{') {
      if (!TRAE_TOOL_NAMES.has(actualName)) return;
    }

    // ---- 套用动态工具名映射（标准名 → 客户端实际工具名）----
    const stdName = ALIAS_TO_STD[actualName] ?? actualName;
    if (stdName === 'Write' && toolMaps['write']) actualName = toolMaps['write'];
    else if (stdName === 'SearchReplace' && toolMaps['edit']) actualName = toolMaps['edit'];
    else if (stdName === 'Read' && toolMaps['read']) actualName = toolMaps['read'];

    out.push({
      id: tc.id ?? `call_${i}`,
      type: 'function',
      function: { name: actualName, arguments: argsStr },
    });
  });

  return out;
}

/** 工具调用里是否带「真正的文件内容」（判断哪一路解析更完整）。 */
function toolCallsHaveContent(toolCalls: ReadonlyArray<ToolCallPayload>): boolean {
  return toolCalls.some((tc) => {
    const args = tc.function?.arguments ?? '';
    return contains(args, 'content') || contains(args, 'old_str');
  });
}

/**
 * 解析工具调用并做四层降级恢复。
 *
 * 降级顺序（**不可调换**）：
 * 1. 直接解析（`parseToolCallsFromText`）；
 * 2. **DOM 损坏降级**：ChatGLM 的 markdown 渲染器会消费 `<function_call>` 标签，
 *    导致 `innerText` 里的 JSON 被双重展开/截断 → 先用 SSE 原始 tool_calls，
 *    再用 SSE 原文/思考文本重新解析。
 *    ⚠️ **不能对 SSE 文本做损坏判定**：它是未渲染的原始报文，不存在 DOM 损坏；
 *    误判会触发破坏性「修复」，提取出**错误的工具调用**
 *    （JSON 里合法的转义引号 `\"x\"` 会被当成损坏特征）。
 * 3. 文本转换器（直接转换 → 代码块/路径提取）；
 * 4. 两轮策略 reparse（模型再生成一轮把它自己的意图转成工具调用）；
 * 5. 自驱动续跑（仅流式分支，见 {@link ParseOptions.selfContinue}）。
 */
export interface ParseOptions {
  /** 是否执行「路径纠正」这一步（Python 只在流式分支做了）。 */
  fixPaths: boolean;
  /** 是否丢弃 `old_str` 为空的 SearchReplace（Python 只在流式分支做了）。 */
  validateSearchReplace: boolean;
  /** 是否允许自驱动续跑（Python 只在流式分支做了）。 */
  selfContinue: boolean;
}

export interface ParseOutcome {
  /** 要发给客户端的文本。 */
  parsedText: string;
  /** 要下发给客户端的工具调用。 */
  parsedToolCalls: ToolCallPayload[];
  /** 实际使用的平台（reparse 可能切平台，但这里只用于日志）。 */
  finishReason: 'stop' | 'tool_calls';
}

/**
 * 解析并恢复工具调用。
 *
 * @param parseSource 首选解析源（SSE 全文，最保真）
 * @param fullResponse 流式增量拼接结果（兜底）
 * @param fromSse parseSource 是否来自 SSE
 */
export async function parseAndRecoverToolCalls(params: {
  parseSource: string;
  fullResponse: string;
  fromSse: boolean;
  currentPlatform: string | null;
  prepared: PreparedRequest;
  modelRouter: ReturnType<typeof getModelRouter>;
  historyDb: ReturnType<typeof getHistoryDb>;
  /** 本请求的工具映射表（按请求创建，避免并发请求互相串扰）。 */
  toolMaps: ToolMaps;
  options: ParseOptions;
}): Promise<ParseOutcome> {
  const {
    parseSource,
    fullResponse,
    fromSse,
    currentPlatform,
    prepared,
    modelRouter,
    historyDb,
    toolMaps,
    options,
  } = params;

  const { request: rawRequest, deadlineTs, workspacePath, knownFilePaths, lastMessage } = prepared;
  const tools = (rawRequest.tools ?? []) as ToolDefinition[];
  const requestId = prepared.requestId;

  let source = parseSource;
  let sourceFromSse = fromSse;
  let parsed: ReturnType<typeof parseToolCallsFromText>;
  try {
    parsed = parseToolCallsFromText(source, toolMaps);
  } catch (error) {
    logger.warn(`[tool_calls] 解析失败: ${errorMessage(error)}`);
    parsed = { text: source, toolCalls: [] };
  }
  let parsedText = parsed.text;
  let parsedToolCalls = parsed.toolCalls as unknown as ToolCallPayload[];

  logger.info(
    `[tool_calls] parse_source(来自SSE=${sourceFromSse}, len=${source.length}) 开头: ` +
      `${JSON.stringify(source.slice(0, 120))}`,
  );
  logger.info(
    `[tool_calls] parsed_text(len=${parsedText.length}) 开头: ` +
      `${JSON.stringify(parsedText.slice(0, 120))}, 拼接(full_response)开头: ` +
      `${JSON.stringify(fullResponse.slice(0, 120))}`,
  );

  /* ===== 步骤 2：DOM 损坏降级 ===== */
  const isDomCorrupted =
    !sourceFromSse &&
    (DOM_CORRUPTION_INDICATOR.test(source) || DOM_PREVIEW_KEY_INDICATOR.test(source));

  logger.info(
    `[tool_calls] DOM 损坏检测: is_corrupted=${isDomCorrupted}, platform=${currentPlatform}`,
  );

  if (isDomCorrupted && currentPlatform && currentPlatform.includes('chatglm')) {
    const rawSse = getLastRawSse();

    // 策略 1：直接使用 SSE 中的 tool_calls 数据
    const rawToolCalls = (rawSse.toolCalls ?? []) as unknown as RawSseToolCall[];
    let sseTcs: ToolCallPayload[] = [];
    if (rawToolCalls.length > 0) {
      logger.info(`[tool_calls] 检测到 DOM 损坏，使用 SSE 原始 tool_calls (${rawToolCalls.length}个)`);
      sseTcs = sseToolCallsToOpenAi(rawToolCalls, toolMaps.name);

      if (sseTcs.length > 0) {
        // 只有 SSE 版更完整（带 content/old_str）或渲染版没有内容时才替代
        const sseHasContent = toolCallsHaveContent(sseTcs);
        const renderedHasContent = parsedToolCalls.length > 0 && toolCallsHaveContent(parsedToolCalls);
        if (sseHasContent || !renderedHasContent) {
          logger.info(
            `[tool_calls] SSE tool_calls 更完整，替代渲染解析 ` +
              `(SSE: ${sseTcs.length}个, 渲染: ${parsedToolCalls.length}个)`,
          );
          parsedToolCalls = sseTcs;
          parsedText = '';
        } else {
          logger.info('[tool_calls] SSE tool_calls 未更完整，保留渲染解析');
        }
      }
    }

    // 策略 2：用 SSE 原始文本（或思考文本）重新解析
    if (parsedToolCalls.length === 0 || !toolCallsHaveContent(parsedToolCalls)) {
      const sseFallbackText = rawSse.text || rawSse.think || '';
      if (sseFallbackText.length > 10) {
        const label = rawSse.text ? 'SSE文本' : 'SSE思考文本';
        logger.info(
          `[tool_calls] 尝试用原始 ${label} 降级解析 (长度=${sseFallbackText.length})`,
        );
        logger.info(`[tool_calls] 原始 ${label} 前500字符: ${JSON.stringify(sseFallbackText.slice(0, 500))}`);
        const rawParsed = parseToolCallsFromText(sseFallbackText, toolMaps);
        const rawToolCalls2 = rawParsed.toolCalls as unknown as ToolCallPayload[];
        if (rawToolCalls2.length > 0) {
          if (toolCallsHaveContent(rawToolCalls2)) {
            logger.info(
              `[tool_calls] 原始 ${label} 解析更完整，替代渲染解析 (原始: ${rawToolCalls2.length}个)`,
            );
            parsedText = rawParsed.text;
            parsedToolCalls = rawToolCalls2;
          } else {
            logger.info(`[tool_calls] 原始 ${label} 解析未更完整，保留渲染解析`);
          }
        } else {
          logger.info(`[tool_calls] 原始 ${label} 也未解析到工具调用`);
        }
      }
    }
  }

  logAiResponse({
    requestId,
    platform: currentPlatform ?? rawRequest.model,
    rawText: fullResponse,
    parsedToolCalls: parsedToolCalls as unknown as Array<Record<string, unknown>>,
    parsedText,
  });

  logAiPlatformResponseComplete({
    requestId,
    platform: currentPlatform ?? 'unknown',
    roundNum: 1,
    rawText: fullResponse,
  });

  logger.info(
    `[tool_calls] AI回复长度=${fullResponse.length}, 前500字符: ` +
      `${JSON.stringify(fullResponse.slice(0, 500))}`,
  );

  if (parsedToolCalls.length > 0) {
    logger.info(
      `[tool_calls] parse_tool_calls 解析到 ${parsedToolCalls.length} 个: ` +
        `${parsedToolCalls.map((tc) => tc.function.name).join(', ')}`,
    );
  }

  /* ⚠️ 两个「文本 → 工具调用」转换器统一用**最干净的那份文本**：SSE 全文。
   * 绝不能传 `fullResponse`：它是逐块拼接的结果，模型改写回答时会变成
   * 「草稿1 + 草稿2 + 最终答案」的乱码，而这些转换器在**没提取到工具调用时
   * 会把输入文本原样返回** → 直接覆盖掉前面已解析好的干净 parsedText。 */
  const convertSource = sourceFromSse && source ? source : fullResponse;

  /* ===== 步骤 3：文本转换器 ===== */
  if (parsedToolCalls.length === 0 && tools.length > 0 && convertSource) {
    const userRequest = lastMessage ? getTextContent(messageToDict(lastMessage as ChatMessage).content) : '';
    const directResult = directConvertToToolCalls(convertSource, tools, userRequest);
    const directTcs = directResult.toolCalls as unknown as ToolCallPayload[];
    if (directTcs.length > 0) {
      // 只有真的提取到工具调用才采纳它的文本，避免污染 parsedText
      parsedText = directResult.text;
      parsedToolCalls = directTcs;
      logger.info(`[tool_calls] 直接转换：${parsedToolCalls.length} 个工具调用`);
    }
  }

  if (parsedToolCalls.length === 0 && tools.length > 0 && convertSource) {
    const convResult = convertTextToToolCalls(convertSource, tools);
    const convTcs = convResult.toolCalls as unknown as ToolCallPayload[];
    if (convTcs.length > 0) {
      parsedText = convResult.text;
      parsedToolCalls = convTcs;
      logger.info(`[tool_calls] 文本转换器：${parsedToolCalls.length} 个工具调用`);
    }
  }

  /* ===== 步骤 4：两轮策略（reparse）=====
   * 材料 = SSE 回答 + SSE 思考 + DOM 拼接（`buildReparseInput` 合并去重）。
   * ⚠️ 门槛**不能**写成「full_response 非空」：模型只把工具意图写在**思考**里
   * （`type=text` 为空、DOM 又因「思考中」被拒）时，材料明明在思考文本里
   * 却会被整段跳过 → 整轮零产出。 */
  const reparseMaterial = buildReparseInput(source, fullResponse);
  if (parsedToolCalls.length === 0 && tools.length > 0 && reparseMaterial) {
    if (reparseMaterial.trim().length < 10) {
      logger.info(`[tool_calls] 可转换材料太短(${reparseMaterial.length}字符)，跳过两轮策略`);
    } else if (deadlineTs - Date.now() < REPARSE_MIN_BUDGET * 1000) {
      // 剩余时间不够再走一轮完整对话 → 直接放行首轮的文本回答，
      // 至少让客户端看到内容，而不是被中间件在 300s 处掐断。
      logger.warn(
        `[tool_calls] 剩余时间不足(${((deadlineTs - Date.now()) / 1000).toFixed(0)}s < ` +
          `${REPARSE_MIN_BUDGET.toFixed(0)}s)，跳过两轮策略，直接返回文本回答`,
      );
    } else {
      logger.info(
        `[tool_calls] 启动两轮对话策略（fallback），材料 ${reparseMaterial.length} 字符` +
          `（SSE回答=${source.length}, 拼接=${fullResponse.length}，差额来自 SSE 思考）`,
      );
      try {
        const userRequest = lastMessage
          ? getTextContent(messageToDict(lastMessage as ChatMessage).content)
          : '';
        const conversationHistory =
          prepared.request.messages.length > 0
            ? formatMessagesAsText(prepared.request.messages as unknown as ChatMessage[])
            : '';

        const reparseMsg = buildReparsePrompt(reparseMaterial, tools, {
          userRequest,
          conversationHistory,
        });

        const reparseRequest: ChatRequest = {
          message: reparseMsg,
          model: rawRequest.model,
          stream: false,
          // 与首轮共享同一个截止时间，同时给 reparse 自身一个上限：
          // 实测它会一直「思考」到被总预算掐断却什么都没产出。
          deadlineTs: Math.min(deadlineTs, Date.now() + REPARSE_MAX_BUDGET * 1000),
          // 用**独立页面**跑转换请求：否则它会把主页面上的会话切走，
          // 主会话上下文丢失、会话复用失效。
          context: { use_aux_page: true },
        };

        let reparseResponse = '';
        for await (const [chunk] of streamWithFailover(
          modelRouter,
          rawRequest.model,
          reparseRequest,
          historyDb,
          `${requestId}#reparse`,
        )) {
          reparseResponse += chunk.content ?? '';
        }

        const reparseParsed = parseToolCallsFromText(reparseResponse, toolMaps);
        const reparseTcs = reparseParsed.toolCalls as unknown as ToolCallPayload[];
        if (reparseTcs.length > 0) {
          parsedToolCalls = reparseTcs;
          parsedText = `正在执行 ${reparseTcs.length} 个操作：${reparseTcs
            .map((tc) => tc.function.name)
            .join(', ')}`;
          logger.info(`[tool_calls] 两轮策略成功：${reparseTcs.length} 个工具调用`);
        } else {
          logger.info('[tool_calls] 两轮策略未提取到工具调用');
        }
      } catch (error) {
        logger.warn(`[tool_calls] 两轮策略失败: ${errorMessage(error)}`);
      }
    }
  }

  /* ===== 步骤 5：自驱动续跑（仅流式分支）=====
   * 模型「只给计划、不调工具」时客户端会直接结束回合，
   * 用户看到「读了半天却没改文件、任务终止」。这里识别这类回答，
   * 自己再驱动一轮，让它把刚说的下一步变成工具调用。 */
  if (options.selfContinue) {
    const remaining = deadlineTs - Date.now();
    if (parsedToolCalls.length === 0 && tools.length > 0 && looksUnfinishedAnswer(parsedText) && remaining >= CONTINUE_MIN_BUDGET * 1000) {
      logger.warn(
        `[tool_calls] 回答疑似「只说计划没动手」，启动自驱动续跑` +
          `（剩余 ${(remaining / 1000).toFixed(0)}s）`,
      );
      try {
        const contPrompt = CONTINUE_PROMPT.replace('{answer}', parsedText.slice(0, 4000)).replace(
          '{tools}',
          // ⚠️ 必须带 workspace_path / known_file_paths：不带时模型会编造出
          //    `/workspace/core/xxx.py` 这种路径，客户端读不到文件，续跑等于白跑。
          formatToolsAsText(tools, {
            workspacePath,
            knownFilePaths: knownFilePaths.length > 0 ? knownFilePaths : undefined,
          }),
        );

        const contRequest: ChatRequest = {
          message: contPrompt,
          model: rawRequest.model,
          stream: false,
          deadlineTs: Math.min(deadlineTs, Date.now() + CONTINUE_MAX_BUDGET * 1000),
          context: { use_aux_page: true },
        };

        let contResponse = '';
        for await (const [chunk] of streamWithFailover(
          modelRouter,
          rawRequest.model,
          contRequest,
          historyDb,
          `${requestId}#continue`,
        )) {
          contResponse += chunk.content ?? '';
        }

        let contTcs = parseToolCallsFromText(contResponse, toolMaps).toolCalls as unknown as ToolCallPayload[];
        // 过滤器同样要走一遍：编造的工具名/占位符不能下发
        if (contTcs.length > 0) contTcs = filterPlaceholderToolCalls(contTcs).valid;
        if (contTcs.length > 0) contTcs = filterUnknownToolCalls(contTcs, tools).valid;
        if (contTcs.length > 0) {
          const { repaired, reroutes } = repairToolCallBySignature(contTcs, tools);
          contTcs = repaired;
          for (const r of reroutes) {
            logger.warn(
              `[tool_calls] 按参数签名改派工具: ${r.from} → ${r.to}` +
                `（未知参数 ${r.unknownKeys.join(', ')}）`,
            );
          }
        }

        if (contTcs.length > 0) {
          parsedToolCalls = contTcs;
          const cnames = contTcs.map((tc) => tc.function.name);
          parsedText = `正在执行 ${contTcs.length} 个操作：${cnames.join(', ')}`;
          logger.info(`[tool_calls] 自驱动续跑成功：${contTcs.length} 个工具调用 ${cnames.join(', ')}`);
        } else {
          logger.warn(
            `[tool_calls] 自驱动续跑仍未产出工具调用（回答长度=${contResponse.length}），保持原文本回答`,
          );
        }
      } catch (error) {
        logger.warn(`[tool_calls] 自驱动续跑失败: ${errorMessage(error)}`);
      }
    } else if (parsedToolCalls.length === 0 && tools.length > 0 && looksUnfinishedAnswer(parsedText)) {
      logger.warn(
        `[tool_calls] 回答疑似「只说计划没动手」，但剩余时间` +
          `(${(remaining / 1000).toFixed(0)}s) 不足 ${CONTINUE_MIN_BUDGET.toFixed(0)}s，跳过自驱动续跑`,
      );
    }
  }

  /* ===== 步骤 6：路径纠正（仅流式分支）===== */
  if (options.fixPaths && parsedToolCalls.length > 0 && (workspacePath || knownFilePaths.length > 0)) {
    for (const tc of parsedToolCalls) {
      const argsStr = tc.function.arguments;
      if (!argsStr) continue;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const filePath = String(args['file_path'] ?? args['filePath'] ?? args['path'] ?? '');
      if (!filePath) continue;

      // 检测编造路径（排除已以 workspace_path 开头的路径）
      const isFabricated =
        !(workspacePath && filePath.startsWith(workspacePath)) &&
        FABRICATED_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));

      if (!isFabricated || !workspacePath || workspacePath.length <= 5) continue;

      const filename = basename(filePath);

      // 优先从已知路径里找同名文件
      let corrected: string | null =
        knownFilePaths.find((kp) => basename(kp) === filename) ?? null;

      if (!corrected) {
        corrected = join(workspacePath, filename);
        // 验证纠正后的路径是否存在（避免编造新路径）
        if (!existsSync(corrected)) {
          logger.warn(`[tool_calls] 纠正后的路径不存在: ${corrected}, 保持原路径 ${filePath}`);
          continue;
        }
      }

      logger.warn(`[tool_calls] 路径校验：检测到编造路径 ${filePath}，纠正为 ${corrected}`);

      if ('file_path' in args) args['file_path'] = corrected;
      if ('filePath' in args) args['filePath'] = corrected;
      if ('path' in args) args['path'] = corrected;
      tc.function.arguments = JSON.stringify(args);
    }
  }

  /* ===== 步骤 7：SearchReplace 参数校验（仅流式分支）===== */
  if (options.validateSearchReplace && parsedToolCalls.length > 0) {
    const valid: ToolCallPayload[] = [];
    for (const tc of parsedToolCalls) {
      if (tc.function.name === 'SearchReplace') {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        if (!args['old_str']) {
          logger.warn('[tool_calls] SearchReplace old_str 为空，丢弃该工具调用');
          continue;
        }
      }
      valid.push(tc);
    }
    if (valid.length < parsedToolCalls.length) parsedToolCalls = valid;
  }

  /* ===== 步骤 8：过滤（占位符 / 未知工具名）+ 回退 ===== */
  const beforeFilter = parsedToolCalls.length;

  if (parsedToolCalls.length > 0) {
    // 占位符过滤：丢弃参数为示例文本（如 "真实文件路径"/"文件内容"）的调用
    parsedToolCalls = filterPlaceholderToolCalls(parsedToolCalls).valid;
  }
  if (parsedToolCalls.length > 0) {
    // 未知工具名过滤：AI 编造的工具名（如 "工具名称"）客户端无法执行
    parsedToolCalls = filterUnknownToolCalls(parsedToolCalls, tools).valid;
  }
  if (parsedToolCalls.length > 0) {
    /* 按参数签名纠正选错的工具：模型想创建文件却调 edit_file 并套用
     * write_file 的签名（实测：edit_file(path, content)）—— 客户端会拒收
     * 「未知参数 content」。若恰好只有一个已声明工具的签名装得下这些参数
     * （write_file），就改派过去，省掉一轮注定失败的往返。 */
    const { repaired, reroutes } = repairToolCallBySignature(parsedToolCalls, tools);
    parsedToolCalls = repaired;
    for (const r of reroutes) {
      logger.warn(
        `[tool_calls] 按参数签名改派工具: ${r.from} → ${r.to}` +
          `（未知参数 ${r.unknownKeys.join(', ')}）`,
      );
    }
  }

  if (beforeFilter > 0 && parsedToolCalls.length === 0 && fullResponse) {
    /* 全部被过滤 → 必须回退为**真实文本**。
     * 绝不能保留「正在执行 N 个操作：X」这类摘要：客户端会把它当作最终回答显示
     * 然后停止，不再继续执行任何工具（表现为「返回工具调用后客户端没反应」）。 */
    logger.warn('[tool_calls] 全部工具调用均被过滤，回退为完整文本响应');
    parsedText = sourceFromSse && source ? source : fullResponse;
  }

  /* ===== 步骤 9：批量下发策略 =====
   * - **全是只读操作**（read_file / list_dir / search_content …）→ 全部下发，
   *   客户端会并行执行。这类调用不改变任何状态，不存在互相影响；
   *   实测模型一次就想读 4 个文件，若只发第一个，24 轮上限几下就被耗光。
   * - 只要包含**写/改/执行**类 → 仍然只发第一个：
   *   同一回复里第二个 SearchReplace 的 `old_str` 可能因为第一个的修改而不再匹配，
   *   必须让 AI 看到第一个的结果后再生成第二个。 */
  if (parsedToolCalls.length > 1) {
    const names = parsedToolCalls.map((tc) => tc.function.name);
    if (names.every((n) => isReadOnlyTool(n))) {
      logger.info(
        `[tool_calls] ${parsedToolCalls.length} 个调用均为只读操作（${names.join(', ')}），` +
          '全部下发（客户端并行执行）',
      );
    } else {
      logger.info(
        `[tool_calls] 有 ${parsedToolCalls.length} 个工具调用（含写操作，names=${names.join(', ')}），` +
          `只发第一个 (${names[0]})，其余丢弃`,
      );
      parsedToolCalls = parsedToolCalls.slice(0, 1);
    }
  }

  // 有工具调用时，文本过长只发简短摘要（避免代码/文件内容溢出到聊天里）
  if (parsedToolCalls.length > 0 && parsedText.length > 200) {
    parsedText = `正在执行 ${parsedToolCalls.length} 个操作：${parsedToolCalls
      .map((tc) => tc.function.name)
      .join(', ')}`;
  }

  /* ===== 步骤 10：保险 —— 检测「回答与本项目无关」=====
   * 只对「无工具调用的纯文本回答」做检查（有工具调用时会话在正常推进）。 */
  if (parsedText && parsedToolCalls.length === 0) {
    const mismatchHint = detectMismatchedAnswer(parsedText, workspacePath);
    if (mismatchHint) {
      logger.warn(
        `[guard] 回答与本项目不匹配（工作目录=${workspacePath}），已在正文前附加提示。` +
          `回答开头: ${JSON.stringify(parsedText.slice(0, 120))}`,
      );
      parsedText = mismatchHint + parsedText;
    }
  }

  logger.info(
    `[tool_calls] 最终结果: 文本长度=${parsedText.length}, 工具调用数=${parsedToolCalls.length}`,
  );

  return {
    parsedText,
    parsedToolCalls,
    finishReason: parsedToolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

/* ==================================================================== */
/* 阶段 3：流式分支                                                    */
/* ==================================================================== */

/** 从 prepare 结果构造发给 Provider 的 `ChatRequest`。 */
function buildChatRequest(prepared: PreparedRequest, extraContext: Record<string, unknown> = {}): ChatRequest {
  return {
    message: prepared.messageText,
    model: prepared.request.model,
    conversation_id: prepared.conversationId ?? undefined,
    stream: prepared.request.stream,
    deadlineTs: prepared.deadlineTs,
    /* 会话复用三元组：
     *   session_key   —— 逻辑会话 ID（provider 用它判断能否沿用当前网页会话）
     *   delta_message —— 只含「新增消息」的提示词
     *   full_message  —— 完整提示词；provider 无法复用网页会话时改发它，
     *                    保证「增量协议」永远不会丢掉上下文 */
    context: {
      session_key: prepared.conversationId,
      delta_message: prepared.deltaText,
      full_message: prepared.messageText,
      ...extraContext,
    },
  };
}

/**
 * 流式生成 SSE 文本（每个元素是一段可以直接写进连接的字符串）。
 *
 * 抽成生成器是为了能单独测试 —— 它不碰 `reply`。
 *
 * ⚠️ 三条不可违反的输出顺序：
 * 1. 有工具调用时：`role` → `content` → `tool_calls` → `finish(tool_calls)` → `[DONE]`；
 * 2. `finish_reason` **只能出现一次**；
 * 3. `tool_calls` 必须在 `[DONE]` **之前**（客户端收到 `[DONE]` 就不再解析）。
 */
export async function* streamChatCompletion(
  prepared: PreparedRequest,
  modelRouter = getModelRouter(),
  historyDb = getHistoryDb(),
): AsyncGenerator<string> {
  const { requestId, request: rawRequest, conversationId, messageText, rawMessageText } = prepared;
  const model = rawRequest.model;
  const hasTools = Boolean(rawRequest.tools && rawRequest.tools.length > 0);
  const toolMaps = createToolMaps((rawRequest.tools ?? []) as ToolDefinition[]);

  let fullResponse = '';
  let currentPlatform: string | null = null;
  let parsedText = '';
  let parsedToolCalls: ToolCallPayload[] = [];
  let parseSource = '';
  let parseFromSse = false;
  const startTime = Date.now();

  logRoundStart(requestId, 1, extractUserQuestion(rawRequest.messages as unknown as ChatMessage[]));

  try {
    logAiRequest({
      requestId,
      platform: model,
      messages: rawRequest.messages as unknown as Array<Record<string, unknown>>,
      workspacePath: prepared.workspacePath,
    });

    const chatRequest = buildChatRequest(prepared);
    // 有工具时**先缓冲完整回复**，解析出 tool_calls 后再发（保证在 [DONE] 前发 tool_calls 分片）
    for await (const [chunk, platform] of streamWithFailover(
      modelRouter,
      model,
      chatRequest,
      historyDb,
      requestId,
    )) {
      currentPlatform = platform;
      fullResponse += chunk.content ?? '';
    }

    if (hasTools) {
      // 解析源：只要 SSE 回答非空就用它 —— 它是未经渲染的**最终回答**（type=text），
      // 而 fullResponse 可能混入 DOM 里的**思考过程**（type=think）。
      // ⚠️ 绝不能按长度取舍：曾出现 SSE 回答仅 77 字符、而 DOM 拼接出 527 字符思考文本，
      //    于是错误地选用了思考文本。
      parseSource = fullResponse;
      parseFromSse = false;
      const sseText = getLastRawSse().text;
      if (sseText) {
        parseSource = sseText;
        parseFromSse = true;
        logger.info(
          `[tool_calls] 使用 SSE 保真文本解析工具调用 ` +
            `(SSE回答=${sseText.length} vs 拼接=${fullResponse.length})`,
        );
      }

      const outcome = await parseAndRecoverToolCalls({
        parseSource,
        fullResponse,
        fromSse: parseFromSse,
        currentPlatform,
        prepared,
        modelRouter,
        historyDb,
        toolMaps,
        options: { fixPaths: true, validateSearchReplace: true, selfContinue: true },
      });
      parsedText = outcome.parsedText;
      parsedToolCalls = outcome.parsedToolCalls;

      /* ===== 空响应检测 =====
       * 文本=0 且工具调用=0 时**不能静默结束**（旧实现只发一个空 delta）：
       * 客户端收到空回复会表现为「AI 没反应」，用户无法区分「卡住」与「失败」。 */
      if (!parsedText && parsedToolCalls.length === 0 && !fullResponse) {
        logger.warn(
          '[tool_calls] 检测到空响应（首轮无正文、各策略均未恢复出内容），向客户端说明原因后结束',
        );
        const platform = currentPlatform ?? model;
        yield contentChunk({
          id: requestId,
          model,
          role: 'assistant',
          content:
            `[${platform}] 本轮未产出任何可用内容` +
            '（模型没有生成正文，从思考/转换中也未恢复出工具调用）。' +
            '请重试；若反复出现，建议换平台或把提问拆小。',
        });
        yield contentChunk({ id: requestId, model, content: '', finishReason: 'stop' });
        yield DONE;
        return;
      }

      // 发送：role → content → tool_calls → finish
      if (parsedText || parsedToolCalls.length > 0) {
        yield roleChunk({ id: requestId, model });
      }
      if (parsedText) {
        yield contentChunk({ id: requestId, model, content: parsedText });
      }
      if (parsedToolCalls.length > 0) {
        // 所有 tool_calls 合成**一个** chunk，避免客户端重复显示「正在执行」
        yield toolCallsChunk({ id: requestId, model, toolCalls: parsedToolCalls });
        logger.info(`解析到 ${parsedToolCalls.length} 个工具调用`);
      } else if (!parsedText) {
        // 没有工具调用也没有解析文本 → 直接发原始文本
        yield roleChunk({ id: requestId, model });
        yield contentChunk({
          id: requestId,
          model,
          content: parseFromSse && parseSource ? parseSource : fullResponse,
        });
      }
      yield contentChunk({
        id: requestId,
        model,
        content: '',
        finishReason: parsedToolCalls.length > 0 ? 'tool_calls' : 'stop',
      });
      yield DONE;
    } else {
      // 无工具：正常逐 chunk 转发（延迟更低）
      for await (const [chunk, platform] of streamWithFailover(
        modelRouter,
        model,
        chatRequest,
        historyDb,
        requestId,
      )) {
        currentPlatform = platform;
        fullResponse += chunk.content ?? '';
        yield contentChunk({ id: requestId, model, content: chunk.content ?? '' });
      }
      yield contentChunk({ id: requestId, model, content: '', finishReason: 'stop' });
      yield DONE;
    }

    /* ===== 记录历史 =====
     * 优先存 SSE 全文：`fullResponse` 是流式增量拼接的结果，
     * 模型中途改写回答时会把「旧草稿 + 最终答案」都留在里面，存进历史会污染后续轮次。 */
    if (conversationId && fullResponse) {
      const historyText = parseFromSse && parseSource ? parseSource : fullResponse;
      await historyDb.addMessage({
        conversationId,
        role: 'user',
        content: messageText,
        platform: currentPlatform,
        model,
      });
      await historyDb.addMessage({
        conversationId,
        role: 'assistant',
        content: historyText,
        platform: currentPlatform,
        model,
      });
      // ⚠️ 只在**发送成功**后记录（走到这里说明流已正常结束），下次同会话只补发增量
      if (currentPlatform) {
        rememberSessionSend(
          conversationId,
          rawRequest.messages as unknown as ChatMessage[],
          currentPlatform,
        );
      }
    }

    const finishReason = parsedToolCalls.length > 0 ? 'tool_calls' : 'stop';
    logger.info(`[${requestId}] ========== 响应完成 ==========`);
    logger.info(
      `[${requestId}] 平台: ${currentPlatform}, 完成原因: ${finishReason}, ` +
        `响应长度: ${fullResponse.length}, 工具调用数: ${parsedToolCalls.length}`,
    );
    for (const tc of parsedToolCalls) {
      logger.info(`[${requestId}] 工具: ${tc.function.name}`);
    }

    /* ===== 后台预压缩 =====
     * 此刻客户端正在执行工具（读文件通常要几秒到几十秒），正好拿这段空档把本轮历史
     * 折进摘要缓存，让下一轮的压缩耗时降为 0（原本要 25~117s）。 */
    schedulePrecompress(rawMessageText, conversationId, modelRouter, model, historyDb, requestId);

    const duration = (Date.now() - startTime) / 1000;
    logClientResponse({
      requestId,
      model: currentPlatform ?? model,
      finishReason,
      content: hasTools ? parsedText : fullResponse,
      toolCalls: hasTools ? (parsedToolCalls as unknown as Array<Record<string, unknown>>) : undefined,
      duration,
    });
    logApiResponse({
      requestId,
      model: currentPlatform ?? model,
      content: hasTools ? parsedText : fullResponse,
      toolCalls: hasTools ? (parsedToolCalls as unknown as Array<Record<string, unknown>>) : undefined,
      finishReason,
      duration,
    });
  } catch (error) {
    const message = errorMessage(error);
    logger.error(`流式响应失败: ${message}`);
    debugLogError(requestId, message, `平台=${currentPlatform}, 已收到=${fullResponse.length}字符`);
    logApiError(requestId, message, `平台=${currentPlatform}, 已收到=${fullResponse.length}字符`);
    yield contentChunk({ id: requestId, model, content: `[ERROR] ${message}`, finishReason: 'stop' });
    yield DONE;
  }
}

/* ==================================================================== */
/* 阶段 4：非流式分支                                                  */
/* ==================================================================== */

/**
 * 非流式聊天。
 *
 * ⚠️ 与流式分支的**故意保留**的差异（Python 原样如此，移植时未改动）：
 * - 非流式**不做**路径纠正、**不做** SearchReplace 校验、**不做**自驱动续跑。
 *   流式分支才跑那三步。若将来要统一，请注意这属于行为变更。
 */
export async function nonStreamChatCompletion(
  prepared: PreparedRequest,
  modelRouter = getModelRouter(),
  historyDb = getHistoryDb(),
): Promise<Record<string, unknown>> {
  const { requestId, request: rawRequest, conversationId, messageText, rawMessageText } = prepared;
  const model = rawRequest.model;
  const toolMaps = createToolMaps((rawRequest.tools ?? []) as ToolDefinition[]);
  const requestPool = getRequestPool();

  const chatRequest = buildChatRequest(prepared);

  await requestPool.addRequest({
    requestId,
    platform: model,
    model,
    message: chatRequest.message,
    conversationId,
  });

  let currentPlatform: string | null = null;

  try {
    logRoundStart(requestId, 1, extractUserQuestion(rawRequest.messages as unknown as ChatMessage[]));

    let fullResponse = '';
    logger.info(`[${requestId}] 开始调用 _stream_with_failover (非流式), model=${model}`);

    for await (const [chunk, platform] of streamWithFailover(
      modelRouter,
      model,
      chatRequest,
      historyDb,
      requestId,
    )) {
      currentPlatform = platform;
      fullResponse += chunk.content ?? '';
    }

    logger.info(`[${requestId}] _stream_with_failover 结束，full_response_len=${fullResponse.length}`);
    await requestPool.markCompleted(requestId, fullResponse);

    if (conversationId && fullResponse) {
      await historyDb.addMessage({
        conversationId,
        role: 'user',
        content: messageText,
        platform: currentPlatform,
        model,
      });
      await historyDb.addMessage({
        conversationId,
        role: 'assistant',
        content: fullResponse,
        platform: currentPlatform,
        model,
      });
      if (currentPlatform) {
        rememberSessionSend(
          conversationId,
          rawRequest.messages as unknown as ChatMessage[],
          currentPlatform,
        );
      }
    }

    // 解析源：优先 SSE 保真文本
    let parseSource = fullResponse;
    let parseFromSse = false;
    const sseText = getLastRawSse().text;
    if (sseText) {
      parseSource = sseText;
      parseFromSse = true;
      logger.info(
        `[tool_calls] 使用 SSE 保真文本解析工具调用 ` +
          `(SSE回答=${sseText.length} vs 拼接=${fullResponse.length})`,
      );
    }

    const outcome = await parseAndRecoverToolCalls({
      parseSource,
      fullResponse,
      fromSse: parseFromSse,
      currentPlatform,
      prepared,
      modelRouter,
      historyDb,
      toolMaps,
      options: { fixPaths: false, validateSearchReplace: false, selfContinue: false },
    });

    const responseMessage: Record<string, unknown> = { role: 'assistant' };
    if (outcome.parsedText) {
      responseMessage['content'] = outcome.parsedText;
    } else if (outcome.parsedToolCalls.length === 0) {
      // 同样优先 SSE 全文（fullResponse 可能是改写草稿的拼接乱码）
      responseMessage['content'] = parseFromSse && parseSource ? parseSource : fullResponse;
    }
    if (outcome.parsedToolCalls.length > 0) {
      responseMessage['tool_calls'] = outcome.parsedToolCalls;
    }

    logApiResponse({
      requestId,
      model,
      content: (responseMessage['content'] as string | undefined) ?? null,
      toolCalls:
        (responseMessage['tool_calls'] as Array<Record<string, unknown>> | undefined) ?? null,
      finishReason: outcome.finishReason,
    });

    logAiPlatformResponseComplete({
      requestId,
      platform: currentPlatform ?? 'unknown',
      roundNum: 1,
      rawText: fullResponse,
    });

    schedulePrecompress(rawMessageText, conversationId, modelRouter, model, historyDb, requestId);

    return {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: responseMessage,
          finish_reason: outcome.finishReason,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    await requestPool.markFailed(requestId, message);
    logApiError(requestId, message, `模型=${model}, 平台=${currentPlatform}`);
    throw error;
  }
}

/* ==================================================================== */
/* 路由注册                                                            */
/* ==================================================================== */

/**
 * 注册 `/chat/completions`。
 *
 * 参数校验用 zod（等价于 FastAPI 的 pydantic 校验）；失败返回 422 与
 * 与 Python 一致的错误体形状。
 */
export function registerChatRoutes(app: import('fastify').FastifyInstance): void {
  app.post('/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    /* ===== 参数校验 =====
     * 用 `safeParse` 而不是 Fastify 的 schema：需要复刻 Python 的错误体形状
     * （`{error: {message, type, code, param}}`，`param` 取出错字段名）。 */
    const { chatCompletionRequestSchema } = await import('../types/openai.js');
    const parsed = chatCompletionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply.code(422).send({
        error: {
          message: `请求参数错误: ${first?.message ?? '未知错误'}`,
          type: 'invalid_request_error',
          code: null,
          param: String(first?.path?.[first.path.length - 1] ?? ''),
        },
      });
    }
    const body = parsed.data as ChatCompletionRequest;

    try {
      const result = await preparePrompt(body, request);

      // ===== 轮数上限截停 =====
      if (result.kind === 'limit_exceeded') {
        if (body.stream) {
          reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          reply.hijack();
          reply.raw.write(
            contentChunk({ id: 'limit', model: body.model, role: 'assistant', content: result.message }),
          );
          reply.raw.write(DONE);
          reply.raw.end();
          return reply;
        }
        return reply.code(200).send({
          id: 'limit',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.message },
              finish_reason: 'stop',
            },
          ],
        });
      }

      const prepared = result.prepared;

      // ===== 流式 =====
      if (body.stream) {
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          // 反向代理（nginx）默认会缓冲响应，SSE 必须显式关闭缓冲
          'x-accel-buffering': 'no',
        });
        reply.hijack();

        try {
          for await (const piece of streamChatCompletion(prepared)) {
            if (reply.raw.writableEnded) break;
            reply.raw.write(piece);
          }
        } catch (error) {
          logger.error(`[${prepared.requestId}] SSE 写出失败: ${errorMessage(error)}`);
        } finally {
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return reply;
      }

      // ===== 非流式 =====
      const response = await nonStreamChatCompletion(prepared);
      return reply.code(200).send(response);
    } catch (error) {
      const message = errorMessage(error);
      logger.error(`聊天完成失败: ${message}`);
      debugLogError('unknown', message, `模型=${body.model}, 消息数=${body.messages.length}`);
      logApiError('unknown', message, `模型=${body.model}, 消息数=${body.messages.length}`);
      return reply.code(500).send({ error: { message, type: 'server_error', code: 'internal_error' } });
    }
  });
}

