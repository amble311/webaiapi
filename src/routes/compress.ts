/**
 * 历史压缩 —— `legacy-python/src/api/routes.py` 第 499~1037 行的移植。
 *
 * ## 为什么要有这个模块
 * 提示词超过网页输入框上限（64K）时，原做法是「保留头尾、丢弃中间」
 * （实测 90375 → 64000，中间 26375 字符直接丢掉）。这会**随机丢失上下文**，
 * 模型拿不到完整信息 → 表现为「只描述不调用工具」。
 *
 * 改进：额外发起一次对话，让网页端把**旧历史**压缩成要点摘要，
 * 再用「摘要 + 最近原文」拼出最终提示词 —— 关键信息（文件路径、已完成的修改、
 * 待办事项）被保留，提示词体积大幅下降。
 *
 * ## 这个模块里全是「省时间」的踩坑结论
 * 压缩不是免费的：每一次压缩 = **一整轮完整对话**（30~60s）。
 * 所以每个常量都在权衡「多压一块 vs 少一轮预算」。
 */
import { logger } from '../log/logger.js';
import type { ChatRequest } from '../providers/base.js';
import type { HistoryDB } from '../controllers/history-db.js';
import type { ModelRouter } from '../controllers/router.js';
import { streamWithFailover } from './failover.js';
import {
  BROWSER_PROMPT_MAX_LEN,
  COMPRESS_CHUNK_MAX_SECONDS,
  COMPRESS_MIN_BUDGET,
  truncatePromptForBrowser,
} from './helpers.js';

/* ==================================================================== */
/* 常量                                                                */
/* ==================================================================== */

/** 最多缓存的会话数（按 `conversation_id`）。 */
export const SUMMARY_CACHE_MAX = 8;

/** 单次压缩请求的输入上限（需 < 输入框上限）。 */
export const COMPRESS_CHUNK_MAX = 50000;

/** 新增历史小于此值时直接追加，无需再压缩。 */
export const COMPRESS_APPEND_THRESHOLD = 6000;

/**
 * 原样保留的最近上下文长度。
 *
 * ⚠️ 这个值直接决定「要压几块」= 要额外跑几轮对话（每块一轮）：
 * - 提示词 8 万字符时，保留 2 万 → 旧历史 5.5~6.7 万 → **2 块 = 2 轮 = 30~117s**；
 * - 保留 4 万 → 旧历史约 4 万 → **1 块 = 1 轮**，省掉约一半压缩耗时，
 *   而且对当前工作更重要的近期原文保留得更多（信息更保真）。
 * 最终提示词 = 4 万原文 + 约 6000 摘要 ≈ 4.7 万，仍远低于 64K 上限。
 */
export const RECENT_KEEP = 40000;

/** 最近原文的**上限**：再多就装不下摘要了（64K 上限 − 摘要与包装文本约 10K）。 */
export const RECENT_KEEP_MAX = 54000;

/**
 * 单块最多压 3 次（1 次不理想就再来）。
 *
 * 实测压缩比本身很好（8.5~10.4x），所以**不需要无脑压 2/3 次** ——
 * 每多压一次就多花 30~60s 预算。改为「结果不理想才重试」。
 */
export const COMPRESS_MAX_ATTEMPTS = 3;

/** 每次重试前至少要有的剩余预算（秒）。 */
export const COMPRESS_RETRY_MIN_BUDGET = 45.0;

/** 摘要短于此值视为「没压出东西」。 */
export const COMPRESS_MIN_SUMMARY_CHARS = 200;

/** 明显拒答 / 无法处理的措辞。 */
export const COMPRESS_BAD_MARKERS: ReadonlyArray<string> = [
  '无法压缩', '不能压缩', '无法完成', '无法处理', '很抱歉', '抱歉，我',
  '内容过长无法', '请提供完整',
];

/**
 * 命中这些说明**平台侧有硬限制**（限频/繁忙），重试只会更糟 → 立刻放弃、不重试。
 */
