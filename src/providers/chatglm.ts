/**
 * ChatGLM 浏览器自动化 Provider —— `legacy-python/src/providers/chatglm_browser.py`
 * (1,951 行) 的 TypeScript 移植。
 *
 * 职责：用 Playwright Firefox 操作 chatglm.cn，把网页对话包装成 `ChatResponse` 流。
 *
 * ## 与原实现的差异
 * - **页面侧脚本外移**到 `chatglm-dom.ts` / `chatglm-dom-extract.ts`，本文件只剩控制流。
 * - **SSE 解析外移**到 `chatglm-sse.ts`（纯函数、可单测）。
 * - `asyncio.Lock` → {@link Mutex}；`chat_stream` 的 `async with` 改为
 *   `acquire()/release()`（`finally` 里释放，语义等价）。
 * - 模块级 `_last_raw_sse_*` 全局 → `chatglm-sse.ts` 里的 `setLastRawSse`（语义不变）。
 * - `import time` → `Date.now()`（毫秒）。
 *
 * ## ⚠️ 本文件里几乎每段注释都是真实事故换来的，删改前请先读
 * `docs/hard-constraints.md`。
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ElementHandle, Page } from 'playwright';

import {
  accountCooldownRemaining,
  clearAccountRole,
  enterAccount,
  exitAccount,
  getBrowser,
  getChannelPage,
  injectResponseJs,
  invalidateBrowser,
  isAccountBusy,
  loadCookies,
  markAccountCooldown,
  navigateTo,
  newWorkPage,
  peekPage,
  setAccountRole,
  transferAccountBusy,
} from '../browser/manager.js';
import { listAccounts, loadAuth } from '../browser/credentials.js';
import { iife } from '../browser/js-eval.js';
import { logger } from '../log/logger.js';
import { Mutex } from '../utils/mutex.js';
import { sanitizeMessage, topLevelJsonFields } from '../utils/text.js';
import { type ChatRequest, type ChatResponse, BaseProvider } from './base.js';
import {
  APPLY_CHAT_PREFS_JS,
  BUSY_NOTICE_DIAG_JS,
  CLEAR_INPUT_JS,
  COUNT_CONVERSATION_ITEMS_JS,
  DETECT_COMPLETION_JS,
  DETECT_THINKING_JS,
  DISMISS_OVERLAY_BLOCKING_JS,
  DISMISS_OVERLAY_CLOSE_JS,
  DISMISS_OVERLAY_FALLBACK_JS,
  HAS_INPUT_BOX_JS,
  INPUT_SELECTORS,
  INPUT_VALUE_LEN_JS,
  IS_INPUT_CLEARED_JS,
  PAGE_SHOWS_BUSY_JS,
  PROBE_CHAT_TOGGLES_JS,
  PROBE_LOGGED_IN_JS,
  READ_BUSY_NOTICE_JS,
  REQUEST_BODIES_GET_JS,
  RESET_SSE_JS,
  SEND_BUTTON_SELECTORS,
  SSE_GET_JS,
  ZERO_OUTPUT_DIAG_JS,
} from './chatglm-dom.js';
import { EXTRACT_RESPONSE_JS, FORCED_EXTRACT_JS } from './chatglm-dom-extract.js';
import {
  countPlatformToolCalls,
  extractSseAll,
  getLastRawSse,
  isBrowserConnectionError,
  logSseSummary,
  safeIncremental,
  setLastRawSse,
} from './chatglm-sse.js';

/** 平台名（也用作账号状态的命名空间）。 */
const PLATFORM = 'chatglm';

/** 聊天页 URL（会 302 到 `/main/alltoolsdetail`，那也是聊天页）。 */
const CHAT_URL = 'https://chatglm.cn/main/chat?lang=zh';

/** 未登录时页面上的标识词（侧边栏显示「登录 / 登录送积分好礼」，访客显示「访客_xxxx」）。 */
const NOT_LOGGED_MARKERS = ['访客', '登录', '注册', '未登录'];

/** 未登录页面上的其它特征串。 */
const NOT_LOGGED_SUBSTRINGS = ['登录送积分', '立即登录', '未登录', '登录/注册'];

/** 毫秒级等待（替代 `asyncio.sleep`）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SSE 原文落盘目录（排查上游格式 / 提取保真度用）。 */
const SSE_LOG_DIR = 'logs';


