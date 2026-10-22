/**
 * 跨平台故障切换 —— `legacy-python/src/api/routes.py` 第 1038~1265 行的移植。
 *
 * 包含：
 * - {@link buildReparseInput}：构造「两轮策略」的输入（合并 SSE 回答 + 思考 + DOM）；
 * - {@link streamWithFailover}：带故障切换的流式生成器。
 *
 * ## ⚠️ 本文件最重要的一条约束：生成器**必须被关闭**
 * Python 用 `async with aclosing(provider.chat_stream(...))` 包住 `async for`，
 * 理由写在原注释里：「确保提前退出时也关闭 provider 生成器，否则 provider 内部的
 * 串行锁（`self._lock`）不会释放，**后续请求会永久阻塞**」。
 *
 * TypeScript 的 `for await...of` **在语法层面**就保证这件事：无论循环是正常结束、
 * `break`、还是循环体抛异常，迭代器的 `return()` 都会被调用 ——
 * 而 `async *chatStream()` 里的 `finally`（释放锁）一定执行。
 * 所以这里不需要 `aclosing` 的等价物，**但绝不能把 `for await` 换成手动
 * `while (true) { iterator.next() }`**，那样就丢掉了这层语言级保障。
 */
import { notifyPlatformUsed } from '../server/session-refresh.js';
import type { BaseProvider } from '../providers/base.js';
import { getLastRawSse } from '../providers/chatglm-sse.js';
import type { ChatRequest, ChatResponse } from '../providers/base.js';
import type { HistoryDB } from '../controllers/history-db.js';
import type { ModelRouter } from '../controllers/router.js';
import { logger as baseLogger } from '../log/logger.js';
import { logAiPlatformRequest } from '../log/api-logger.js';
import { errorMessage, PlatformUnavailableError } from '../utils/errors.js';
import {
  extractPlatformName,
  formatHistoryContext,
  platformOf,
  truncatePromptForBrowser,
} from './helpers.js';

const logger = baseLogger;

/** 支持网页会话复用（增量发送）的平台。 */
const SESSION_REUSE_PLATFORMS: ReadonlySet<string> = new Set(['chatglm']);

/**
 * 构造「两轮对话」策略的输入文本。
 *
 * 与展示给客户端的文本**目的不同**：
 * - 展示：只能用 SSE 的最终回答（`type=text`），不能把思考过程泄漏出去；
 * - 恢复工具调用：**信号越多越好**。
 *
 * 实测失败案例：模型把完整工具意图写在**思考**里（`type=think` 有 3339 字符，
 * 例如「我需要：1. 用 list_dir 查看项目结构 并读取关键文件：core/backtest_engine.py…」），
 * 而最终回答只有 77 个字符（没有 `<tool_call>`）。
 * 此时若只把 77 字符的回答交给转换器，必然恢复不出任何工具调用。
 *
 * 因此这里把 SSE 回答、SSE 思考、DOM 拼接文本合并去重后一起交给转换器。
 */
export function buildReparseInput(parseSource: string, fullResponse: string): string {
  // 思考内容来自 provider 写下的「主轮全局」。
  // ⚠️ 辅助通道不写这些全局（见 chatglm.ts 的说明），所以这里拿到的永远
  //    是**主轮**的思考，不会被并行的压缩请求污染。
  let think = '';
  try {
    think = getLastRawSse().think ?? '';
  } catch {
    // 忽略：拿不到思考就用剩下的两个信号
  }

  let ordered: string[] = [];
  for (const piece of [parseSource, think, fullResponse]) {
    const p = (piece ?? '').trim();
    if (!p) continue;
    // 已包含该片段，跳过
    if (ordered.some((q) => p === q || q.includes(p))) continue;
    // 新片段包含旧片段 → 用更完整的替换
    ordered = ordered.filter((q) => !p.includes(q));
    ordered.push(p);
  }
  return ordered.join('\n\n');
}

/** 故障切换流的一步：`[响应分片, 平台名]`。 */
export type FailoverChunk = [ChatResponse, string];

/**
 * 带跨平台故障切换的流式响应生成器。
 *
 * 策略：
 * - `mix` 模型：按优先级依次尝试各平台，当前平台失败后切换到下一个候选平台。
 *   跨平台切换时从 `history_db` 注入最近 N 条历史作为上下文。
 * - 平台名模型（如 `chatglm`）：直接调用对应平台的 Browser Provider。
 *
 * @throws {PlatformUnavailableError} 所有候选平台都失败
 */