export const COMPRESS_ABORT_MARKERS: ReadonlyArray<string> = [
  '请求过于频繁', '平台限制', '请稍后再试', '平台繁忙', '稍后再试',
  '今天的对话次数', '已达到上限',
];

/**
 * 某块重试后仍然失败时用它兜底。
 *
 * ⚠️ 绝不能静默丢弃这段历史（旧实现 `if s:` 直接跳过，那段历史永久丢失，
 * 模型下一轮再也看不到它 → 表现为「忘了已经读过/改过什么」）。
 */
export const COMPRESS_FAIL_FALLBACK_CHARS = 4000;

/**
 * `conversation_id -> { prefix, summary, coveredLen }`
 *
 * 第 3 项是「后台预压缩」引入的：它记录的摘要可能覆盖了**超前于前缀**的一段历史
 * （见 `precompressHistory`），下一轮靠它判断能否直接复用、零成本。
 */
export interface SummaryCacheEntry {
  /** 摘要所对应的「提示词前缀文本」。 */
  prefix: string;
  /** 摘要内容。 */
  summary: string;
  /** 摘要覆盖到的历史长度。 */
  coveredLen: number;
}

export const HISTORY_SUMMARY_CACHE = new Map<string, SummaryCacheEntry>();

/** 压缩提示词（`{content}` 占位符）。 */
export const COMPRESS_PROMPT = `请把下面这段对话历史压缩成要点摘要，供后续继续开发时作为上下文。

必须保留（不得丢失）：
1. 涉及到的**文件绝对路径**
2. 已经完成的修改、以及工具执行结果里的关键结论
3. 尚未完成的待办事项，以及用户明确提出过的要求

输出要求：不要解释、不要客套，直接输出摘要；用简洁的要点列表；控制在 1500 字以内。

# 对话历史
{content}
`;

/* ==================================================================== */
/* 切分                                                                */
/* ==================================================================== */

/**
 * 把切分点对齐到消息边界（`\n\n[Role]`），避免把一条消息切成两半。
 *
 * ⚠️ 两个坑（实测踩出来的）：
 * - **只取「前一个」边界**：若那条消息很长，边界离目标位置很远，实际保留的
 *   最近原文会远超预期（想留 4 万，结果留了 5.87 万，最终提示词 59,692 字符，
 *   离 64K 上限只剩 4 千余，随时会被强制中间截断）。
 * - **只取「最近」边界**（前后都比）：可能选到**更晚**的边界，要压缩的旧历史
 *   反而变大（实测想压成 1 块，变成 2 块，58s vs 21s）。
 *
 * 做法：优先对齐到目标位置之前的消息边界；边界离目标超过 `maxSkip`
 * 就退化为按**行**切（宁可切在消息内部，也不能让压缩块数/提示词体积失控）。
 */
export function snapToMessageBoundary(text: string, pos: number, maxSkip = 8000): number {
  if (pos <= 0) return 0;

  const prev = text.lastIndexOf('\n\n[', pos);
  if (prev > 0 && pos - prev <= maxSkip) return prev;

  const line = text.lastIndexOf('\n', pos);
  return line > 0 ? line : pos;
}

/**
 * 把提示词切成 `[旧历史, 最近原文, 切点]`。
 *
 * 切分点：在「多保留近期原文（省时间、更保真）」与「让压缩尽量只压 1 块」之间取平衡。
 * - `keepMin`：想压成 1 块，最近原文至少要留 `len - 单块上限`；
 * - `RECENT_KEEP_MAX`：留太多会挤爆 64K 上限（还要装摘要），设个天花板。
 *
 * 抽成公共函数，是为了让「请求内的压缩」与「后台预压缩」用**完全一致**的切分口径 ——
 * 口径不一致时后台预压缩存下的缓存会前缀对不上，白跑一轮。
 */