/** 从平台 ask 请求体里取 `meta_data`（解析失败返回空对象）。 */
function askMetaDataOf(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return {};
    const meta = (parsed as Record<string, unknown>)['meta_data'];
    return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 安全取字符串（`context` 是 `Record<string, unknown>`）。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 给 Promise 加超时（替代 `asyncio.wait_for`）。
 *
 * ⚠️ 存在的唯一理由：Playwright 的 `fill()` 在元素不可编辑时会**无限等待**
 * 「可见 / 可编辑」，把整个请求拖到中间件 300s 超时（2026-09-28 的 504 事故）。
 * 所以凡是可能挂住的页面操作都要包超时。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ChatGLMProviderOptions {
  /**
   * 使用哪个账号的凭证（`~/.ai-api/auth/chatglm/{accountId}.json`）。
   * 主通道的账号由 `ModelRouter` **启动时随机分配**。
   */
  accountId?: string;
  /**
   * **辅助通道**标识。非空时本实例使用「独立 context + 该账号」的专用页面，
   * 从而能与主通道**同时**工作且互不抢锁 —— 这是「后台预压缩与主对话并行」
   * 以及「换账号绕开同账号并发限制」的基础。为空时是主通道。
   */
  channelKey?: string;
}

export class ChatGLMBrowserProvider extends BaseProvider {
  /* ---------------- 角色（构造时确定，切号不会改变） ---------------- */

  /** 本实例是不是「主通道」（服务用户真实对话的那个）。 */
  private readonly isMainChannel: boolean;

  /**
   * 主轮全局（`_last_raw_sse_*` / `logs/chatglm_sse_*.txt`）只有主通道能写。
   *
   * ⚠️ 判据是**角色**而不是「是否在专用页面上」：主通道被限流后切到另一个账号的
   * 独立页面时，它依然是主通道，主轮全局仍由它写。
   */
  private readonly ownsGlobals: boolean;

  /** 允许「被限流时换账号重试」的只有主通道。 */
  private readonly allowRotate: boolean;

  private readonly MAX_ROTATE_PER_REQUEST = 1;

  /** 被平台限流后的账号冷却时长（实测约 1 分钟自动恢复，留余量取 120s）。 */
  private readonly ROTATE_COOLDOWN = 120;

  /**
   * 本轮是否撞到「平台限制提示」。由 `streamResponse` 设置，
   * 由 `chatStream` 决定：能换账号就换号重试（客户端什么都还没收到，体验最好），
   * 不能换才回传给客户端（`[ChatGLM 平台限制] …`）。
   */
  private lastLimitNotice: string | null = null;

  /* ---------------- 运行时状态 ---------------- */

  private page: Page | null = null;

  private readonly lock = new Mutex();

  private responseJsInjected = false;

  private cookiesLoaded = false;

  private lastSendTime = 0;

  private readonly SEND_COOLDOWN = 10;

  /** 页面最后使用时间（空闲超时用）。 */
  private lastUsedTime = Date.now();

  /** 30 分钟空闲 → 刷新页面。 */
  private readonly PAGE_IDLE_TIMEOUT = 1800;

  /* ---------------- 网页会话复用状态 ---------------- */

  /**
   * 页面当前那个对话属于哪个逻辑会话（`conversation_id`）。
   * 与其一起记住页面对象：浏览器被重建 / 页面刷新后句柄会变，
   * 此时必须当成「没有可复用的会话」。
   */
  private sessionKey: string | null = null;

  private sessionPage: Page | null = null;

  /** 辅助页面：专供两轮策略的 reparse 使用（独立对话，懒创建）。 */
  private auxPage: Page | null = null;

  /**
   * 网页输入框可接受的文本长度上限。
   *
   * 实测 ChatGLM：7 万字符仍可发送，8.2 万字符时 `textarea.value` 能写入
   * 但按 Enter 不会提交（无报错、无新对话轮次）→ 表现为「空回复」。
   * 取 64K：留出安全余量，同时尽量保留上下文。
   */
  private readonly MAX_INPUT_LEN = 64000;

  /**
   * 「平台自带工具刷屏」的提前收尾阈值：本轮平台原生工具调用 `≥ 次数`、
   * **计数仍在增长**、且已等待 `> 秒数`。
   *
   * ⚠️ 实测过的三种刷屏（都让模型脱离本地任务、白烧一整轮）：
   * - `search` 57 次（2026-10-14，查「bash 怎么删带空格的目录」，耗 210s）；
   * - `execute_sandbox_code` 57 次、`open` 52 次（同一天的另一批轮次）；
   * - **`retrieve` 6~9 次**（2026-10-15，跑去查 v2rayN 代理配置，耗 145s）。
   *
   * 因此判据是「**除 `finish` 之外的全部平台工具**」（见 `countPlatformToolCalls`）——
   * 只认 search/open 时，后两类完全拦不住。`finish` 是每轮正常收尾都会推的内部调用。
   *
   * 两个细节：
   * 1. **只在计数仍在增长时收尾**（真的还在刷）—— 页面沉默（平台在服务端跑它自己的工具、
   *    不推流）交给 90s 空闲超时，避免误切「早先调过一次、之后正常产出」的轮次；
   * 2. 阈值取 3 次 / 60s：平台工具对本地任务没有价值，等得越久亏得越多，
   *    更致命的是吃光总预算让兜底没预算可用。
   */
  private static readonly PLATFORM_TOOL_GIVEUP_COUNT = 3;
  private static readonly PLATFORM_TOOL_GIVEUP_SECONDS = 60;

  /** 页面开关探测是否已做过（每进程一次，见 {@link probeChatToggles}）。 */
  private togglesProbed = false;

  /* ---------------- 登录状态缓存 ---------------- */

  /**
   * `checkLoginStatus()` 被 router 在**每次请求**都调用，而它内部会做一次整页导航
   * （约 6s）。缓存后同一会话内不再重复导航。
   *
   * ⚠️ **只缓存「已登录」**：若把「未登录」也缓存，一次瞬时误判（页面正在重建 /
   * DOM 未就绪）会让整个平台池失效 120s，表现为「聊着聊着突然不可用」。
   */
  private loggedIn = false;

  private lastLoginCheck = 0;

  private readonly LOGIN_CACHE_TTL = 120;

  /** 当前账号 ID（主通道可能被换号改写）。 */
  private accountId: string;

  /** 当前通道 key（主通道被换号后会变成 `chatglm:<newAccount>`）。 */
  private channelKey: string | undefined;

  constructor(options: ChatGLMProviderOptions = {}) {
    super('chatglm-browser');

    this.models = ['chatglm', 'glm-4', 'glm-3'];
    this.accountId = options.accountId ?? 'default';
    this.channelKey = options.channelKey;

    // 主通道被限流后会**切到另一个账号的独立页面**，此时 channelKey 非空、
    // 但它依然是主通道（要继续写主轮全局、要继续切辅助页、要继续允许换号）。
    this.isMainChannel = options.channelKey === undefined;
    this.ownsGlobals = this.isMainChannel;
    this.allowRotate = this.isMainChannel;

    if (this.isMainChannel) {
      // 登记「这个账号归主通道用」，辅助通道挑账号时会避开
      setAccountRole(PLATFORM, this.accountId, 'main');
    }
  }

  /* ================================================================== */
  /* 页面生命周期                                                        */
  /* ================================================================== */

  /** 页面空闲超过 30 分钟就刷新（避免长期挂着导致状态异常）。 */
  private async checkPageIdleTimeout(): Promise<void> {
    if (!this.page) return;

    const idleTime = (Date.now() - this.lastUsedTime) / 1000;
    if (idleTime > this.PAGE_IDLE_TIMEOUT) {
      logger.info(
        `[chatglm] _check_page_idle_timeout(): 页面已空闲 ${idleTime.toFixed(0)}s，超过 ` +
          `${this.PAGE_IDLE_TIMEOUT.toFixed(0)}s 超时，刷新页面...`,
      );
      await this.refreshPage();
    }
  }

  /** 刷新到新的聊天会话。 */
  private async refreshPage(): Promise<void> {
    if (!this.page) return;

    try {
      logger.info('[chatglm] _refresh_page(): 正在导航到新聊天会话...');
      await this.page.goto(CHAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(2000);
      logger.info('[chatglm] _refresh_page(): 页面刷新完成');
      // 刷新 = 重新开一个干净会话，之前的网页会话上下文没了
      this.sessionKey = null;
      this.sessionPage = null;
    } catch (error) {
      logger.error(`[chatglm] _refresh_page(): 刷新失败: ${String(error)}`);
    }
  }

  /** 标记页面已使用（更新最后使用时间）。 */
  override async markUsed(): Promise<void> {
    this.lastUsedTime = Date.now();
  }

  /** 当前账号 ID（⚠️ 被限流换号后会变，不要缓存）。 */
  override getAccountId(): string {
    return this.accountId;
  }

  /** 辅助通道标识（主通道返回 undefined）。 */
  override getChannelKey(): string | undefined {
    return this.channelKey;
  }

  /**
   * 确保页面就绪：页面 → 凭证 → 注入 JS。
   *
   * ⚠️⚠️ 三个「只做一次」的步骤**绝不能**嵌在 `if (!this.page)` 里（2026-09-27 事故）：
   * `checkLoginStatus()` 会先一步执行（router 在每次请求前都会调它），
   * 它在内部 `getBrowser()` 后就把 `this.page` 赋好了 —— 于是本方法进来时
   * `this.page` 已经有值，整个初始化块被跳过 → **`loadCookies()` 从来没被调用过**
   * （日志里搜不到「已加载 N 个 Cookie」），浏览器一直以**访客**身份跑，
   * 访客免费额度用完后平台就一直回「请求过于频繁，请稍后再试」。
   */
  private async ensureInitialized(): Promise<void> {
    logger.info(
      `[chatglm] _ensure_initialized() 被调用, 账号=${this.accountId}` +
        `${this.channelKey ? '（辅助通道）' : ''}, ` +
        `self._page=${this.page ? 'initialized' : 'None'}`,
    );

    if (this.channelKey) {
      await this.ensureChannelPage();
      return;
    }

    if (!this.page) {
      logger.info('[chatglm] _ensure_initialized(): 初始化浏览器...');

      // 导航到 ChatGLM 聊天页面（这会创建并更新全局 page）
      await getBrowser();
      this.page = peekPage();
      if (!this.page) throw new Error('浏览器页面不可用');

      await navigateTo(CHAT_URL);
      await sleep(2000);

      // 说明：https://chatglm.cn/main/chat 会自动重定向到
      // https://chatglm.cn/main/alltoolsdetail?lang=zh —— 后者**就是聊天页面**
      // （发消息后 URL 会变成 ...&cid=xxx），不是错误页。
      // 之前只要 URL 含 alltoolsdetail 就重新导航，等于每次都白白多花 2~6s，
      // 而且会刷新页面丢弃已有会话。现在改为按「是否真的有输入框」判断。
      if (!(await this.hasInputBox())) {
        logger.warn(
          `[chatglm] _ensure_initialized(): 页面 ${this.page.url()} 无输入框，重新导航...`,
        );
        try {
          await this.page.goto(CHAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (error) {
          logger.warn(`[chatglm] _ensure_initialized(): 重新导航失败: ${String(error)}`);
        }
        await sleep(2000);
      }

      logger.info(`[chatglm] _ensure_initialized(): 已导航到 ${this.page.url()}`);
    }

    // ===== 凭证加载（独立判断，不能被上面的分支挡住）=====
    // 注意：Cookie 是加到 **context** 上的，已经加载完成的页面**不会自动生效**，
    // 必须重新导航一次才能真正以登录身份访问。
    if (!this.cookiesLoaded) {
      // ⚠️ 必须带上 `this.accountId`：主通道的账号是**启动时随机分配**的
      //    （见 `ModelRouter._pickRandomMainAccount`），写死默认账号会把
      //    另一个账号的 Cookie 注入全局 context → 页面身份与 provider 认知不一致。
      if (await loadCookies(PLATFORM, this.accountId)) {
        this.cookiesLoaded = true;
        try {
          await this.page?.goto(CHAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
          await sleep(2000);
          logger.info('[chatglm] 已注入登录凭证并重新加载页面');
        } catch (error) {
          logger.warn(`[chatglm] 注入凭证后刷新页面失败: ${String(error)}`);
        }
        // 凭证变了 → 之前的登录判定作废，下次必须重新探测
        this.loggedIn = false;
        this.lastLoginCheck = 0;
      } else {
        logger.warn('ChatGLM Cookie 未加载，可能需要重新捕获（访客身份下会被限流）');
      }
    }

    // ===== 注入响应提取 JS（独立判断）=====
    if (!this.responseJsInjected) {
      await injectResponseJs(this.page ?? undefined);
      this.responseJsInjected = true;
    }
  }

  /**
   * 辅助通道的页面准备：独立 context + 指定账号，且**每次辅助请求都重开干净对话**。
   *
   * 取舍理由（与旧 `_enter_aux_page()` 一致）：
   * - 避免上一轮的对话历史被带进这次压缩/转换（压缩提示词是自包含的）；
   * - 避免复用旧页面时输入框不可编辑 → `fill()` 无限等待 → 504（2026-09-28 事故）。
   * 代价只有 1~2s，而且辅助通道与主对话并行，这点开销不吃主请求的预算。
   */
  private async ensureChannelPage(): Promise<void> {
    const page = await getChannelPage(this.channelKey as string, PLATFORM, this.accountId);
    if (!page) {
      throw new Error(`辅助通道 ${this.channelKey} 页面不可用（账号 ${this.accountId}）`);
    }

    if (this.page !== page) {
      this.page = page;
      this.responseJsInjected = false;
      // 新页面 = 之前的网页会话没了，不能再说「可复用」
      this.sessionKey = null;
      this.sessionPage = null;
    }
    if (!this.responseJsInjected) {
      await injectResponseJs(this.page);
      this.responseJsInjected = true;
    }

    try {
      await this.page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      await this.dismissBlockingOverlay();
      this.sessionKey = null;
      this.sessionPage = null;
      logger.info(`[chatglm] 辅助通道 ${this.channelKey} 已开新对话: ${this.page.url()}`);
    } catch (error) {
      logger.warn(`[chatglm] 辅助通道 ${this.channelKey} 导航失败: ${String(error)}`);
    }
  }

  /* ================================================================== */
  /* 登录检查                                                            */
  /* ================================================================== */

  /**
   * 检查登录状态（带缓存 + 复用已有页面）。
   *
   * 性能说明：该方法被 `ModelRouter._getMixCandidates()` 在**每次请求**中调用。
   * 原实现每次都做一次整页导航（实测约 6s），是请求耗时的大头。现在：
   * - 已登录且近期检查过 → 直接返回缓存（0 开销）
   * - 只有在尚未初始化页面时才真正导航一次，并复用该页面
   */
  async checkLoginStatus(): Promise<boolean> {
    if (this.channelKey) {
      // 辅助通道**不做整页导航探测** —— 探测走的是全局页面 + `navigateTo()`，
      // 那会把**主页面**劫持到自己这个账号上，主会话的复用链当场断掉。
      // 这里只看凭证文件里有没有 cookie：真有登录问题，后续发送会失败并回落到主通道。
      try {
        const auth = loadAuth(PLATFORM, { accountId: this.accountId });
        const ok = Boolean(auth?.cookies?.length);
        if (!ok) {
          logger.warn(
            `[chatglm] 辅助通道 ${this.channelKey} 账号 ${this.accountId} 凭证缺少 Cookie`,
          );
        }
        return ok;
      } catch (error) {
        logger.warn(`[chatglm] 辅助通道 ${this.channelKey} 登录检查失败: ${String(error)}`);
        return false;
      }
    }

    // 1) 缓存命中（**只缓存「已登录」**）
    if (this.loggedIn && this.page && (Date.now() - this.lastLoginCheck) / 1000 < this.LOGIN_CACHE_TTL) {
      return true;
    }

    // 有请求正在使用页面时不导航 —— 否则会把进行中的对话刷掉，
    // 且被刷掉的那个请求会拿到「请等待其他对话生成完毕」之类的页面提示。
    if (this.lock.isLocked) {
      logger.info('[chatglm] 页面正在被请求占用，跳过登录检查（返回上次结果）');
      return this.loggedIn;
    }

    try {
      const { page } = await getBrowser();

      // 2) 与全局页面保持同步。浏览器可能被重建，此时 this.page 是失效句柄，
      //    而 getBrowser() 返回的是新的空白页。
      if (this.page !== page) {
        if (this.page !== null) {
          logger.warn('[chatglm] 页面句柄已变化（浏览器被重建），同步为新页面并重置状态');
        }
        this.page = page;
        this.cookiesLoaded = false;
        this.responseJsInjected = false;
        this.sessionKey = null;
        this.sessionPage = null;
      }

      // 3) 判断是否需要导航：空白页 / 非 chatglm 域名 / 没有输入框
      let needNav = false;
      try {
        const url = page.url() ?? '';
        if (!url.includes('chatglm.cn') || url === 'about:blank') needNav = true;
        else if (!(await this.hasInputBox())) needNav = true;
      } catch {
        needNav = true;
      }

      /* ===== 3.5) 凭证加载 =====
       * ⚠️⚠️ **必须独立判断，绝不能嵌在 `if (!this.page)` 里**（这是硬约束第①条，
       * 2026-09-27 的真实事故）：`checkLoginStatus()` 会先一步执行（router 在每次
       * 请求前都调它），此时 `this.page` 已被赋好值，任何「只在页面为空时才初始化」
       * 的写法都会被整块跳过 → Cookie 从来没被注入过 → 浏览器一直以**访客**身份跑，
       * 访客额度用完后平台永远回「请求过于频繁」。
       *
       * 本方法（登录检查）也会走到这里，所以这一步在这里同样不能省：
       * 否则 `/v1/health` 与平台名模型（`model=chatglm`）会误判为「未登录」，
       * 而 `getProvider()` 对未登录的平台名模型是**直接抛 404** 的。
       *
       * ⚠️ Cookie 是加到 **context** 上的，已经加载完成的页面**不会自动生效**，
       * 所以刚加载完必须重新导航一次。
       */
      if (!this.cookiesLoaded) {
        if (await loadCookies(PLATFORM, this.accountId)) {
          this.cookiesLoaded = true;
          needNav = true; // 必须重新导航，Cookie 才会生效
          logger.info('[chatglm] 已注入登录凭证（登录检查路径），将重新加载页面');
        } else {
          logger.warn(
            `ChatGLM Cookie 未加载（${PLATFORM}/${this.accountId}），` +
              '登录检查将按访客判定；对话路径可能被限流',
          );
        }
      }

      if (needNav) {
        await navigateTo(CHAT_URL);
        try {
          await page.waitForLoadState('load', { timeout: 30000 });
        } catch {
          // 忽略：等待超时不影响后续探测
        }
        this.page = page;
        // 等待重定向（/main/chat → /main/alltoolsdetail）稳定
        await sleep(1500);
      }

      // 4) 探测登录态
      let isLogged = await this.probeLoggedIn(page);

      // 5) 未匹配到用户信息时，刷新一次再判，避免 DOM 异常导致的误判
      if (!isLogged) {
        logger.warn('[chatglm] 未匹配到登录信息，刷新页面后重试判定...');
        try {
          await this.page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(2500);
          isLogged = await this.probeLoggedIn(this.page);
        } catch (error) {
          logger.warn(`[chatglm] 刷新重试失败: ${String(error)}`);
        }
      }

      this.loggedIn = Boolean(isLogged);
      this.lastLoginCheck = Date.now();
      logger.info(
        `[chatglm] 登录状态检查完成: ${this.loggedIn ? '已登录' : '未登录'}` +
          (this.loggedIn ? `（后续 ${this.LOGIN_CACHE_TTL.toFixed(0)}s 内复用缓存）` : ''),
      );
      return this.loggedIn;
    } catch (error) {
      logger.error(`检查登录状态失败: ${String(error)}`);
      return false;
    }
  }

  /**
   * 探测页面是否处于**已登录**状态（访客不算登录）。
   *
   * ⚠️ 必须用 `querySelectorAll` 逐个判断可见性（脚本里已如此）——
   * 只取第一个匹配元素时，若第一个 `[class*="user"]` 恰好是隐藏元素会误判为未登录。
   *
   * ⚠️ 更隐蔽的坑（2026-09-27 实测）：**ChatGLM 未登录时会以「访客_xxxx」身份继续可用**
   * （有少量免费额度），用完后接口就返回「请求过于频繁，请稍后再试」。而访客页面上
   * `.user-info / [class*="user"]` 这些元素**同样可见** → 旧探测把访客误判成已登录 →
   * 平台池一直"可用"，实际每个请求都在烧访客额度，表现为莫名其妙的限流。
   * 因此这里必须显式识别访客身份（看用户名标识，而不是"有没有用户元素"）。
   */
  private async probeLoggedIn(page: Page): Promise<boolean> {
    let info: { name?: string; raw?: string; has_user_el?: boolean };
    try {
      info = (await page.evaluate(iife(PROBE_LOGGED_IN_JS))) as typeof info;
    } catch {
      return false;
    }

    const name = String(info.name ?? '');
    const raw = String(info.raw ?? '');
    logger.info(
      `[chatglm] 登录探测: 用户名标识=${JSON.stringify(name)}（${JSON.stringify(raw)}）, ` +
        `有用户元素=${String(info.has_user_el)}`,
    );

    // 未登录时侧边栏那个位置显示的是「登录 / 登录送积分好礼」；
    // 以访客身份继续用时显示「访客_xxxx」。两种都算未登录。
    if (
      NOT_LOGGED_MARKERS.some((m) => name.startsWith(m)) ||
      NOT_LOGGED_SUBSTRINGS.some((m) => raw.includes(m))
    ) {
      logger.warn(
        `[chatglm] 当前**未登录**（页面标识=${JSON.stringify(name || raw)}）：` +
          '访客免费额度用完后会一直返回「请求过于频繁，请稍后再试」。' +
          '请重新登录并捕获凭证（`npx webaiapi login chatglm`）。',
      );
      return false;
    }

    if (!name) {
      // 读不到用户名时只能退回「有没有用户元素」——并按已登录处理，
      // 避免把正常页面误判成未登录而封锁平台（此前的教训）。
      logger.warn('[chatglm] 未读到用户名标识，退回按「有用户元素」判定');
    }
    return Boolean(info.has_user_el);
  }

  /* ================================================================== */
  /* 流式响应（核心等待循环）                                            */
  /* ================================================================== */

  /**
   * 发消息并等待回复，边等边 yield 增量。
   *
   * 本函数只**记录** `lastLimitNotice`，由 `chatStream` 决定是换号重试还是回传提示。
   */
  private async *streamResponse(request: ChatRequest): AsyncGenerator<ChatResponse> {
    this.lastLimitNotice = null;

    logger.info(
      `[chatglm] _stream_response() 被调用, self._page=${this.page ? 'initialized' : 'None'}`,
    );

    if (!this.page) {
      logger.warn('[chatglm] _stream_response(): self._page is None, yielding error');
      yield { error: '浏览器未初始化' };
      return;
    }

    await this.checkPageIdleTimeout();

    /* ---------------- 会话复用判定 ---------------- */
    // routes 侧会准备两份文本：
    //   request.message          —— 调用方**希望**发的那份（可能是增量）
    //   context["delta_message"] —— 只含新增消息
    //   context["full_message"]  —— 完整提示词
    // 只有当页面上的会话确实还是同一个（同页面对象 + 同一 sessionKey +
    // URL 带 cid= 表示对话仍在进行）时，才敢只发增量；否则发完整提示词，
    // 保证**上下文永远不丢**。
    const ctx = request.context ?? {};
    const sessionKey = asString(ctx['session_key']) ?? null;
    const deltaMsg = asString(ctx['delta_message'])?.trim() ?? '';
    const fullMsg = asString(ctx['full_message'])?.trim() ?? '';
    const pageUrl = this.page.url() ?? '';

    const canReuse = Boolean(
      deltaMsg &&
        sessionKey &&
        sessionKey === this.sessionKey &&
        this.sessionPage === this.page &&
        pageUrl.includes('cid='),
    );

    let messageContent: string;
    if (deltaMsg && canReuse) {
      messageContent = deltaMsg;
      logger.info(
        `[chatglm] 复用当前网页会话（${sessionKey}），只发送增量 ${deltaMsg.length} 字符`,
      );
    } else {
      if (deltaMsg) {
        logger.info(
          '[chatglm] 无法复用网页会话' +
            `（session_match=${sessionKey === this.sessionKey}, ` +
            `same_page=${this.sessionPage === this.page}, ` +
            `cid=${pageUrl.includes('cid=')}），改用完整提示词`,
        );
      }
      messageContent = fullMsg || request.message || '';
    }

    // 防御：网页输入框有长度上限（实测 >7 万字符时 Enter 无法提交，表现为静默不发送）
    if (messageContent.length > this.MAX_INPUT_LEN) {
      const overflow = messageContent.length - this.MAX_INPUT_LEN;
      const marker = `\n\n... [上下文过长，已省略中间 ${overflow} 字符] ...\n\n`;
      const headLen = Math.floor(this.MAX_INPUT_LEN * 0.45);
      const tailLen = Math.max(0, this.MAX_INPUT_LEN - headLen - marker.length);
      messageContent =
        messageContent.slice(0, headLen) +
        marker +
        (tailLen > 0 ? messageContent.slice(-tailLen) : '');
      logger.warn(
        `[chatglm] 输入内容过长(${request.message.length} 字符)，` +
          `已截断至 ${messageContent.length} 字符（网页输入框有上限）`,
      );
    }
    logger.info(`[chatglm] 开始发送消息: ${messageContent.slice(0, 50)}...`);

    // 发送前清空 SSE 捕获缓冲，确保抓到的只是本轮回答
    await this.resetSseCapture();

    /* 发送前把平台自带的「联网搜索」关掉、把「思考强度」降到「快速」。
     * 理由：默认 is_networking=true + reasoning_effort=max 会让模型每轮刷几十次平台搜索、
     * 并「想」上 90~200s（见 docs/native-parity.md 阶段 3）。幂等，失败不影响本轮。 */
    await this.applyChatPreferences();

    // sessionKey 无论复用与否都要记：发完整提示词时这个会话也被「喂满」了，
    // 下一次同会话的请求同样可以只发增量。
    await this.sendMessage(messageContent, sessionKey, Boolean(deltaMsg && canReuse));
    logger.info('[chatglm] 消息已发送，等待 AI 回复...');

    /* 侦察：把「平台自己的请求体」导出来（判断能否用平台原生函数调用通道承载客户端工具）。
     * 只读、只落盘 + 打日志，失败一律不影响主流程。 */
    if (this.ownsGlobals) await this.dumpPlatformRequests();

    /* 侦察：找出「联网搜索 / 深度思考」的页面开关（决定能否在发送前关掉它们）。
     * 每进程一次，落盘 `logs/chatglm_page_toggles.txt`。 */
    if (this.ownsGlobals && !this.togglesProbed) {
      this.togglesProbed = true;
      await this.probeChatToggles();
    }

    let lastText = '';
    let maxLenSeen = 0; // DOM 兜底路径下提取到的最长文本长度
    let maxSseLen = 0; // SSE 路径下 text+think 提取长度（辅助活跃信号）
    let maxSseRawLen = 0; // SSE 原始报文长度（**主活跃信号**，严格单调递增）
    let platformToolStats: Record<string, number> = {};
    /** 上一轮见到的「平台工具调用次数」，用于判断它是否**仍在增长**（真的还在刷）。 */
    let lastPlatformToolCount = 0;

    const startTime = Date.now();
    let lastActivity = Date.now();
    const idleTimeout = 90; // 连续 90s 无新内容才判定结束

    // 总时长上限。必须**小于**请求超时中间件的 300s，否则中间件会先掐断请求，
    // 导致我们自己的兜底提取与 DOM 诊断来不及执行。
    // 若调用方传入 `deadlineTs`（整个 HTTP 请求的绝对截止时间），则收敛为「剩余时间」
    // —— 首轮 + 两轮策略的 reparse 是两个完整往返，各自按 240s 跑必然超过 300s，
    // 客户端只会拿到 504。
    let hardTimeout = 240;
    const deadlineTs = request.deadlineTs;
    if (deadlineTs) {
      const remain = (deadlineTs - Date.now()) / 1000;
      hardTimeout = Math.max(5, Math.min(hardTimeout, remain));
      logger.info(
        `[chatglm] 本次请求时间预算收敛为 ${hardTimeout.toFixed(0)}s` +
          `（整个 HTTP 请求剩余 ${remain.toFixed(0)}s）`,
      );
    }

    let lastProgressLog = 0;
    // SSE 解析缓存：报文只增不减，长度未变时无需重复解析
    // （80 万字符的报文每 0.2s 重解析一次开销很大）
    const sseCache = {
      rawLen: -1,
      answer: '',
      think: '',
      finished: false,
      platformTools: {} as Record<string, number>,
    };

    try {
      logger.info('[chatglm] 开始等待 AI 回复...');
      let loopCount = 0;
      const thinkingCheckInterval = 15; // 每 15 轮（约 3s）一次，减少 JS 评估频率

      for (;;) {
        loopCount += 1;
        const elapsed = (Date.now() - startTime) / 1000;

        if (loopCount % 5 === 1) {
          logger.info(
            `[chatglm] 等待 AI 回复中... (已等待 ${elapsed.toFixed(1)}s, 第${loopCount}轮)`,
          );
        }

        // 检查思考阶段（降低频率：每 15 轮一次，减少 DOM 查询）
        let isThinking = false;
        if (loopCount % thinkingCheckInterval === 1) {
          isThinking = await this.detectThinking();
        }
        if (isThinking) {
          logger.debug(`[chatglm] 正在思考... (${elapsed.toFixed(1)}s)`);
          await sleep(500);
          continue;
        }

        /* ===== 文本来源优先级（关键）=====
         * 1) SSE 原始流：**内容保真**。DOM 里的文本是 Markdown 渲染后的结果，
         *    实测会被破坏：`__name__` → `name`（下划线被当加粗语法吃掉）、
         *    半角引号 `"` → 全角 `“”`（JSON 因此解析失败）、空格丢失；
         *    而且容器里还混着用户自己发出的提问（提示词里的 <tool_call>
         *    格式示例会被误当成 AI 的工具调用）。
         * 2) DOM innerText：仅作兜底。 */
        let currentText = '';
        const sseRaw = await this.readSseCapture();
        let sseFinished = false;

        if (sseRaw) {
          if (sseRaw.length !== sseCache.rawLen) {
            const r = extractSseAll(sseRaw);
            sseCache.rawLen = sseRaw.length;
            sseCache.answer = r.answer;
            sseCache.think = r.think;
            sseCache.finished = r.finished;
            sseCache.platformTools = r.platformTools;
          }
          sseFinished = sseCache.finished;
          platformToolStats = sseCache.platformTools;
          currentText = sseCache.answer;

          /* ===== 活动判定 =====
           * **主信号：SSE 原始报文长度**。只要上游还在推事件报文一定变长；流断了它就停
           * → 语义与「有没有新内容」完全一致，且严格单调递增。
           * ⚠️ 不能只用 text/think 的提取长度：两者都是「增量片段 + 轮末累积快照」的
           *    混合体，提取长度在**本轮快照到来之前长时间不变**（实测 505 个 think 片段里
           *    最长片段恒为 1787，而拼接总长一直在涨到 11097）→ maxSseLen 再也刷不动 →
           *    90s 空闲超时把**仍在运行**的第 3 轮思考掐掉，最终 0 产出（客户端拿到空回复）。
           * ⚠️ 也不能用 DOM 文本长度：思考阶段 DOM 的 .answer 里装的是思考正文，
           *    思考结束后它会被**最终答案替换**（只剩几十字符），长度反而变小。 */
          if (sseRaw.length > maxSseRawLen) {
            maxSseRawLen = sseRaw.length;
            lastActivity = Date.now();
          }
          // 辅助信号：提取长度增长（报文长度相同但解析结果变大时兜底）
          const sseTotal = sseCache.answer.length + sseCache.think.length;
          if (sseTotal > maxSseLen) {
            maxSseLen = sseTotal;
            lastActivity = Date.now();
          }
        }

        // ⚠️ 只有「完全没有 SSE 捕获」时才回退 DOM。
        //    SSE 捕获存在但 type=text 为空 ⇒ 模型还在 think 阶段，
        //    此时 DOM 的 .answer 里装的正是**思考正文**，取它会把思考过程
        //    当成回答流给客户端（实测客户端先收到 3751 字符思考、然后停住）。
        if (!currentText && !sseRaw) {
          currentText = String(await this.page.evaluate(iife(EXTRACT_RESPONSE_JS)));
        }

        // 统一清洗（SSE 与 DOM 两个来源都要清洗）
        currentText = sanitizeMessage(currentText);

        // 每 20s 输出一次提取进度（诊断「一直没产出/一直有增量」）
        if ((Date.now() - lastProgressLog) / 1000 > 20) {
          lastProgressLog = Date.now();
          logger.info(
            `[chatglm] 提取进度: 长度=${currentText.length}, ` +
              `已产出=${lastText.length}, 已等待=${((Date.now() - startTime) / 1000).toFixed(0)}s, ` +
              `SSE回答=${sseCache.answer.length}, SSE思考=${sseCache.think.length}, ` +
              `SSE报文=${sseRaw.length}, SSE完成=${String(sseCache.finished)}, ` +
              `平台内部工具=${JSON.stringify(sseCache.platformTools)}, ` +
              `内容开头=${JSON.stringify(currentText.slice(0, 80))}`,
          );
        }

        // 计算增量文本（必须用 safeIncremental：模型中途改写回答时，
        // 按长度硬切会产生半句话的乱码碎片）
        const incremental = safeIncremental(lastText, currentText);

        if (incremental) {
          yield { content: sanitizeMessage(incremental) };
          lastText = currentText;
          // 只有「内容真正变长」才算有效活动。
          // 否则页面上的动画/轮换元素会导致文本反复变化，让 lastActivity 一直被刷新，
          // 从而永远不触发空闲超时（曾出现跑满 1000+ 轮、230s 仍未结束的情况）。
          if (currentText.length > maxLenSeen) {
            maxLenSeen = currentText.length;
            lastActivity = Date.now();
          }
        }

        /* ===== 完成判定 =====
         * ⚠️ 完成信号必须**结合本轮是否已产出内容**来判断：刚提交消息后，页面上可能
         * 还残留上一轮回答（或本轮用户消息自身）的「重新生成」按钮，让检出立刻为真。
         * 曾因此导致两轮策略只等 1 轮就退出、拿到空回答而彻底失效。
         * 因此：只有**本轮已有内容**时才立即采信完成信号；否则给 30s 宽限期。
         * 完成判定**优先用 SSE 的 status == "finish"**（权威信号）——
         * DOM 的「重新生成」按钮在 ChatGLM 改版后已不可靠（实测整轮 176s 里一直返回 False，
         * 明明答完了还在白等 90s 空闲超时）。DOM 检测降为兜底，每 5 轮（1s）一次。 */
        let isComplete = sseFinished;
        if (!isComplete && loopCount % 5 === 1) {
          isComplete = await this.detectCompletion();
        }

        if (isComplete) {
          if (currentText) {
            // 已有内容：SSE finish 是权威的，可直接结束；
            // DOM 兜底路径再要求「内容 3s 内没有继续变长」，避免返回半截答案。
            if (sseFinished || (Date.now() - lastActivity) / 1000 >= 3) break;
          } else if (sseFinished || (Date.now() - startTime) / 1000 > 30) {
            // 本轮始终没有正文（模型没答 / 只输出工具调用）：
            // SSE 已 finish 就立即结束，否则等满 30s 宽限期再放弃
            break;
          }
        }

        const nowTs = Date.now();

        // 平台限制快速失败：页面提示「请等待其他对话生成完毕」/「请求过于频繁」时，
        // 说明 ChatGLM 已拒绝本次请求，再等也不会出内容（省下 90s 空等）。
        if (!lastText && loopCount % 25 === 0) {
          if (await this.pageShowsBusyNotice()) {
            const notice = (await this.readBusyNotice()) || '请等待其他对话生成完毕';

            // 诊断：把判定依据（最后一条 .answer 的原文）也打出来，
            // 用于区分「平台真限流」与「我们自己的文案被当成提示」
            try {
              const diag = (await this.page.evaluate(iife(BUSY_NOTICE_DIAG_JS))) as {
                url?: string;
                n?: number;
                tail?: string;
              };
              logger.warn(
                `[chatglm] 判定依据: url=${String(diag.url)}, ` +
                  `.answer 数量=${String(diag.n)}, ` +
                  `最后一条内容=${JSON.stringify(String(diag.tail ?? '').slice(0, 200))}`,
              );
            } catch {
              // 诊断失败不影响主流程
            }

            logger.warn(
              `[chatglm] 页面提示「${notice}」，本次请求被 ChatGLM 拒绝` +
                '（并发对话或触发限流）。已提前结束等待，请避免并发/高频发送。',
            );

            // ⚠️ 这里**只记录**，交给 `chatStream` 决定：主通道还有别的账号时
            //    换号重试（此时客户端什么都没收到，体验最好）；实在没得换才回传提示。
            //    lastText 仍然置上，避免收尾的「兜底提取」重复取数。
            this.lastLimitNotice = notice;
            lastText = `[ChatGLM 平台限制] ${notice}`;
            break;
          }
        }

        /* ===== 平台自带工具刷屏 → 提前收尾 =====
         * 见 PLATFORM_TOOL_GIVEUP_COUNT 的说明：留着它只会白烧预算，
         * 而预算恰恰是后面兜底（动作恢复轮）唯一的本钱。
         * ⚠️ 只在**计数仍在增长**时收尾：页面沉默交给下面的空闲超时。 */
        const platformToolCount = countPlatformToolCalls(platformToolStats);
        const platformToolsGrowing = platformToolCount > lastPlatformToolCount;
        lastPlatformToolCount = Math.max(lastPlatformToolCount, platformToolCount);

        if (
          platformToolsGrowing &&
          platformToolCount >= ChatGLMBrowserProvider.PLATFORM_TOOL_GIVEUP_COUNT &&
          elapsed > ChatGLMBrowserProvider.PLATFORM_TOOL_GIVEUP_SECONDS
        ) {
          logger.warn(
            `[chatglm] 本轮平台自带工具已触发 ${platformToolCount} 次且仍在增长` +
              `（已等待 ${elapsed.toFixed(0)}s，明细=${JSON.stringify(platformToolStats)}），` +
              '对本地任务无价值，提前收尾把预算留给兜底',
          );
          break;
        }

        // 活动式空闲超时：只要持续有新内容就不算空闲
        if ((nowTs - lastActivity) / 1000 > idleTimeout) {
          logger.info(`[chatglm] 空闲超时（${idleTimeout.toFixed(0)}s 无新内容），结束等待`);
          break;
        }
        // 总时长硬上限（防止极端情况挂死）
        if ((nowTs - startTime) / 1000 > hardTimeout) {
          logger.warn(`[chatglm] 总超时（${hardTimeout.toFixed(0)}s），结束等待`);
          break;
        }

        await sleep(200);
      }

      /* ---------------- 记录 SSE 原始流（供降级解析使用） ---------------- */
      // ⚠️ **辅助通道不得写这些主轮全局**（引入并行后新增的约束）：这些全局是给
      //    routes 恢复「主轮回答里的工具调用」用的。辅助通道（后台预压缩）可能与
      //    主对话**同时**跑完，若它也写，主轮的 reparse 就会拿到压缩请求的报文
      //    → 转换出完全错误的工具调用。辅助通道的产出通过 chunk 直接返回，不需要全局。
      try {
        const sseRawEnd = await this.readSseCapture();
        if (sseRawEnd) {
          const r = extractSseAll(sseRawEnd);
          if (this.ownsGlobals) {
            setLastRawSse({ text: r.answer, think: r.think, toolCalls: [] });
          }
          if (Object.keys(r.platformTools).length > 0) platformToolStats = r.platformTools;
          logSseSummary(sseRawEnd, r);

          // ⚠️ 辅助通道不落盘：否则并行的压缩会覆盖掉主轮报文。
          if (this.ownsGlobals) this.dumpSseSample(sseRawEnd);
        } else {
          if (this.ownsGlobals) setLastRawSse({ text: '', think: '', toolCalls: [] });
          logger.warn('[chatglm] SSE 原始流捕获为空（未 hook 到或接口非流式）');
        }
      } catch (error) {
        logger.debug(`[chatglm] 读取 SSE 捕获失败: ${String(error)}`);
      }

      /* ---------------- 兜底：整轮零产出时强制再取一次 DOM 正文 ---------------- */
      if (!lastText) {
        try {
          const forced = String(await this.page.evaluate(iife(FORCED_EXTRACT_JS)));
          if (forced) {
            logger.info(`[chatglm] 兜底提取答案正文，长度=${forced.length}`);
            // 记入 lastText，让下方的「零产出」判定知道本轮已有内容
            lastText = forced;
            yield { content: sanitizeMessage(forced) };
          } else {
            // 诊断：区分「模型没答」与「答了但选择器/锚点没匹配上」
            const diag = (await this.page.evaluate(iife(ZERO_OUTPUT_DIAG_JS))) as {
              url?: string;
              answerCount?: number;
              answerLen?: number;
              answerHead?: string;
              convLen?: number;
              convHead?: string;
              regenerate?: number;
            };
            logger.warn(
              `[chatglm] 未提取到任何内容，DOM 诊断: url=${String(diag.url)}, ` +
                `answerCount=${String(diag.answerCount)}, answerLen=${String(diag.answerLen)}, ` +
                `convLen=${String(diag.convLen)}, regenerate=${String(diag.regenerate)}`,
            );
            logger.warn(
              `[chatglm] .answer 内容前 300 字符: ${JSON.stringify(String(diag.answerHead ?? ''))}`,
            );
            logger.warn(
              `[chatglm] 对话容器前 300 字符: ${JSON.stringify(String(diag.convHead ?? ''))}`,
            );
          }
        } catch (error) {
          logger.warn(`[chatglm] 兜底提取失败: ${String(error)}`);
        }
      }

      /* ===== 零产出：整轮既没有正文、也没有平台限制提示 =====
       * 以前这里直接 return（什么都不发）→ 上游把它当成「成功」，客户端拿到一个
       * 200 的空响应（表现为「AI 没反应」）。实测：模型整轮调用**网页端自带的联网搜索**
       * （SSE 里出现 search 387 次、报文 410KB），从头到尾没有 type=text。
       *
       * ⚠️ 但只要本轮还有**思考材料**就不要报错：routes 的策略3 会拿「SSE 回答 +
       *    SSE 思考 + DOM」再走一轮转换，能从中恢复出工具调用；此时若回传 error，
       *    routes 会直接跨平台切换，思考里的工具意图就被白白丢掉了。
       *    只有**连思考都没有**才判定本轮失败。 */
      if (!lastText) {
        const toolsDesc =
          Object.entries(platformToolStats)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => `${k}×${v}`)
            .join(', ') || '无';
        const thinkMaterial = (this.ownsGlobals ? getLastRawSse().think : sseCache.think).trim();

        logger.warn(
          `[chatglm] 整轮零产出（无正文、无工具调用），` +
            `思考材料=${thinkMaterial.length} 字符，平台内部工具调用统计: ${toolsDesc}`,
        );

        if ('search' in platformToolStats) {
          logger.warn(
            '[chatglm] ⚠️ 模型整轮在用**网页端自带联网搜索**（协议里已明令禁止），' +
              '既没读取本地文件也没产出正文。' +
              '若该提问反复触发，请改写提问使其不需要联网信息。',
          );
        }

        if (thinkMaterial) {
          logger.warn(
            '[chatglm] 本轮无正文但有思考材料，交给上层从思考里恢复工具调用' +
              '（策略3 已放宽门槛）；不发 error，避免误触发切换',
          );
        } else {
          yield {
            error:
              '[chatglm] 平台未产出任何正文' +
              ('search' in platformToolStats
                ? `（模型整轮在用网页端自带的联网搜索：${toolsDesc}）`
                : ''),
          };
        }
      }

    } catch (error) {
      logger.error(`流式响应失败: ${String(error)}`);
      if (isBrowserConnectionError(error)) {
        invalidateBrowser(`${error instanceof Error ? error.name : 'Error'}: ${String(error)}`);
      }
      yield { error: String(error) };
    }
  }

  /**
   * 把 SSE 原文落盘。
   *
   * `..._last.txt` 永远写**最新**一轮；`..._longest.txt` 只在更长时覆盖 ——
   * 旧实现只保留「更长的那份」，结果一个大样本会一直挡住后续样本，
   * 失败报文根本没落盘，排查时看到的是早已过期的报文。
   */
  private dumpSseSample(sseRaw: string): void {
    try {
      mkdirSync(SSE_LOG_DIR, { recursive: true });
      writeFileSync(join(SSE_LOG_DIR, 'chatglm_sse_last.txt'), sseRaw, 'utf8');

      const longest = join(SSE_LOG_DIR, 'chatglm_sse_longest.txt');
      let isLongest = true;
      if (existsSync(longest)) {
        try {
          isLongest = statSync(longest).size <= sseRaw.length;
        } catch {
          // 读取失败就当它不是最长的
        }
      }
      if (isLongest) writeFileSync(longest, sseRaw, 'utf8');
    } catch {
      // 落盘失败不影响主流程
    }
  }

  /**
   * 侦察：导出**平台自己的请求体**。
   *
   * ## 要回答的问题（决定架构走向）
   * 网页端 Agent 与原生模型最大的差别在于：它只有**自己固定的工具集**
   * （`search` / `open` / `click` / `execute_sandbox_code` / `finish`，且由平台服务端执行），
   * 而原生模型接受调用方传入的 `tools` 并回传 `tool_calls`。
   * 如果平台的 ask 接口**接受 tools / 函数定义**，我们就能把客户端工具直接交给它、
   * 用它的原生函数调用通道承载，彻底扔掉「注入 `<tool_call>` 文本协议 + 正则解析 + 四层兜底」；
   * 反之文本桥就删不掉。
   *
   * 因此这里把请求体原样落盘（`logs/chatglm_platform_request.txt`），
   * 并在日志里打**顶层字段名**（最关键的结论：有没有 tools/functions 之类的入口）。
   */
  private async dumpPlatformRequests(): Promise<void> {
    if (!this.page) return;

    let reqs: Array<{ method?: string; url?: string; contentType?: string; body?: string }> | null;
    try {
      reqs = (await this.page.evaluate(iife(REQUEST_BODIES_GET_JS))) as typeof reqs;
    } catch (error) {
      logger.debug(`[recon] 读取平台请求体失败: ${String(error)}`);
      return;
    }

    if (!Array.isArray(reqs) || reqs.length === 0) {
      logger.warn('[recon] 未捕获到平台请求体（hook 未生效？或该请求走 WebSocket / 原生 fetch 之外）');
      return;
    }

    for (const r of reqs) {
      const fields = topLevelJsonFields(r.body ?? '');
      logger.info(
        `[recon] 平台请求 ${r.method ?? ''} ${r.url ?? ''} | content-type=${r.contentType ?? ''} | ` +
          `顶层字段=[${fields.join(', ')}] | 体积=${(r.body ?? '').length} | ` +
          `开头=${JSON.stringify((r.body ?? '').slice(0, 160))}`,
      );

      // 阶段 3 的验证闭环：页面开关到底有没有改变平台参数
      if ((r.url ?? '').includes('/assistant/stream')) {
        const meta = askMetaDataOf(r.body ?? '');
        logger.info(
          `[聊天参数] 平台侧: is_networking=${String(meta['is_networking'])} ` +
            `chat_mode=${String(meta['chat_mode'])} reasoning_effort=${String(meta['reasoning_effort'])} ` +
            `selected_model=${String(meta['selected_model'])}`,
        );
      }
    }

    try {
      mkdirSync(SSE_LOG_DIR, { recursive: true });
      const text = reqs
        .map(
          (r, i) =>
            `### [${i}] ${r.method ?? ''} ${r.url ?? ''}\n` +
            `content-type: ${r.contentType ?? ''}\n\n${r.body ?? ''}\n`,
        )
        .join('\n');
      writeFileSync(join(SSE_LOG_DIR, 'chatglm_platform_request.txt'), text, 'utf8');
    } catch {
      // 落盘失败不影响主流程
    }
  }

  /**
   * 发送前应用页面偏好：**关掉「联网搜索」**、**思考强度降为「快速」**。
   *
   * ⚠️ 这两项直接决定「模型会不会去刷平台自带的搜索」与「每轮要想多久」
   * （实测默认开着时单轮 90~200s、`search` 刷 57 次）。失败只记日志，绝不阻断本轮。
   *
   * 逃生的口子：设 `WEBAIAPI_SKIP_PAGE_PREFS=1` 可跳过（排查用）。
   */
  private async applyChatPreferences(): Promise<void> {
    if (!this.page) return;
    if (process.env['WEBAIAPI_SKIP_PAGE_PREFS'] === '1') return;

    const started = Date.now();
    try {
      const r = (await this.page.evaluate(iife(APPLY_CHAT_PREFS_JS))) as {
        clicked?: string[];
        before?: { searchBtn?: { cls?: string } | null; items?: Array<{ text?: string; cls?: string; visible?: boolean; popper?: string }> };
        after?: { searchBtn?: { cls?: string } | null; items?: Array<{ text?: string; cls?: string; visible?: boolean; popper?: string }> };
        notes?: string[];
      } | null;
      if (!r) return;

      /** 取快照里「带 selected 的思考强度项」。 */
      const selOf = (snap: typeof r.before): string =>
        (snap?.items ?? [])
          .filter((it) => /selected/.test(String(it.cls)))
          .map((it) => `${String(it.text).slice(0, 12)}`)
          .join('|') || '（无 selected）';

      logger.info(
        `[聊天参数] 点击=${JSON.stringify(r.clicked ?? [])}, ` +
          `思考强度选中: ${selOf(r.before)} → ${selOf(r.after)}, ` +
          `联网按钮 class: ${String(r.before?.searchBtn?.cls ?? '(无)').slice(0, 60)} → ` +
          `${String(r.after?.searchBtn?.cls ?? '(无)').slice(0, 60)}, 耗时=${Date.now() - started}ms`,
      );

      try {
        mkdirSync(SSE_LOG_DIR, { recursive: true });
        writeFileSync(
          join(SSE_LOG_DIR, 'chatglm_page_prefs.txt'),
          JSON.stringify(r, null, 2),
          'utf8',
        );
      } catch {
        // 落盘失败不影响主流程
      }

      // 弹层别留着挡发送（发送路径虽有自己的浮层处理，这里先收干净）
      try {
        await this.page.keyboard.press('Escape');
      } catch {
        // 忽略
      }
    } catch (error) {
      logger.debug(`[chatglm] 应用页面偏好失败: ${String(error)}`);
    }
  }

  /**
   * 侦察：导出「联网搜索 / 深度思考」相关的页面开关与本地存储键。
   *
   * ## 要回答的问题（省时间的最大杠杆）
   * 平台 ask 请求体里有 `meta_data.is_networking`（默认 true）与
   * `chat_mode=deep_thinking` + `reasoning_effort=max`：
   * 前者让模型不停去调平台自带的联网搜索（`search` 单轮 57 次、45 个 query），
   * 后者让每回合要「想」90~200s。它们都是**页面 UI 状态**，
   * 只有点到对应开关才能在发请求前改掉。
   *
   * 探测结果落盘 `logs/chatglm_page_toggles.txt`（每进程一次）。
   */
  private async probeChatToggles(): Promise<void> {
    if (!this.page) return;

    let data: unknown;
    try {
      data = await this.page.evaluate(iife(PROBE_CHAT_TOGGLES_JS));
    } catch (error) {
      logger.debug(`[recon] 探测页面开关失败: ${String(error)}`);
      return;
    }
    if (!data || typeof data !== 'object') return;

    const rec = data as {
      controls?: Array<{ text?: string; aria?: string; cls?: string }>;
      matched?: Array<{ text?: string; aria?: string; cls?: string }>;
      storage?: Record<string, string>;
    };

    logger.info(
      `[recon] 页面开关探测：控件 ${rec.controls?.length ?? 0} 个，命中「联网/搜索/深度思考」` +
        `${rec.matched?.length ?? 0} 个：` +
        JSON.stringify((rec.matched ?? []).slice(0, 8).map((m) => `${m.text || m.aria}(${m.cls})`)),
    );
    logger.info(
      `[recon] 本地存储键：${JSON.stringify(Object.keys(rec.storage ?? {}).slice(0, 20))}`,
    );

    try {
      mkdirSync(SSE_LOG_DIR, { recursive: true });
      writeFileSync(
        join(SSE_LOG_DIR, 'chatglm_page_toggles.txt'),
        JSON.stringify(data, null, 2),
        'utf8',
      );
    } catch {
      // 落盘失败不影响主流程
    }
  }

  /* ================================================================== */
  /* 页面状态小工具                                                      */
  /* ================================================================== */

  /** ChatGLM 专用思考检测。 */
  private async detectThinking(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return Boolean(await this.page.evaluate(iife(DETECT_THINKING_JS)));
    } catch {
      return false;
    }
  }

  /** ChatGLM 专用完成检测（DOM 兜底；权威信号是 SSE 的 `status == "finish"`）。 */
  private async detectCompletion(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return Boolean(await this.page.evaluate(iife(DETECT_COMPLETION_JS)));
    } catch {
      return false;
    }
  }

  /** 页面**最后一条** `.answer` 是否就是平台并发/限流提示。 */
  private async pageShowsBusyNotice(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return Boolean(await this.page.evaluate(iife(PAGE_SHOWS_BUSY_JS)));
    } catch {
      return false;
    }
  }

  /** 读取平台限制提示原文（没有则空串）。 */
  private async readBusyNotice(): Promise<string> {
    if (!this.page) return '';
    try {
      return String((await this.page.evaluate(iife(READ_BUSY_NOTICE_JS))) ?? '');
    } catch {
      return '';
    }
  }

  /** 清空页面上的 SSE 捕获缓冲（每轮请求前调用）。 */
  private async resetSseCapture(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.evaluate(iife(RESET_SSE_JS));
    } catch {
      // 忽略
    }
  }

  /** 读取页面捕获到的 SSE 原始文本（未经 Markdown 渲染，内容保真）。 */
  private async readSseCapture(): Promise<string> {
    if (!this.page) return '';

    let data: { text?: string; xhrText?: string } | null;
    try {
      data = (await this.page.evaluate(iife(SSE_GET_JS))) as typeof data;
    } catch {
      return '';
    }
    if (!data) return '';

    const parts: string[] = [];
    if (data.text) parts.push(data.text);
    if (data.xhrText) parts.push(data.xhrText);
    return parts.join('\n');
  }

  /** 页面是否存在聊天输入框（用于判断页面是否处于可聊天的状态）。 */
  private async hasInputBox(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return Boolean(await this.page.evaluate(iife(HAS_INPUT_BOX_JS)));
    } catch {
      return false;
    }
  }

  /** 统计当前对话轮数（用于校验消息是否真正发出）。 */
  private async countConversationItems(): Promise<number> {
    try {
      return Number(await this.page?.evaluate(iife(COUNT_CONVERSATION_ITEMS_JS))) || 0;
    } catch {
      return 0;
    }
  }

  /** 读取输入框当前的文本长度（-1 = 未找到输入框）。 */
  private async inputValueLen(): Promise<number> {
    try {
      return Number(await this.page?.evaluate(iife(INPUT_VALUE_LEN_JS)));
    } catch {
      return -1;
    }
  }

  /** 输入框是否已被清空（ChatGLM 提交成功后会清空输入框）。 */
  private async isInputCleared(): Promise<boolean> {
    try {
      return Boolean(await this.page?.evaluate(iife(IS_INPUT_CLEARED_JS)));
    } catch {
      return false;
    }
  }

  /**
   * 等待发送成功的**任一**信号：
   * 1. 出现新的对话轮次（`.conversation-item` 数量增加）
   * 2. 输入框被清空（ChatGLM 提交后会清空输入框）
   *
   * 两个信号取「或」：不同页面版本下有时只有其中一个可用。
   */
  private async waitSendSuccess(before: number, timeout = 12): Promise<boolean> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      if ((await this.countConversationItems()) > before) return true;
      if (await this.isInputCleared()) return true;
      await sleep(500);
    }
    return false;
  }

  /** 查找发送按钮（部分情况下 Enter 不生效，需要点击按钮）。 */
  private async findSendButton(): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    for (const sel of SEND_BUTTON_SELECTORS) {
      try {
        const btn = await this.page?.$(sel);
        if (btn && (await btn.isVisible())) return btn;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * 关闭可能遮挡输入框的浮层/对话框。
   *
   * ChatGLM 基于 Element UI，页面会偶发出现遮罩层（loading/公告弹窗），
   * 导致 Playwright 点击输入框或发送按钮时被拦截
   * （报错 "subtree intercepts pointer events"），消息因此发不出去。
   */
  private async dismissBlockingOverlay(): Promise<void> {
    if (!this.page) return;
    try {
      // 1) 先点掉浮层内可见的关闭按钮
      const closed = Number(await this.page.evaluate(iife(DISMISS_OVERLAY_CLOSE_JS))) || 0;
      if (closed > 0) {
        logger.info(`[chatglm] 已关闭 ${closed} 个可见浮层关闭按钮`);
        await sleep(400);
      }

      // 2) 仍有遮挡则按 Esc
      const blocking = Number(await this.page.evaluate(iife(DISMISS_OVERLAY_BLOCKING_JS))) || 0;
      if (blocking > 0) {
        logger.info(`[chatglm] 检测到 ${blocking} 个遮挡浮层，按 Esc 关闭`);
        await this.page.keyboard.press('Escape');
        await sleep(400);
      }

      // 3) 兜底：让残留遮罩不再拦截指针事件
      await this.page.evaluate(iife(DISMISS_OVERLAY_FALLBACK_JS));
    } catch (error) {
      logger.debug(`[chatglm] 关闭遮挡浮层时出现问题: ${String(error)}`);
    }
  }

  /**
   * 发送消息。
   *
   * 与旧版差异：
   * - 发送后**校验**是否真的产生了新对话轮次（Enter 可能未提交）
   * - 校验失败时最多重试 1 次，第二次改试「点击发送按钮」
   * - 多次失败直接抛异常，避免上游拿到空回复却以为是模型没说话
   *
   * @param sessionKey 逻辑会话 ID；发送成功后记到 `this.sessionKey`，
   *   供下一次请求判断能否沿用同一个网页会话
   * @param reuseSession true 表示本次发的就是增量、要**续写**当前会话（不导航）
   */
  private async sendMessage(
    message: string,
    sessionKey: string | null = null,
    reuseSession = false,
  ): Promise<void> {
    if (!this.page) throw new Error('浏览器未初始化');

    // 等待冷却时间
    const cooldownRemaining = this.SEND_COOLDOWN - (Date.now() - this.lastSendTime) / 1000;
    if (cooldownRemaining > 0) {
      logger.debug(`发送冷却中，剩余 ${cooldownRemaining.toFixed(1)}s`);
      await sleep(cooldownRemaining * 1000);
    }

    /* ===== 会话复用 / 新开会话 =====
     *  1) `reuseSession=true` → **直接续写**当前会话，不导航
     *     （路由侧这次只发了增量提示词，导航会丢掉上下文，既错又慢）
     *  2) 否则 → 页面正处于某次对话中（URL 带 cid=）时先重开一个干净会话：
     *     路由侧这次发的是**完整提示词**，落在新会话里上下文才完整。
     *     （旧行为是每次都重开：一个请求一个新对话，会话数暴涨、准备阶段也多花几秒） */
    const currentUrl = this.page.url() ?? '';
    if (!reuseSession && currentUrl.includes('cid=')) {
      logger.info('[chatglm] _send_message(): 上一轮对话仍在，重新打开新会话...');
      try {
        await this.page.goto(CHAT_URL, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (error) {
        logger.warn(`[chatglm] _send_message(): 重新导航失败: ${String(error)}`);
      }
      await sleep(1500);
    }

    const beforeCount = await this.countConversationItems();
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 先清掉可能遮挡输入框/发送按钮的浮层，否则点击会被拦截
        await this.dismissBlockingOverlay();

        // 等待输入框就绪（最多 10s）
        let textarea: ElementHandle<SVGElement | HTMLElement> | null = null;
        for (const sel of INPUT_SELECTORS) {
          for (let i = 0; i < 5 && !textarea; i += 1) {
            try {
              textarea = (await this.page.$(sel)) ?? null;
            } catch {
              textarea = null;
            }
            if (!textarea) await sleep(200);
          }
          if (textarea) break;
        }
        if (!textarea) throw new Error('未找到输入框');

        logger.info(
          `[chatglm] _send_message(): URL=${this.page.url()}, ` +
            `找到输入框=True, 尝试=${attempt + 1}`,
        );

        // 清空输入框
        await this.page.evaluate(iife(CLEAR_INPUT_JS));

        // 填入消息。fill() 同时支持 textarea 与 [contenteditable]，且内部自行 focus，
        // 不依赖鼠标点击 → 不会被浮层拦截。
        // ⚠️ 必须包超时：元素不可编辑时 fill() 会一直等「可见/可编辑」，
        //    实测能把整个请求拖到 300s 中间件超时（2026-09-28 的 504）。
        //    超时后走下面的键盘输入兜底。
        try {
          await withTimeout(textarea.fill(message), 20000, 'fill()');
        } catch (error) {
          logger.warn(`[chatglm] fill() 失败/超时，回退键盘输入: ${String(error)}`);
          try {
            // ⚠️ 必须传**真函数**：传函数字符串同样不会被调用（见 js-eval.ts）
            await withTimeout(
              textarea.evaluate((el: SVGElement | HTMLElement) => (el as HTMLElement).focus()),
              10000,
              'focus()',
            );
          } catch {
            // 焦点失败也继续尝试键盘输入
          }
          await this.page.keyboard.type(message, { delay: 5 });
        }

        // 回读校验：确认内容真的进了输入框（否则「清空」会被误判为发送成功）
        const filledLen = await this.inputValueLen();
        if (filledLen <= 0) throw new Error('输入框内容为空，fill() 未生效');
        logger.info(`[chatglm] 输入框已填入 ${filledLen} 字符`);

        // 重新获取句柄：Vue 重渲染后旧句柄可能脱离 DOM
        let ta2: ElementHandle<SVGElement | HTMLElement> | null = null;
        for (const sel of INPUT_SELECTORS) {
          ta2 = (await this.page.$(sel)) ?? null;
          if (ta2) break;
        }
        const target = ta2 ?? textarea;

        // 提交：第 1 次用 Enter；第 2 次优先点发送按钮（force 绕过遮挡）
        let submitted = false;
        if (attempt === 1) {
          const btn = await this.findSendButton();
          if (btn) {
            try {
              await btn.click({ force: true, timeout: 5000 });
              submitted = true;
              logger.info('[chatglm] _send_message(): 已点击发送按钮');
            } catch (error) {
              logger.warn(`[chatglm] 发送按钮点击失败，回退 Enter: ${String(error)}`);
            }
          }
        }
        if (!submitted) {
          // 用元素级 press（内部会先 focus），避免 page.keyboard 因焦点
          // 被浮层/Vue 重渲染抢走而把 Enter 丢给别的元素
          try {
            await target.press('Enter', { timeout: 5000 });
          } catch (error) {
            logger.warn(`[chatglm] 元素级 Enter 失败，回退 page.keyboard: ${String(error)}`);
            await this.page.keyboard.press('Enter');
          }
        }

        // 校验：新对话轮次 或 输入框被清空
        if (await this.waitSendSuccess(beforeCount, 12)) {
          this.lastSendTime = Date.now();
          await this.markUsed();

          // 记下「当前页面上的会话属于哪个逻辑会话」，供下一次请求判断能否沿用
          // （只发增量）而不是重开新对话。
          // ⚠️ 必须**无条件覆盖**（包括 sessionKey=null）：两轮策略的 reparse 会带着
          //    null 往页面里发一次转换请求，页面此时已经切到别的会话；若还留着旧的
          //    sessionKey，下一次请求就会把「增量」发进错误的会话里 → 上下文丢失。
          this.sessionKey = sessionKey;
          this.sessionPage = this.page;
          logger.info('[chatglm] 消息已确认提交');
          return;
        }

        logger.warn(
          `[chatglm] 第 ${attempt + 1} 次发送后未检测到新对话轮次，准备重试`,
        );
      } catch (error) {
        lastError = error;
        logger.warn(`[chatglm] 第 ${attempt + 1} 次发送异常: ${String(error)}`);
      }
      await sleep(1000);
    }

    this.lastSendTime = Date.now();
    await this.markUsed();
    throw new Error(`消息发送失败：多次尝试后仍未检测到新对话轮次 (${String(lastError)})`);
  }

  /* ================================================================== */
  /* 对外接口                                                            */
  /* ================================================================== */

  /** 创建新会话（ChatGLM 不需要，返回固定 ID）。 */
  async createConversation(): Promise<string> {
    return 'default_conversation';
  }

  /** 删除会话（ChatGLM 不需要实现）。 */
  async deleteConversation(_conversationId: string): Promise<void> {
    // 空实现：ChatGLM 侧没有可删除的会话对象
  }

  /** 非流式聊天（调用 `streamResponse` 并聚合）。 */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    await this.ensureInitialized();

    let content = '';
    try {
      for await (const response of this.streamResponse(request)) {
        if (response.error) return { error: response.error };
        if (response.content) content += response.content;
      }
    } catch (error) {
      return { error: String(error) };
    }

    return { content: sanitizeMessage(content) };
  }

  /**
   * 流式聊天。
   *
   * **必须串行化**：整个 provider 只有 1 个浏览器页面，若两个请求同时在页面上
   * 发消息，ChatGLM 会返回「请等待其他对话生成完毕 / 本次回答已被终止 / 重新回答」，
   * 并且该提示会被当成正常回复返回给客户端。
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    logger.info('[chatglm] chatStream() 被调用（等待串行锁）');

    const release = await this.lock.acquire();
    logger.info('[chatglm] 已获得串行锁，开始处理请求');

    // 占住「正在这个账号上干活」的登记：主通道换号时靠它避开
    // 正在被辅助通道使用的账号（否则切过去立刻撞平台并发提示）。
    enterAccount(PLATFORM, this.accountId);

    // 请求方（routes）可要求把这次对话放到「辅助页面」上跑：两轮策略的 reparse
    // 要往网页里再发一次对话，若共用主页面就会把当前会话切走 ——
    // 主会话上下文丢了、会话复用（只发增量）失效。
    //
    // ⚠️ 判据是**角色**（`isMainChannel`）而不是「是否在专用页面上」：
    //    主通道被限流后切到另一个账号的独立页面时，它依然是主通道，
    //    这时它自己的页面就是主会话页面，辅助请求**仍必须**另开页面。
    const ctx = request.context ?? {};
    const useAux = Boolean(ctx['use_aux_page']) && this.isMainChannel;
    const savedPage = useAux ? await this.enterAuxPage() : null;

    try {
      // ⚠️ 走「辅助页面」的请求（压缩/转换回落到本实例时）**不参与轮换**：
      //    它已经切到辅助页、并由 `finally` 负责切回主页面，
      //    此时再换账号会把两者状态搅在一起（换号后又被切回旧页面）。
      const canRotateHere = this.allowRotate && !useAux;

      // 进门前若当前账号正在冷却（刚被限流过）→ 先换到空闲账号，
      // 省掉一轮注定失败的往返
      if (canRotateHere) await this.rotateIfCoolingOnEntry(request);

      const fullMsg = asString(ctx['full_message'])?.trim() ?? '';
      const tried = new Set<string>([this.accountId]);
      let rotations = 0;

      for (;;) {
        await this.ensureInitialized();

        logger.info('[chatglm] 开始迭代 _stream_response()');
        for await (const response of this.streamResponse(request)) {
          logger.debug(
            `[chatglm] yield response, content_len=${response.content ? response.content.length : 0}`,
          );
          yield response;
        }

        // 没撞到平台限制 → 正常结束
        if (!this.lastLimitNotice) break;

        const notice = this.lastLimitNotice;
        this.lastLimitNotice = null;

        // 被限流 → 当前账号进冷却（后面的请求不再优先用它）
        markAccountCooldown(PLATFORM, this.accountId, this.ROTATE_COOLDOWN);
        logger.warn(
          `[chatglm] 账号 ${this.accountId} 撞到平台限制「${notice}」，` +
            `标记冷却 ${this.ROTATE_COOLDOWN.toFixed(0)}s`,
        );

        const target = canRotateHere ? this.pickRotateAccount(tried) : null;
        if (!target || rotations >= this.MAX_ROTATE_PER_REQUEST) {
          // 没得换（只有一个账号 / 别的账号都在忙或在冷却）→ 回传提示，
          // 让客户端至少知道发生了什么，而不是拿到空回复
          logger.warn(`[chatglm] 没有可切换的账号（候选=${[...tried].join(',')}），回传平台限制提示`);
          yield {
            content:
              `[ChatGLM 平台限制] ${notice}。` +
              '本次请求未得到回复，请稍等 1~2 分钟后重试。',
          };
          break;
        }

        logger.warn(
          `[chatglm] 账号 ${this.accountId} 被限流 → 切换到 ${target} 重试` +
            `（换号 = 新网页会话，改发完整提示词 ${fullMsg.length} 字符）`,
        );
        this.rotateToAccount(target);
        tried.add(target);
        rotations += 1;

        // ⚠️ 换了账号 = 新网页会话，绝不能发增量（那会丢掉全部上下文）。
        //    `request.message` 平时可能是增量；这里显式换成完整提示词。
        if (fullMsg) {
          request.message = fullMsg;
          delete ctx['delta_message'];
        }
      }
    } catch (error) {
      logger.error(`流式聊天失败: ${String(error)}`);
      yield { error: String(error) };
    } finally {
      exitAccount(PLATFORM, this.accountId);
      if (useAux) await this.leaveAuxPage(savedPage);
      release();
      logger.info('[chatglm] 释放串行锁');
    }
  }

  /* ================================================================== */
  /* 主通道账号轮换（被限流 / 额度耗尽时换另一个账号继续答）              */
  /* ================================================================== */

  /** 同平台所有可用账号 ID（排除没有 Cookie 的）。 */
  private accountCandidates(): string[] {
    const out: string[] = [];
    try {
      for (const acc of listAccounts(PLATFORM)) {
        const auth = loadAuth(PLATFORM, { accountId: acc });
        if (auth?.cookies?.length) out.push(acc);
      }
    } catch (error) {
      logger.warn(`[chatglm] 列出候选账号失败: ${String(error)}`);
    }
    return out;
  }

  /**
   * 挑一个可以接手的账号。
   *
   * 跳过：本轮已经试过的、正在冷却的、此刻正被别的角色（辅助通道）使用的。
   * 被**闲置登记**（`role` 有记录但此刻不忙）占着的账号允许抢占 ——
   * 辅助通道会在下一次挑账号时自动避开它。
   */
  private pickRotateAccount(exclude: ReadonlySet<string>): string | null {
    for (const acc of this.accountCandidates()) {
      if (exclude.has(acc)) continue;
      if (accountCooldownRemaining(PLATFORM, acc) > 0) continue;
      if (isAccountBusy(PLATFORM, acc)) {
        logger.info(`[chatglm] 账号 ${acc} 正在被其他通道使用，跳过`);
        continue;
      }
      return acc;
    }
    return null;
  }

  /**
   * 把主通道切到指定账号（走「独立 context 的专用页面」）。
   *
   * ⚠️ 必须换 context：不同账号 = 不同 Cookie jar。沿用全局页面会把
   * 新账号的 Cookie 加到旧账号的 context 上，等于没换。
   */
  private rotateToAccount(accountId: string): void {
    const old = this.accountId;
    clearAccountRole(PLATFORM, old, 'main');

    // busy 占用必须跟着换号一起转移：`enterAccount()` 是进门时按「旧账号」登记的，
    // 而 `chatStream()` 的 finally 会用「新账号」调 `exitAccount()`。
    // 不转移 → 旧账号被永久标记为「正忙」（辅助通道/后续换号都不敢再用它）。
    transferAccountBusy(PLATFORM, old, accountId);

    this.accountId = accountId;
    this.channelKey = `${PLATFORM}:${accountId}`;

    // 页面/session 状态全部作废：下一个账号是全新的网页会话
    this.page = null;
    this.sessionKey = null;
    this.sessionPage = null;
    this.responseJsInjected = false;
    this.cookiesLoaded = true; // Cookie 由通道 context 注入，不再走全局 loadCookies
    this.loggedIn = false;
    this.lastLoginCheck = 0;
    setAccountRole(PLATFORM, accountId, 'main');
  }

  /** 请求进门时，若当前账号还在冷却中就直接换号（省一轮注定失败的往返）。 */
  private async rotateIfCoolingOnEntry(request: ChatRequest): Promise<void> {
    if (!this.allowRotate) return;
    if (accountCooldownRemaining(PLATFORM, this.accountId) <= 0) return;

    const target = this.pickRotateAccount(new Set([this.accountId]));
    if (!target) {
      logger.info(
        `[chatglm] 账号 ${this.accountId} 仍在冷却中，但没有可切换的账号 → 继续使用`,
      );
      return;
    }

    logger.info(`[chatglm] 账号 ${this.accountId} 仍在冷却中 → 进门即切换到 ${target}`);
    this.rotateToAccount(target);

    const full = asString((request.context ?? {})['full_message'])?.trim() ?? '';
    if (full) {
      request.message = full;
      delete (request.context ?? {})['delta_message'];
    }
  }

  /* ================================================================== */
  /* 辅助页面（两轮策略的 reparse 专用，与主会话隔离）                    */
  /* ================================================================== */

  /**
   * 切到辅助页面，并把主页面状态原样收好（返回 saved，失败返回 null）。
   *
   * 辅助页面是**懒创建**且长期保留的：它专供 reparse 使用，
   * 每次 reparse 都会在它上面开一个新对话（不影响主页面上的会话）。
   */
  private async enterAuxPage(): Promise<{
    page: Page | null;
    sessionKey: string | null;
    sessionPage: Page | null;
  } | null> {
    const saved = {
      page: this.page,
      sessionKey: this.sessionKey,
      sessionPage: this.sessionPage,
    };

    try {
      let page = this.auxPage;
      if (page === null || page.isClosed()) {
        page = await newWorkPage();
        this.auxPage = page;
      }
      if (page === null) return null;

      this.page = page;

      // ⚠️ 每次进来都重开一个干净的对话页（不能只在「不在 chatglm 站点」时导航）：
      //    实测复用旧辅助页面时踩到输入框不可编辑（上一轮生成没结束 / 有浮层 /
      //    Vue 状态异常），`fill()` 会一直等「元素可见可编辑」直到请求 300s 超时
      //    （2026-09-28 21:30 的 504 就是这么来的）。
      //    辅助页面是草稿页，重开成本只有 1~2s，换来的是稳定。
      try {
        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.dismissBlockingOverlay();
        await sleep(1000);
      } catch (error) {
        logger.warn(`[chatglm] 辅助页面重开失败（继续尝试使用）: ${String(error)}`);
      }

      this.sessionKey = null; // 辅助页面上没有可复用的主会话
      this.sessionPage = null;
      logger.info('[chatglm] 已切到辅助页面（独立对话，主会话保持不变）');
      return saved;
    } catch (error) {
      logger.warn(`[chatglm] 切到辅助页面失败，将使用主页面: ${String(error)}`);
      this.page = saved.page;
      this.sessionKey = saved.sessionKey;
      this.sessionPage = saved.sessionPage;
      return null;
    }
  }

  /** 从辅助页面切回主页面（主会话上下文完好，可继续复用）。 */
  private async leaveAuxPage(
    saved: { page: Page | null; sessionKey: string | null; sessionPage: Page | null } | null,
  ): Promise<void> {
    if (!saved) return;
    this.page = saved.page;
    this.sessionKey = saved.sessionKey;
    this.sessionPage = saved.sessionPage;
    logger.info('[chatglm] 已切回主页面（主会话上下文保持，后续可继续只发增量）');
  }
}