export async function* streamWithFailover(
  modelRouter: ModelRouter,
  model: string,
  chatRequest: ChatRequest,
  historyDb: HistoryDB,
  requestId = 'unknown',
): AsyncGenerator<FailoverChunk> {
  const originalMessage = chatRequest.message;
  const convId = chatRequest.conversation_id ?? null;

  /* ===== 辅助任务（压缩 / 两轮转换 / 自驱动续跑）走「独立辅助通道」=====
   * 独立通道 = 同平台的**另一个账号** + 独立 context 页面 + 独立锁，
   * 因此可以与主对话真并行，也不会占用主账号的并发额度。
   * 拿不到独立通道时列表为空 → 完全保持原行为（回落主候选，串行）。 */
  const reqCtx = chatRequest.context ?? {};
  const wantAux = Boolean(reqCtx['use_aux_page']);
  /* 记录主通道平台，辅助通道据此**优先同平台**的另一账号（`mix` 不算平台）。 */
  modelRouter.noteMainPlatform(model);
  const auxCandidates = wantAux
    ? modelRouter.getAuxCandidates(model === 'mix' ? undefined : model)
    : [];

  logger.info(
    `[_stream_with_failover] 入口, model=${model}` +
      (auxCandidates.length > 0
        ? `（辅助任务 → 独立通道 ${auxCandidates.map((c) => c[0]).join(',')}）`
        : ''),
  );

  if (model === 'mix') {
    logger.info('[_stream_with_failover] 进入 mix 分支');

    const candidates = await modelRouter.getMixCandidates();
    // 独立通道优先；它万一失败再回落到主候选（此时与主对话串行，
    // 功能不退化，只是会慢一些）
    const all = auxCandidates.length > 0 ? [...auxCandidates, ...candidates] : candidates;

    if (all.length === 0) {
      throw new PlatformUnavailableError(
        'mix',
        '所有平台均不可用，请运行 `npx webaiapi login chatglm` 捕获凭证',
      );
    }

    let lastError: unknown = null;

    for (let idx = 0; idx < all.length; idx += 1) {
      const candidate = all[idx];
      if (!candidate) continue;
      const [platform, provider] = candidate;

      /* ===== 会话复用：只补发增量 =====
       * 仅对**第一个候选平台**且该平台支持网页会话复用（chatglm）时启用；
       * 跨平台切换时绝不能用增量 —— 另一个平台的会话里没有历史。 */
      const ctx = chatRequest.context ?? {};
      const delta = typeof ctx['delta_message'] === 'string' ? ctx['delta_message'] : '';
      if (delta && idx === 0 && SESSION_REUSE_PLATFORMS.has(platformOf(platform))) {
        chatRequest.message = delta;
        logger.info(
          `[session] 会话 ${convId} 复用 ${platform} 网页会话，` +
            `只发增量 ${delta.length} 字符（完整提示词 ${originalMessage.length} 字符）`,
        );
      } else if (idx === 0) {
        chatRequest.message = originalMessage;
      }

      /* 跨平台切换时注入历史上下文（首次尝试不注入，依赖平台自身 session）。
       * ⚠️ 辅助任务（压缩/转换）的提示词是**自包含**的：往里塞历史上下文
       *    只会污染它（例如把对话历史塞进「压缩这段历史」的提示里）。 */
      if (idx > 0 && convId && !wantAux) {
        const history = await historyDb.getRecentMessages(convId, 20);
        if (history.length > 0) {
          const context = formatHistoryContext(history as unknown as Array<Record<string, unknown>>);
          chatRequest.message = truncatePromptForBrowser(
            `${context}\n\n[当前消息]\n${originalMessage}`,
          );
          logger.info(`mix 跨平台切换到 ${platform}，注入 ${history.length} 条历史上下文`);
        } else {
          chatRequest.message = originalMessage;
          logger.info(`mix 跨平台切换到 ${platform}（无历史可注入）`);
        }
      }

      // ⚠️ `started` 必须声明在 try **之外**：TS 的 `catch` 是独立作用域，
      //    在 `try` 里用 `let` 声明的变量在 `catch` 中不可见
      //    （Python 的 try/except 不引入新作用域，所以原实现写在 try 里也没问题）。
      let started = false;

      try {
        // API 日志：记录发送给 AI 平台的完整内容（发送前记录）
        logAiPlatformRequest({
          requestId,
          platform,
          messages: [{ role: 'user', content: chatRequest.message }],
        });

        let emptyError: string | null = null;

        // ⚠️ `for await` 在 break/throw/return 时都会调用生成器的 return()
        //    → provider 的 finally 释放串行锁。不要改成手动 next()。
        for await (const chunk of provider.chatStream(chatRequest)) {
          // 纯错误（无任何内容）视为本次尝试失败，允许切换到下一个平台
          if (chunk.error && !(chunk.content ?? '').trim()) {
            emptyError = chunk.error;
            break;
          }
          started = true;
          yield [chunk, platform];
        }

        if (emptyError !== null) {
          throw new PlatformUnavailableError(platform, `返回空内容: ${emptyError}`);
        }

        return; // 成功完成
      } catch (error) {
        if (started) {
          // 已开始 yield，不能切换（客户端已收到部分响应）
          throw error;
        }
        lastError = error;
        logger.warn(
          `mix 跨平台切换：平台 ${platform} 失败 - ` +
            `${error instanceof Error ? error.name : 'Error'}: ${errorMessage(error)}`,
        );
        chatRequest.message = originalMessage; // 重置消息
      }
    }

    // 所有平台都失败
    throw new PlatformUnavailableError('mix', lastError ? errorMessage(lastError) : 'all platforms failed');
  }

  /* ===== 平台名模型：直接调用对应平台的 Browser Provider ===== */
  logger.info(`[_stream_with_failover] 进入 else 分支 (platform model), model=${model}`);
  let provider = await modelRouter.getProvider(model);
  const platform = extractPlatformName(provider.platform);
  logger.info(
    `[chatglm] _stream_with_failover: 获取到 provider=${provider.platform}, platform=${platform}`,
  );

  // 辅助任务优先走独立通道（另一个账号 + 独立页面 → 与主对话并行）
  /* 辅助任务优先同平台（`getAuxCandidates` 已按「主通道平台优先」排序），
   * 但**同平台没有副账号时允许用其它平台的独立通道**（2026-10-17 用户规则）：
   * 「如果只有一个可用时，辅助模型可以尝试其他平台的」。
   * ⚠️ 旧实现这里要求 `platformOf(候选) === platformOf(主)` → 跨平台候选被直接丢掉，
   * 于是只能退回主 provider 串行执行（功能正常但慢），用户观感是"辅助通道没生效"。
   * ⚠️ 若**所有平台所有账号只有一个可用**，`getAuxCandidates()` 返回空 → 自然回落到
   * 主候选串行执行，也就是"辅助与主共用同一个账号"（用户规则第三条）。 */
  /* 候选链（用户 2026-10-18 规则）：
   *   ① 辅助通道：同平台副账号 → ② 其它平台的辅助通道 → ③ **主通道**（共用，串行）。
   * `getAuxCandidates()` 已按「主通道平台优先」排好序，这里逐个试；
   * ⚠️ 某个候选**已经吐过内容**再失败时**不能重试**（会把回复吐两遍）—— 直接抛。 */
  const candidates: Array<{ label: string; provider: BaseProvider; isAux: boolean }> = [];
  for (const [candidatePlatform, candidateProvider] of auxCandidates) {
    const samePlatform = platformOf(candidatePlatform) === platformOf(platform);
    candidates.push({
      label: `${samePlatform ? '同平台' : '其它平台'}辅助通道 ${candidatePlatform}（账号 ${candidateProvider.getAccountId()}）`,
      provider: candidateProvider,
      isAux: true,
    });
  }
  candidates.push({ label: `主通道 ${platform}`, provider, isAux: false });

  // 会话复用：同一会话只补发增量（provider 若无法复用会自动改发完整提示词）
  const ctx = chatRequest.context ?? {};
  const delta = typeof ctx['delta_message'] === 'string' ? ctx['delta_message'] : '';

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    const active = candidate.provider;
    const activePlatform = platformOf(active.platform);
    let emitted = false;

    try {
      /* 每个候选都从「完整提示词」重新起算：会话复用只对**同平台**有效，
       * 跨平台候选不能只发增量（对方网页里没有上文）。 */
      chatRequest.message =
        delta && activePlatform === platformOf(platform) && SESSION_REUSE_PLATFORMS.has(activePlatform)
          ? delta
          : originalMessage;
      if (chatRequest.message === delta) {
        logger.info(
          `[session] 会话 ${convId} 复用 ${activePlatform} 网页会话，` +
            `只发增量 ${delta.length} 字符（完整提示词 ${originalMessage.length} 字符）`,
        );
      }

      logger.info(`[_stream_with_failover] 使用 ${candidate.label}`);
      /* ⚠️ 用户要求（2026-10-22）：外部请求打到某平台 → 立即中止该平台正在进行的保鲜，
       * 并重置它的 24h 计时（刚刚用过，会话是热的，马上再刷会互相顶会话）。 */
      notifyPlatformUsed(activePlatform);
      logAiPlatformRequest({
        requestId,
        platform: extractPlatformName(active.platform),
        messages: [{ role: 'user', content: chatRequest.message }],
      });

      let emptyError: string | null = null;
      for await (const chunk of active.chatStream(chatRequest)) {
        // 纯错误（无内容）记录下来，循环结束后再抛出，
        // 保证生成器被正常关闭（否则 provider 的串行锁不会释放）
        if (chunk.error && !(chunk.content ?? '').trim()) {
          emptyError = chunk.error;
          break;
        }
        if ((chunk.content ?? '').trim()) emitted = true;
        logger.debug(
          `[_stream_with_failover] yield chunk, content_len=${chunk.content?.length ?? 0}`,
        );
        yield [chunk, activePlatform];
      }

      if (emptyError !== null) {
        // 让上层把真实原因返回给客户端，避免「空回复 + 无任何说明」
        throw new PlatformUnavailableError(activePlatform, `返回空内容: ${emptyError}`);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const reason = lastError.message.slice(0, 160);

      if (emitted) {
        // 已经吐出去内容了 → 重试会造成重复输出，只能如实报错
        logger.warn(`[_stream_with_failover] ${candidate.label} 输出中途失败（不重试）：${reason}`);
        throw lastError;
      }
      if (!candidate.isAux) {
        // 主通道（链尾）失败 → 交给上层
        throw lastError;
      }
      logger.warn(`[_stream_with_failover] ${candidate.label} 失败 → 尝试下一个候选：${reason}`);
    }
  }

  throw lastError ?? new PlatformUnavailableError(platform, '没有可用候选');
}

export { extractPlatformName };