export function splitForCompression(messageText: string): {
  oldHistory: string;
  recent: string;
  cut: number;
} {
  if (messageText.length <= 500) {
    return { oldHistory: messageText, recent: '', cut: messageText.length };
  }

  const keep = Math.min(
    RECENT_KEEP_MAX,
    Math.max(RECENT_KEEP, messageText.length - COMPRESS_CHUNK_MAX),
  );
  const cut = snapToMessageBoundary(messageText, Math.max(0, messageText.length - keep));
  return {
    oldHistory: messageText.slice(0, cut),
    recent: messageText.slice(cut),
    cut,
  };
}

/* ==================================================================== */
/* 压缩质量判定                                                        */
/* ==================================================================== */

/** 是否是「平台侧硬限制」类回复（限频/繁忙）—— 重试只会更糟，立刻放弃。 */
export function summaryIsAbortable(summary: string): boolean {
  const s = (summary ?? '').trim();
  if (!s || s.length > 200) return false;
  return COMPRESS_ABORT_MARKERS.some((m) => s.includes(m));
}

/**
 * 压缩结果是否「不理想」（值得再压一次）。
 *
 * 判据（保守，避免白白多花一轮时间）：
 * 1. 空 / 极短 —— 模型没答或只回了一句话，等于这段历史丢了；
 * 2. 明显拒答/无法处理（"无法压缩""很抱歉…"）；
 * 3. 大段输入却基本没压（输出 ≥ 输入）—— 说明它把原文抄回来了。
 */
export function summaryIsBad(summary: string, source: string): boolean {
  const s = (summary ?? '').trim();
  if (!s) return true;

  const minChars = Math.min(COMPRESS_MIN_SUMMARY_CHARS, Math.max(50, Math.trunc(source.length / 50)));
  if (s.length < minChars) return true;

  const head = s.slice(0, 200);
  if (COMPRESS_BAD_MARKERS.some((m) => head.includes(m))) return true;

  if (source.length > 20000 && s.length >= source.length) return true;

  return false;
}

/* ==================================================================== */
/* 执行压缩                                                            */
/* ==================================================================== */

/** 压缩结果。`allOk=false` 说明有分块走到了「截断兜底」，**不能写进摘要缓存**。 */
export interface CompressResult {
  summary: string;
  allOk: boolean;
}

/**
 * 调用网页端把 `text` 压缩成摘要；`text` 过长时先分块压缩再合并。
 *
 * @returns `allOk=false` 表示有分块走了截断兜底 —— 这份内容只能当上下文用。
 */
export async function compressTextWithPage(
  text: string,
  modelRouter: ModelRouter,
  model: string,
  historyDb: HistoryDB,
  requestId: string,
  deadlineTs?: number,
): Promise<CompressResult> {
  if (!text.trim()) return { summary: '', allOk: true };

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += COMPRESS_CHUNK_MAX) {
    chunks.push(text.slice(i, i + COMPRESS_CHUNK_MAX));
  }

  /** 跑一轮对话拿结果。 */
  const run = async (prompt: string, tag: string): Promise<string> => {
    /* ⚠️ 压缩本身也是**一整轮对话**：一份 8 万字符的提示词要压 2 次，
     * 实测烧掉 117s，把预算吃得所剩无几，导致后面的「两轮策略 / 自驱动续跑」
     * 全部因剩余时间不足被跳过。
     * 因此：每块压缩有自己的上限，且**绝不越过**整个请求的截止时间。 */
    let dl = Date.now() + COMPRESS_CHUNK_MAX_SECONDS * 1000;
    if (deadlineTs) dl = Math.min(dl, deadlineTs);

    const req: ChatRequest = {
      message: prompt,
      model,
      stream: false,
      deadlineTs: dl,
      // ⚠️ 必须用**辅助页面**：压缩是往网页里再发一轮对话，
      //    若跑在主页面就会把主会话切走 —— 主会话的上下文丢了、
      //    「只补发增量」的会话复用随之失效；
      //    而后台预压缩更严重：它正是在等客户端下一轮请求，
      //    跑在主页面等于直接把主会话顶掉。
      context: { use_aux_page: true },
    };

    let out = '';
    for await (const [resp] of streamWithFailover(modelRouter, model, req, historyDb, `${requestId}#${tag}`)) {
      out += resp.content ?? '';
    }
    return out.trim();
  };

  /**
   * 压一块：结果不理想才重试（最多 `COMPRESS_MAX_ATTEMPTS` 次）。
   *
   * 每次重试都要花一整轮对话（30~60s），所以重试必须同时满足：
   * 结果确实不理想 **且** 剩余预算够。返回历次里最长的那份，避免越试越差。
   */
  const compressOne = async (content: string, tag: string): Promise<string> => {
    let best = '';

    for (let attempt = 1; attempt <= COMPRESS_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        const remain = deadlineTs ? deadlineTs - Date.now() : Number.POSITIVE_INFINITY;
        if (deadlineTs && remain / 1000 < COMPRESS_RETRY_MIN_BUDGET) {
          logger.warn(
            `[prompt] ${tag} 放弃第 ${attempt} 次重试：剩余预算不足（${(remain / 1000).toFixed(0)}s）`,
          );
          break;
        }
        logger.warn(
          `[prompt] ${tag} 上次压缩结果不理想（${best.length} 字符），` +
            `重试第 ${attempt}/${COMPRESS_MAX_ATTEMPTS} 次`,
        );
      }

      const t0 = Date.now();
      const s = await run(COMPRESS_PROMPT.replace('{content}', content), `${tag}t${attempt}`);
      const bad = summaryIsBad(s, content);
      const abort = summaryIsAbortable(s);

      logger.info(
        `[prompt] ${tag} 第 ${attempt} 次压缩：输入 ${content.length} → ` +
          `输出 ${s.length} 字符，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，` +
          `${abort ? '平台限制（放弃）' : bad ? '不理想（将重试）' : 'OK'}`,
      );

      if (abort) {
        // 限频/繁忙：重试只会让情况更糟（实测连试 3 次全被限）
        logger.warn(`[prompt] ${tag} 命中平台限制，放弃压缩重试`);
        return '';
      }

      if (s && s.length > best.length) best = s;
      if (!bad && s) return s;
    }

    return best;
  };

  const summaries: string[] = [];
  let allOk = true;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as string;
    logger.info(`[prompt] 压缩历史分块 ${i + 1}/${chunks.length}（${chunk.length} 字符）`);
    const s = await compressOne(chunk, `compress${i}`);

    if (s) {
      summaries.push(s);
    } else {
      /* ⚠️ 旧实现是 `if s:` 直接跳过 —— 压缩失败的这一段历史会**永久丢失**，
       * 模型下一轮就再也看不到它（表现为「忘了已经读过/改过什么」）。
       * 这里退化为截断保底，至少把开头部分留下。
       *
       * 但**必须标记「不完整」**：这只是兜底产物，不能当作摘要写进缓存
       * （否则缓存会谎报"已覆盖到 N 字符"，下一轮直接复用这份残缺摘要
       *  → 上下文真的丢了）。 */
      allOk = false;
      const fallback = chunk.slice(0, COMPRESS_FAIL_FALLBACK_CHARS);
      logger.warn(
        `[prompt] 分块 ${i + 1} 压缩失败（已尝试 ${COMPRESS_MAX_ATTEMPTS} 次），` +
          `改用截断兜底保留前 ${fallback.length} 字符`,
      );
      summaries.push(`（该段历史压缩失败，以下为原文开头截断）\n${fallback}`);
    }
  }

  let merged = summaries.join('\n\n');
  // 合并后仍过长则再压一次（同样带质量重试）
  if (merged.length > COMPRESS_CHUNK_MAX) {
    merged = await compressOne(merged.slice(0, COMPRESS_CHUNK_MAX), 'compress_merge');
  }

  return { summary: merged, allOk };
}

/* ==================================================================== */
/* 提示词压缩入口（超长时替代中间截断）                                */
/* ==================================================================== */

/**
 * 提示词超长时，用「压缩历史」替代「中间截断」。失败时回退到中间截断，
 * 保证请求始终发得出去。
 */
export async function shrinkPromptViaCompression(
  messageText: string,
  modelRouter: ModelRouter,
  model: string,
  historyDb: HistoryDB,
  requestId: string,
  conversationId: string,
  deadlineTs?: number,
): Promise<string> {
  if (messageText.length <= BROWSER_PROMPT_MAX_LEN) return messageText;

  // 压缩要额外跑 1~2 轮完整对话（实测 117s），预算不够就别压：
  // 直接中间截断更快，把剩余时间留给「两轮策略 / 自驱动续跑」。
  // 实测代价：压缩把预算吃光 → reparse 被跳过 → 模型只交了计划书就结束回合。
  if (deadlineTs && (deadlineTs - Date.now()) / 1000 < COMPRESS_MIN_BUDGET) {
    logger.warn(
      `[prompt] 剩余预算 ${((deadlineTs - Date.now()) / 1000).toFixed(0)}s < ` +
        `${COMPRESS_MIN_BUDGET.toFixed(0)}s，跳过历史压缩，直接中间截断`,
    );
    return truncatePromptForBrowser(messageText);
  }

  const { oldHistory, recent } = splitForCompression(messageText);

  if (oldHistory.length < 500) {
    // 没有可压缩的旧历史（超长的是最近部分本身），只能截断
    return truncatePromptForBrowser(messageText);
  }

  logger.info(
    `[prompt] 提示词 ${messageText.length} 字符超限，` +
      `改用「压缩历史」策略（旧历史 ${oldHistory.length} + 最近 ${recent.length}）`,
  );

  const cached = HISTORY_SUMMARY_CACHE.get(conversationId);
  let summary = '';
  let covered = 0;

  try {
    if (cached && cached.prefix && oldHistory.startsWith(cached.prefix)) {
      // 命中缓存：只处理新增部分，避免每轮都重复压缩
      const prevPrefix = cached.prefix;
      const prevSummary = cached.summary;
      const prevCovered = cached.coveredLen ?? prevPrefix.length;
      const newPart = oldHistory.slice(prevPrefix.length);

      if (prevCovered >= oldHistory.length) {
        // 后台预压缩已经把这段历史（甚至更多）折进摘要了 → **零压缩成本**
        summary = prevSummary;
        covered = prevCovered;
        logger.info(
          `[prompt] 命中后台预压缩摘要（已覆盖 ${prevCovered} 字符历史、` +
            `本次只需 ${oldHistory.length}），零压缩成本`,
        );
      } else if (newPart.length <= COMPRESS_APPEND_THRESHOLD) {
        summary = `${prevSummary}\n${newPart}`.trim();
        covered = oldHistory.length;
        logger.info('[prompt] 命中历史摘要缓存（新增历史直接追加）');
      } else {
        const r = await compressTextWithPage(
          `${prevSummary}\n\n${newPart}`,
          modelRouter,
          model,
          historyDb,
          requestId,
          deadlineTs,
        );
        summary = r.summary;
        covered = r.allOk ? oldHistory.length : 0;
      }
    } else {
      const r = await compressTextWithPage(
        oldHistory,
        modelRouter,
        model,
        historyDb,
        requestId,
        deadlineTs,
      );
      summary = r.summary;
      covered = r.allOk ? oldHistory.length : 0;
    }
  } catch (error) {
    logger.warn(`[prompt] 历史压缩失败: ${String(error)}`);
    summary = '';
  }

  if (!summary) {
    logger.warn('[prompt] 历史压缩无输出，回退为中间截断');
    return truncatePromptForBrowser(messageText);
  }

  // 更新缓存（LRU：超出上限时丢弃最早的一条）。
  // ⚠️ 只有**真实摘要**（covered>0）才能进缓存：截断兜底产物若被当摘要缓存，
  //    下一轮会「零成本复用它」→ 那段历史等于被静默丢弃。
  if (covered > 0) {
    HISTORY_SUMMARY_CACHE.set(conversationId, {
      prefix: oldHistory,
      summary,
      coveredLen: Math.max(covered, oldHistory.length),
    });
    while (HISTORY_SUMMARY_CACHE.size > SUMMARY_CACHE_MAX) {
      const oldest = HISTORY_SUMMARY_CACHE.keys().next();
      if (oldest.done) break;
      HISTORY_SUMMARY_CACHE.delete(oldest.value);
    }
  } else {
    logger.warn('[prompt] 本次只有截断兜底产物，不写入摘要缓存');
  }

  let newText =
    '[以下是之前对话历史的压缩摘要，请基于它继续]\n' +
    `${summary}\n\n` +
    '[以下是最近的对话原文]\n' +
    `${recent}`;

  logger.info(
    `[prompt] 历史压缩完成：${oldHistory.length} 字符旧历史 → ` +
      `${summary.length} 字符摘要，最终提示词 ${newText.length} 字符`,
  );

  if (newText.length > BROWSER_PROMPT_MAX_LEN) {
    newText = truncatePromptForBrowser(newText);
  }
  return newText;
}

/* ==================================================================== */
/* 后台预压缩：把「压缩历史」从用户请求的预算里挪出去                  */
/* ==================================================================== */
//
// 为什么值得做：上下文是**逐轮增长**的（每轮都会带回工具结果，尤其 read_file
// 结果不截断）。轮次越多提示词越大，每一轮都要现场压一遍 ——
// 实测 89k 字符的提示词压缩要 25~117s，直接吃掉用户请求的 1/10~1/2 预算，
// 而这个预算本该用来干活（reparse / 自驱动续跑）。
//
// 做法：本轮响应结束、客户端还在执行工具的那段空档里，后台把「本轮已发的历史 +
// 本轮新增内容」折叠进摘要缓存；下一轮进来时命中缓存且新增部分很小 →
// 走**纯追加**分支，压缩耗时降为 0。

/** 同时最多几个后台压缩（多了会抢账号/页面）。 */
const PRECOMPRESS_MAX_CONCURRENT = 2;

/** 单次后台压缩的时间上限（秒）。 */
const PRECOMPRESS_BUDGET = 100.0;

/**
 * 预压缩要「往前多看一段」才有效：只对齐本次切点等于白跑（请求内压缩已盖到那里）。
 * 20000 大致能顶 1~2 轮上下文增长，代价是摘要略微变长 + 与最近原文有少量重复。
 */
const PRECOMPRESS_LOOKAHEAD = 20000;

/**
 * 让位机制：浏览器通道是**串行**的（provider 有全局锁），后台压缩若和用户的
 * 下一个请求撞上，会把它堵在锁上、白吃它的时间预算。所以：
 * ① 先睡 `PRECOMPRESS_DELAY`，等客户端去执行工具（读文件等）；
 * ② 醒来后若发现「最近有请求进来」（安静期不足），直接放弃这一轮。
 *
 * ⚠️ 安静期要够长：实测工具调用型任务里，客户端读完文件 1~5s 就会发下一轮请求，
 *    这时根本没有空档 —— 抢锁只会拖慢它。只有「执行命令/跑测试」这类
 *    长时间工具才会出现真正的空档，那才是预压缩该出手的时候。
 */
const PRECOMPRESS_DELAY = 10.0;
const PRECOMPRESS_QUIET_GAP = 12.0;

/** 最近一次收到用户请求的时间戳（由 `chatCompletions` 通过 {@link markRequestTs} 更新）。 */
let lastRequestTs = 0;

/** 记录「刚收到用户请求」（供预压缩判断安静期）。 */
export function markRequestTs(now: number = Date.now()): void {
  lastRequestTs = now;
}

/** 在跑的后台任务（用于并发上限控制）。 */
const BG_TASKS = new Set<Promise<void>>();

/** 毫秒级等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 后台把本轮历史折叠进摘要缓存（下一轮即可 0 成本命中）。
 *
 * @param rawText **压缩前**的完整提示词：切分口径与下一轮完全一致，
 *   这样下一轮算出的 `oldHistory` 才会以本次缓存的前缀开头（走纯追加分支）。
 */
export async function precompressHistory(
  rawText: string,
  conversationId: string,
  modelRouter: ModelRouter,
  model: string,
  historyDb: HistoryDB,
  requestId: string,
): Promise<void> {
  try {
    // ① 先让客户端把工具跑起来（读文件/改文件都要时间），再抢浏览器通道
    await sleep(PRECOMPRESS_DELAY * 1000);

    /* ② 有人在用就放弃：**仅在没有独立辅助通道时**才需要让位。
     *
     * 浏览器通道原本是串行的（provider 一把全局锁），后台压缩与用户下一个请求
     * 撞上就会把它堵在锁上、白吃它的时间预算。
     * 现在辅助任务可以走「另一个账号 + 独立 context 页面的辅助通道」：
     * 不同账号 → 不同并发额度，不同页面/锁 → 真正并行，不再堵住用户请求，
     * 因此这种情况下**不必让位**（下一轮压缩成本能真正降为 0）。 */
    let auxAvailable = false;
    try {
      auxAvailable = modelRouter.getAuxCandidates().length > 0;
    } catch {
      auxAvailable = false;
    }

    const since = (Date.now() - lastRequestTs) / 1000;
    if (since < PRECOMPRESS_QUIET_GAP) {
      if (!auxAvailable) {
        logger.info(
          `[precompress] 检测到 ${since.toFixed(1)}s 前有新请求进来，` +
            '让位给用户请求，跳过本轮预压缩（无独立辅助通道）',
        );
        return;
      }
      logger.info(
        `[precompress] 独立辅助通道可用 → 与主对话并行执行，` +
          `不再让位（${since.toFixed(1)}s 前有新请求）`,
      );
    }

    const { oldHistory, cut } = splitForCompression(rawText);
    if (oldHistory.length < 500) return;

    const deadline = Date.now() + PRECOMPRESS_BUDGET * 1000;
    const cached = HISTORY_SUMMARY_CACHE.get(conversationId);
    const t0 = Date.now();

    // 缓存前缀用本次切点：切点随提示词长度**单调不减**，
    // 因此 `raw.slice(0, cut)` 一定是下一轮 `oldHistory` 的前缀（必命中）。
    let prefix = oldHistory;
    let baseSummary = '';
    let covered = 0;
    if (cached && cached.prefix && oldHistory.startsWith(cached.prefix)) {
      prefix = cached.prefix;
      baseSummary = cached.summary;
      covered = cached.coveredLen ?? cached.prefix.length;
    }

    /* 关键：往前多看一段「最近原文区」的开头。
     * 只对齐本次切点等于白跑（请求内压缩已经覆盖到那里了）；
     * 把 cut ~ cut+LOOKAHEAD 这段也折进摘要，下一轮（甚至下两轮）
     * 的 oldHistory 就整段落在已覆盖范围内 → 压缩成本 0。 */
    const targetCover = Math.min(rawText.length, cut + PRECOMPRESS_LOOKAHEAD);
    if (covered >= targetCover) {
      logger.info(
        `[precompress] 摘要已覆盖 ${covered} 字符（目标 ${targetCover}），无需预压缩`,
      );
      return;
    }

    const material = rawText.slice(covered, targetCover);
    if (material.length < 1000) {
      logger.info(`[precompress] 待折入的历史只有 ${material.length} 字符，跳过`);
      return;
    }

    const prompt = baseSummary ? `${baseSummary}\n\n${material}` : material;
    logger.info(
      `[precompress] 预压缩：摘要 ${baseSummary.length} + ` +
        `历史 ${covered}~${targetCover}（${material.length} 字符）`,
    );

    const { summary, allOk } = await compressTextWithPage(
      prompt,
      modelRouter,
      model,
      historyDb,
      `${requestId}#precompress`,
      deadline,
    );

    if (!summary || !allOk) {
      /* ⚠️ 失败/截断兜底产物**绝不能写缓存**：它会谎报「已覆盖到 N 字符」，
       * 下一轮零成本复用它 → 那段历史真的丢了（实测被限频时就是这样）。 */
      logger.warn(
        `[precompress] 预压缩未产出可信摘要` +
          `（output=${summary.length}, ok=${allOk}），保持原缓存不变`,
      );
      return;
    }

    HISTORY_SUMMARY_CACHE.set(conversationId, {
      prefix,
      summary,
      coveredLen: targetCover,
    });
    while (HISTORY_SUMMARY_CACHE.size > SUMMARY_CACHE_MAX) {
      const oldest = HISTORY_SUMMARY_CACHE.keys().next();
      if (oldest.done) break;
      HISTORY_SUMMARY_CACHE.delete(oldest.value);
    }

    logger.info(
      `[precompress] 预压缩完成：已覆盖到 ${targetCover} 字符（切点 ${cut}），` +
        `摘要 ${summary.length} 字符，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s` +
        '（下一轮压缩成本降为 0）',
    );
  } catch (error) {
    logger.warn(`[precompress] 预压缩失败: ${String(error)}`);
  }
}

/**
 * 在响应结束后排一个后台预压缩任务（不阻塞客户端）。
 *
 * 只在「本轮**压缩前**的提示词已经超限」时启动：这说明下一轮十有八九也要压缩，
 * 预压缩才有意义；提示词还短时压了也白压（切分口径不同，缓存对不上）。
 *
 * ⚠️ 与原实现的差异：Python 用 `asyncio.create_task` 并维护 `_BG_TASKS` 集合。
 * TS 里 `void promise` 就是「发射后不管」，用 `BG_TASKS` 集合只为控制并发数
 * 与在关服时等待它们结束（见 {@link waitForBackgroundTasks}）。
 */
export function schedulePrecompress(
  rawText: string,
  conversationId: string | null | undefined,
  modelRouter: ModelRouter,
  model: string,
  historyDb: HistoryDB,
  requestId: string,
): void {
  if (!conversationId || !rawText) return;
  if (rawText.length <= BROWSER_PROMPT_MAX_LEN) return;

  if (BG_TASKS.size >= PRECOMPRESS_MAX_CONCURRENT) {
    logger.info(`[precompress] 已有 ${BG_TASKS.size} 个后台压缩在跑，跳过本轮预压缩`);
    return;
  }

  const task = precompressHistory(rawText, conversationId, modelRouter, model, historyDb, requestId)
    .catch((error: unknown) => {
      logger.warn(`[precompress] 后台任务异常: ${String(error)}`);
    })
    .finally(() => {
      BG_TASKS.delete(task);
    });

  BG_TASKS.add(task);
  logger.info(
    `[precompress] 已排入后台预压缩（会话 ${conversationId}，` +
      `压缩前提示词 ${rawText.length} 字符）`,
  );
}

/** 等待所有后台任务结束（优雅关服用）。 */
export async function waitForBackgroundTasks(): Promise<void> {
  const pending = [...BG_TASKS];
  if (pending.length > 0) {
    logger.info(`[precompress] 等待 ${pending.length} 个后台压缩任务结束...`);
    await Promise.allSettled(pending);
  }
}

/** 清空预压缩相关状态（测试用）。 */
export function __resetPrecompressState(): void {
  BG_TASKS.clear();
  HISTORY_SUMMARY_CACHE.clear();
  lastRequestTs = 0;
}

