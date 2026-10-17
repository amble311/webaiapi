/**
 * DeepSeek（`chat.deepseek.com`）浏览器 Provider。
 *
 * ## 实测契约（2026-10-16 抓包 + 真机验证，全部有据可查）
 *
 * | 环节 | 事实 |
 * |---|---|
 * | 登录态 | **cookie 不够**：页面从 `localStorage.userToken`（`{"value":"<bearer>","__version":"0"}`）取 token。用凭证里的 bearer 种进去即可登录（`/api/v0/users/current` 200） |
 * | 发送 | 输入框是 `textarea`，`fill` + `Enter` 即可（页面自己解 PoW、带全套 `x-device-*` 指纹） |
 * | 请求 | `POST /api/v0/chat/completion`，**走 XHR**（不是 fetch）→ 用 `window.__glmSSE.xhrText` 读流 |
 * | 回复 | **JSON-Patch 风格 SSE**：快照 `{"v":{"response":…}}` + 顶层补丁 `{p,o,v}`；正文增量是 `APPEND response/fragments/-1/content`；结束 = `status/quasi_status=FINISHED` 或 `event: close`（解析见 `deepseek-sse.ts`） |
 * | 耗时 | 四个字的回答实测 1.4s（`thinking_enabled` 默认 false；开了深度思考会慢得多） |
 *
 * ## 为什么走浏览器而不是 Node 直连
 * 每次对话前都要 `POST /api/v0/chat/create_pow_challenge`（PoW 由页面里的 WASM 解），
 * 外加 `HWWAFSESID` 这套 WAF 指纹 —— 纯 HTTP 复刻等于同时逆向两样东西。
 *
 * ## 范围（MVP）
 * 已实现：单轮问答（增量吐字）、账号隔离（主/辅通道共用一套逻辑）、限流信号识别、
 * 历史材料回填（`setLastRawSse`，供路由层的动作恢复轮使用）。
 * 未实现：会话复用（每次都发完整提示词，交由路由层用 `sessionKey` 判断是否增量）、
 * 平台自带「联网搜索」的关闭（页面默认可能开着，见 docs/hard-constraints.md）。
 */
import { type Page } from 'playwright';

import { logger } from '../log/logger.js';
import {
  accountCooldownRemaining,
  getBrowser,
  getChannelPage,
  loadCookies,
  markAccountCooldown,
  navigateTo,
  peekPage,
} from '../browser/manager.js';
import { loadAuth, updateAuthBearer } from '../browser/credentials.js';
import {
  classifyLoginState,
  initTokenJs,
  probeSessionJs,
} from '../browser/deepseek-session.js';
import { PlatformUnavailableError } from '../utils/errors.js';
import { RESET_SSE_JS, SSE_GET_JS } from '../browser/sse-capture.js';
import { evaluateFn } from '../browser/js-eval.js';
import { Mutex } from '../utils/mutex.js';
import { BaseProvider, type ChatRequest, type ChatResponse } from './base.js';
import { extractDeepseekSse } from './deepseek-sse.js';
import { setLastRawSse } from './chatglm-sse.js';

/** 平台名（也用作账号状态的命名空间）。 */
const PLATFORM = 'deepseek';

/** 聊天页。 */
const CHAT_URL = 'https://chat.deepseek.com/';

/** 输入框选择器（实测就是 `textarea`）。 */
const INPUT_SELECTOR = 'textarea';

/** 页面沉默多久算本轮结束（毫秒）。与 chatglm 的 90s 空闲超时一致。 */
const IDLE_TIMEOUT_MS = 90_000;

/** 轮询间隔（毫秒）：读捕获到的 XHR 流。 */
const POLL_INTERVAL_MS = 500;

/** 两次发送之间的最小间隔（秒）：同账号连发容易被平台限流。 */
const SEND_COOLDOWN_SECONDS = 10;

/** 提示词上限（字符）。与 `BROWSER_PROMPT_MAX_LEN` / chatglm 的 `MAX_INPUT_LEN` 同量级。 */
const MAX_INPUT_LEN = 64000;

/**
 * 把平台刷新出的新 token 写回凭证的最小间隔（毫秒）。
 *
 * deepseek 每次 `/api/v0/users/current` 都会下发**新 token**（轮换）；不写回的话
 * 网页登录态会隔天失效（实测：页面跳 `/sign_in`、token 被清成 `{"value":null}`）。
 * 5 分钟一次足够，不额外增加请求负担。
 */
const TOKEN_SYNC_INTERVAL_MS = 5 * 60_000;

/** 页面上的「忙 / 限流」信号（命中即判定这一轮打不出去，交给故障转移换账号）。 */
const BUSY_MARKERS = [
  '请等待其他对话生成完毕',
  '服务器繁忙',
  '当前人数过多',
  '请求过于频繁',
  'Too many requests',
];

/**
 * 提示词长度守卫（纯函数，可单测）：超长则**保留末尾**并告警。
 *
 * 为什么保留末尾：最近的对话与工具结果才是模型当前要处理的；正常路径下这里不该触发
 * （路由层已按 `BROWSER_PROMPT_MAX_LEN` 做历史压缩），触发说明预算算错了。
 */
export function guardDeepseekPrompt(message: string): string {
  if (message.length <= MAX_INPUT_LEN) return message;
  logger.warn(
    `[deepseek] 提示词 ${message.length} 字符超过上限 ${MAX_INPUT_LEN}，已截断` +
      '（正常应由路由层的历史压缩处理）',
  );
  return message.slice(-MAX_INPUT_LEN);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取页面上的登录 token（`localStorage.userToken` 的 `value`）。 */
const READ_TOKEN_JS = `() => {
  try {
    const raw = localStorage.getItem('userToken') || '';
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? String(parsed.value || '') : String(raw || '');
  } catch (e) {
    return '';
  }
}`;

/**
 * 「已判定失效」的标记是否仍然有效（**纯函数**，便于单测）。
 *
 * 语义：标记**绑定到当时的 bearer** ——
 * - 凭证没变 → 仍然失效（快速失败，不再重复导航）；
 * - 凭证变了（用户重跑了 `webaiapi login`，bearer 换了）→ **自动解除**，允许重新尝试。
 */
export function isExpiryStillValid(recordedBearer: string | null, currentBearer: string): boolean {
  if (!recordedBearer) return false;
  return recordedBearer === currentBearer;
}

/** 供测试与外部复用：这两个判据已移到 browser 层的 `deepseek-session.ts`。 */
export { classifyLoginState, initTokenJs } from '../browser/deepseek-session.js';

/** 页面上是否出现了「忙 / 限流」提示。 */
const BUSY_TEXT_JS = `() => {
  try {
    const text = (document.body && document.body.innerText) || '';
    return text.slice(0, 4000);
  } catch (e) {
    return '';
  }
}`;

export class DeepSeekBrowserProvider extends BaseProvider {
  /** 账号 id（同平台多账号）。 */
  private readonly accountId: string;

  /** 辅助通道 key：非空时用**独立 context 页面**（与主对话并行，见 router 的说明）。 */
  private readonly channelKey: string | undefined;

  private page: Page | null = null;

  private readonly lock = new Mutex();

  private lastSendTime = 0;

  /**
   * 已把哪个账号的 Cookie 灌进当前页面。
   *
   * ⚠️ 共享 context **不会**自动加载 Cookie（只有辅助通道的 `getChannelPage` 会）——
   * 实测漏掉这一步的后果：页面只有 token 没有 `ds_session_id`/`HWWAFS*` →
   * `/api/v0/users/current` 判未登录、发消息也没人理（第一版 provider 就栽在这里）。
   */
  private cookiesLoadedFor: string | null = null;

  /**
   * 已为哪个账号装过「启动前种 token」的注入脚本。
   *
   * ⚠️⚠️ **必须在页面启动前种**（`context.addInitScript`）：实测应用起来之后再写
   * `localStorage.userToken` 会被**它自己清掉/覆盖**（日志表现为「页面 token 与凭证不一致」
   * 反复重写、始终未登录）。探针里能成功正是因为用了 init script。
   */
  private tokenInitInstalledFor: string | null = null;

  /**
   * 已判定「网页登录态失效」时记下**当时的 bearer**。
   *
   * ⚠️ 为什么要记住（2026-10-17 用户反馈）：会话失效时页面停在 `/sign_in`，
   * 每次请求都重跑「导航 → 探测 → 种 token → 再导航 → 再探测」＝ 白花 20~30s，
   * 日志里看起来像「一直在重试」。记住之后**直接快速失败**，等你重登（bearer 变了）自动解除。
   */
  private expiredForBearer: string | null = null;

  /** 上次把新 token 写回凭证的时间（节流用）。 */
  private lastTokenSync = 0;

  private loggedIn = false;

  private lastLoginCheck = 0;

  private static readonly LOGIN_CACHE_TTL = 120;

  constructor(options: { accountId: string; channelKey?: string }) {
    super('deepseek-browser');
    this.accountId = options.accountId;
    this.channelKey = options.channelKey;
    this.models = ['deepseek'];
  }

  override getAccountId(): string {
    return this.accountId;
  }

  /** 登录态检查（带 120s 缓存；走**页面内**请求，见 `fetchAccountInfo` 的同一套路）。 */
  /**
   * 登录态检查（带 120s 缓存）。
   *
   * ⚠️ 用**页面自己的 token**（`probeSession`），不用凭证里那份 —— deepseek 会轮换 token，
   * 凭证里的是旧的（实测：旧 token 打 API 仍 200，但网页会话已作废）。
   */
  async checkLoginStatus(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastLoginCheck < DeepSeekBrowserProvider.LOGIN_CACHE_TTL * 1000) {
      return this.loggedIn;
    }
    this.lastLoginCheck = now;
    try {
      const page = await this.ensurePage();
      const state = await this.probeSession(page);
      this.loggedIn = state === 'ok' || state === 'unknown';
      if (state === 'expired') logger.warn(`[deepseek] ${this.accountId} 网页登录态已失效`);
      return this.loggedIn;
    } catch (error) {
      logger.debug(`[deepseek] 登录态检查失败: ${String(error)}`);
      this.loggedIn = false;
      return false;
    }
  }

  /** 非流式：收集 `chatStream` 的全部文本。 */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    let content = '';
    for await (const chunk of this.chatStream(request)) {
      if (chunk.error) return { error: chunk.error };
      if (chunk.content) content += chunk.content;
    }
    return { content, model: this.models[0] };
  }

  /**
   * 流式对话：发送 → 轮询捕获到的 XHR 流 → 增量吐字。
   *
   * ⚠️ 锁必须释放（`finally`）—— 同一账号的并发请求会互相触发平台的
   * 「请等待其他对话生成完毕」。
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const release = await this.lock.acquire();
    try {
      const page = await this.ensurePage();
      await this.ensureToken(page);

      // 同账号连发要有间隔（平台限流很敏感）
      const sinceLast = (Date.now() - this.lastSendTime) / 1000;
      if (this.lastSendTime > 0 && sinceLast < SEND_COOLDOWN_SECONDS) {
        const waitMs = (SEND_COOLDOWN_SECONDS - sinceLast) * 1000;
        logger.debug(`[deepseek] 距上次发送 ${sinceLast.toFixed(1)}s，等待 ${waitMs.toFixed(0)}ms`);
        await sleep(waitMs);
      }

      const text = guardDeepseekPrompt(request.message);
      await this.resetCapture(page);
      await this.sendMessage(page, text);
      this.lastSendTime = Date.now();

      yield* this.streamAnswer(page, request);
    } finally {
      release();
    }
  }

  /** 新对话（MVP：回到聊天首页，标题栏会给新会话）。 */
  async createConversation(): Promise<string> {
    const page = await this.ensurePage();
    await this.ensureToken(page);
    await navigateTo(CHAT_URL);
    await sleep(1500);
    return `deepseek-${Date.now()}`;
  }

  /** 删除会话：MVP 不做（平台侧删除是 UI 操作，暂不需要）。 */
  async deleteConversation(conversationId: string): Promise<void> {
    logger.debug(`[deepseek] deleteConversation 暂未实现，忽略 ${conversationId}`);
  }

  /* ================================================================== */
  /* 内部                                                                */
  /* ================================================================== */

  /** 拿到可用页面（主通道 = 共享页面；辅助通道 = 独立 context 页面）。 */
  private async ensurePage(): Promise<Page> {
    /* ⚠️ 已知失效（且凭证没变）→ 直接快速失败，不再启动/导航页面。
     * 会话失效时页面停在 `/sign_in`，重跑整套流程只是白花时间（2026-10-17 用户反馈）。 */
    if (this.isKnownExpired()) throw this.sessionExpiredError();

    if (this.page && !this.page.isClosed()) return this.page;

    if (this.channelKey) {
      const channelPage = await getChannelPage(this.channelKey, PLATFORM, this.accountId);
      if (!channelPage) throw new Error('deepseek 辅助通道页面不可用');
      this.page = channelPage;
    } else {
      const shared = await getBrowser();
      if (!shared.page) throw new Error('deepseek 浏览器页面不可用');
      this.page = peekPage();
      if (!this.page) throw new Error('deepseek 浏览器页面不可用');
    }

    const page = this.page;

    /* ⚠️ 登录态的两半：Cookie（context 级）+ token（**启动前**注入的 localStorage）——
     * 缺任何一个页面都是访客。两件事都做完**只重载一次**（每次多花 2s）。 */
    let needReload = false;
    if (this.cookiesLoadedFor !== this.accountId) {
      const ok = await loadCookies(PLATFORM, this.accountId).catch(() => false);
      if (ok) this.cookiesLoadedFor = this.accountId;
      needReload = true;
    }

    const token = String(loadAuth(PLATFORM, { accountId: this.accountId })?.bearer ?? '');
    if (!token) throw new Error('deepseek 凭证里没有 bearer（请重新登录捕获）');

    if (this.tokenInitInstalledFor !== this.accountId) {
      try {
        /* ⚠️ force=true：这是**给某个账号新装**脚本 —— 同一个 context 里可能还挂着
         * 上一个账号的脚本（它会先把旧 token 写进去），不强制覆盖就会继续用别人的 token。 */
        await page.context().addInitScript({ content: initTokenJs(token, true) });
        this.tokenInitInstalledFor = this.accountId;
        needReload = true;
        logger.info(`[deepseek] 已注入「启动前种 token」脚本（账号 ${this.accountId}，强制覆盖）`);
      } catch (error) {
        logger.warn(`[deepseek] 注入 token 脚本失败: ${String(error)}`);
      }
    }

    const url = page.url();
    if (needReload || !url.startsWith('http') || !url.includes('deepseek.com')) {
      await navigateTo(CHAT_URL);
      await sleep(2000);
    }

    /* ⚠️ **进入平台时自动判断是否登录成功**（2026-10-17 用户要求）：
     * 不能等到发消息失败才发现 —— 那时用户只会看到「页面没有输入框」这种误导性错误。
     * 判定用页面自己的 token（凭证里那份会被轮换）。
     * 失效时先补种一次（新 context 可能还没有 token），仍失效 → 明确报错停止。 */
    const state = await this.probeSession(page);
    if (state === 'expired') {
      logger.warn(`[deepseek] ${this.accountId} 进入平台时检测到网页登录态已失效，尝试补种一次`);
      await this.ensureToken(page);
      const retry = await this.probeSession(page);
      if (retry === 'expired') throw this.sessionExpiredError();
      if (retry === 'ok') logger.info('[deepseek] 补种 token 后登录态恢复正常');
    }
    return page;
  }

  /**
   * 保证页面处于登录态（Cookie + `localStorage.userToken`）。
   *
   * 现在 `ensurePage()` 已经做完了，这里只做**验证**（避免调用方以为没登录又重载一次）。
   */
  private async ensureToken(page: Page): Promise<void> {
    const token = String(loadAuth(PLATFORM, { accountId: this.accountId })?.bearer ?? '');
    if (!token) return;

    const current = (await evaluateFn<string>(page, READ_TOKEN_JS).catch(() => '')) || '';
    /* ⚠️⚠️ **只要页面有任何 token 就什么都不做**（2026-10-16 实测事故）：
     * deepseek 会轮换 token，页面持有的那份是应用自己刷新出的**更新版本**，
     * 与凭证文件不同是正常的。早期版本把「不一致」当异常 → 用旧 token 覆盖 + 重载 →
     * 页面进不去 / 找不到输入框（用户看到「模型突然不可用」）。
     * 只有页面**完全没有** token（新 context 的首次引导）才补种。 */
    if (current.length > 2) return;

    logger.info('[deepseek] 页面没有任何 token → 注入凭证里的 token 并重载');
    try {
      await page.context().addInitScript({ content: initTokenJs(token) });
      this.tokenInitInstalledFor = this.accountId;
    } catch {
      // 忽略
    }
    await navigateTo(CHAT_URL);
    await sleep(2000);
  }

  /**
   * 探测**页面**登录态（用页面自己的 token，不是凭证里那份旧的 —— 后者会被平台轮换）。
   *
   * 顺带把平台刷新出的新 token 写回凭证（节流 5 分钟），避免网页登录态隔天失效。
   *
   * ⚠️ 两个检查点都调它：
   * 1. **进入平台时**（`ensurePage`）—— 早发现、早给可操作错误；
   * 2. **回复异常时**（`streamAnswer` 的超时/无输出分支）—— 区分「登录失效」与「模型没输出」。
   */
  private async probeSession(page: Page): Promise<'ok' | 'expired' | 'unknown'> {
    const raw = await evaluateFn<{
      path?: string;
      hasToken?: boolean;
      code?: number | null;
      token?: string;
    }>(page, probeSessionJs()).catch(() => null);
    if (!raw) return 'unknown';

    const state = classifyLoginState({
      path: String(raw.path ?? ''),
      hasToken: Boolean(raw.hasToken),
      code: typeof raw.code === 'number' ? raw.code : null,
    });

    /* 维护「已失效」标记：ok 清除；expired 记下（后续请求快速失败）。 */
    if (state === 'ok') this.clearExpired();
    if (state === 'expired') this.markExpired();

    // 顺手把新 token 写回凭证（限流）
    const fresh = String(raw.token ?? '');
    if (fresh) {
      const now = Date.now();
      if (now - this.lastTokenSync >= TOKEN_SYNC_INTERVAL_MS) {
        this.lastTokenSync = now;
        if (updateAuthBearer(PLATFORM, this.accountId, fresh)) {
          logger.info('[deepseek] 平台刷新出了新 token → 已写回凭证（避免隔天网页登录态失效）');
        }
      }
    }

    return state;
  }

  /** 当前凭证里的 bearer（失败返回空串）。 */
  private credentialBearer(): string {
    return String(loadAuth(PLATFORM, { accountId: this.accountId })?.bearer ?? '');
  }

  /** 是否已知失效（凭证没变就继续快速失败；变了说明用户重登过 → 自动解除）。 */
  private isKnownExpired(): boolean {
    if (!isExpiryStillValid(this.expiredForBearer, this.credentialBearer())) {
      if (this.expiredForBearer) {
        logger.info('[deepseek] 凭证已更新（可能是重新登录）→ 解除「登录态失效」标记，重新尝试');
      }
      this.expiredForBearer = null;
      return false;
    }
    return true;
  }

  /** 标记为失效（绑定当时的 bearer）。 */
  private markExpired(): void {
    this.expiredForBearer = this.credentialBearer() || 'unknown';
  }

  /** 探测到 ok 时清除标记。 */
  private clearExpired(): void {
    this.expiredForBearer = null;
  }

  /** 登录态失效时的统一错误（503 + 可操作提示，交给路由层原样回给客户端）。 */
  private sessionExpiredError(): PlatformUnavailableError {
    return new PlatformUnavailableError(
      PLATFORM,
      '网页登录态已失效（页面跳到了 /sign_in，或平台作废了会话）。' +
        `请重跑 webaiapi login ${PLATFORM} 刷新凭证后再试`,
    );
  }

  /** 清空上一次的流捕获（否则会读到上一轮的回复）。 */
  private async resetCapture(page: Page): Promise<void> {
    try {
      await evaluateFn<unknown>(page, RESET_SSE_JS);
    } catch (error) {
      logger.debug(`[deepseek] 重置流捕获失败: ${String(error)}`);
    }
  }

  /** 把消息打进输入框并回车（页面自己解 PoW、带全套指纹）。 */
  private async sendMessage(page: Page, text: string): Promise<void> {
    const input = page.locator(INPUT_SELECTOR).first();
    let visible = true;
    try {
      await input.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      visible = false;
    }

    if (!visible) {
      /* ⚠️⚠️ **没有输入框时先判登录态，而不是先重试**（2026-10-17 用户指出）：
       * 会话失效时页面就是 `/sign_in`（或 token 被清空），重导航/重种 token 多少次都没用 ——
       * 实测旧顺序白花 20~30s、日志看起来像「一直在重试」。
       * 只有**登录态正常**（ok / unknown）时，才把「没有输入框」当作页面没加载完，
       * 做**一次**自愈重导航。 */
      const loginState = await this.probeSession(page);
      if (loginState === 'expired') {
        logger.warn('[deepseek] 页面没有输入框，且登录态已失效 → 立即停止重试');
        throw this.sessionExpiredError();
      }
      logger.warn('[deepseek] 页面没有输入框（登录态正常）→ 重新导航一次再试');
      try {
        await navigateTo(CHAT_URL);
        await sleep(3000);
        await input.waitFor({ state: 'visible', timeout: 12_000 });
        visible = true;
      } catch {
        visible = false;
      }
    }

    if (!visible) {
      /* 区分三种情况，给出**可操作**的提示（原来一律说「页面结构可能变了」，误导）：
       * ① 被踢到 /sign_in 或 token 被清成 null —— 网页登录态失效（实测常见，隔天出现）；
       * ② 页面明说要登录；
       * ③ 真的是结构变化/没加载完。 */
      const state = await evaluateFn<{ path: string; signedOut: boolean; needsLogin: boolean }>(
        page,
        `() => {
  try {
    const path = String(location.pathname || '');
    let signedOut = false;
    try {
      const raw = JSON.parse(localStorage.getItem('userToken') || '{}');
      signedOut = !raw || !raw.value;
    } catch (e) {
      signedOut = true;
    }
    const text = (document.body && document.body.innerText) || '';
    return { path, signedOut, needsLogin: /登录|Log ?in|Sign ?in/.test(text) };
  } catch (e) {
    return { path: '', signedOut: false, needsLogin: false };
  }
}`,
      ).catch(() => ({ path: '', signedOut: false, needsLogin: false }));

      const sessionGone = state.path.includes('sign_in') || state.signedOut || state.needsLogin;
      throw new Error(
        sessionGone
          ? 'deepseek 网页登录态已失效（页面跳到了 /sign_in）→ 请重跑 `webaiapi login deepseek` 刷新凭证' +
              '（API 可能仍然认旧 token，但网页会话已作废）'
          : 'deepseek 页面没有找到输入框（页面结构可能变了或未加载完）',
      );
    }

    await input.click();
    await input.fill(text);
    await input.press('Enter');
  }

  /** 读取当前捕获到的流文本（`xhrText`：deepseek 走 XHR）。 */
  private async readCapture(page: Page): Promise<string> {
    const data = await evaluateFn<{ xhrText?: string; text?: string } | null>(page, SSE_GET_JS).catch(
      () => null,
    );
    if (!data) return '';
    return String(data.xhrText || data.text || '');
  }

  /** 轮询捕获流 → 增量 yield；结束条件：解析出 FINISHED / 空闲超时 / 预算耗尽。 */
  private async *streamAnswer(page: Page, request: ChatRequest): AsyncGenerator<ChatResponse> {
    const started = Date.now();
    const deadline = request.deadlineTs ?? Number.POSITIVE_INFINITY;
    let emitted = '';
    let lastGrowth = Date.now();

    for (;;) {
      const raw = await this.readCapture(page);
      if (raw) {
        const parsed = extractDeepseekSse(raw);
        // 把材料交给路由层（动作恢复轮会用它，见 chatglm 的同名机制）
        setLastRawSse({ text: parsed.answer, think: parsed.thinking, toolCalls: [] });

        if (parsed.answer.length > emitted.length && parsed.answer.startsWith(emitted)) {
          const delta = parsed.answer.slice(emitted.length);
          emitted = parsed.answer;
          lastGrowth = Date.now();
          yield { content: delta, model: this.models[0] };
        } else if (parsed.answer !== emitted && parsed.answer.length > emitted.length) {
          // 增量不是简单追加（整段改写）→ 保守起见把差异整段吐出去
          emitted = parsed.answer;
          lastGrowth = Date.now();
          yield { content: parsed.answer, model: this.models[0] };
        }

        if (parsed.finished) {
          logger.info(
            `[deepseek] 本轮结束（status=FINISHED），正文 ${emitted.length} 字符，` +
              `思考 ${parsed.thinking.length} 字符，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
          return;
        }
      }

      const now = Date.now();
      if (now > deadline) {
        logger.warn('[deepseek] 预算耗尽，提前收尾（已收到的内容照常下发）');
        return;
      }
      if (now - lastGrowth > IDLE_TIMEOUT_MS) {
        if (!emitted) {
          /* ⚠️ **回复异常时也判断一次登录态**（2026-10-17 用户要求）：
           * 会话被平台作废时页面不会报错，只会「什么都不吐」——
           * 先判登录态，是失效就给可操作的错误，别让用户以为是模型卡了。 */
          if ((await this.probeSession(page)) === 'expired') throw this.sessionExpiredError();
          await this.throwIfBusy(page, started);
          logger.warn(`[deepseek] 等待 ${IDLE_TIMEOUT_MS / 1000}s 没有任何正文，判定本轮失败`);
          throw new Error('deepseek 本轮没有任何输出（可能是限流或页面结构变化）');
        }
        logger.warn(`[deepseek] 页面沉默 ${IDLE_TIMEOUT_MS / 1000}s，收尾`);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** 页面上出现「忙 / 限流」字样时标记冷却并抛出明确错误（交给故障转移换账号）。 */
  private async throwIfBusy(page: Page, started: number): Promise<void> {
    let text = '';
    try {
      text = await evaluateFn<string>(page, BUSY_TEXT_JS);
    } catch {
      text = '';
    }
    const hit = BUSY_MARKERS.find((m) => text.includes(m));
    if (!hit) return;

    markAccountCooldown(PLATFORM, this.accountId, 120);
    logger.warn(
      `[deepseek] 命中限流提示「${hit}」（已等待 ${((Date.now() - started) / 1000).toFixed(0)}s），` +
        `账号 ${this.accountId} 冷却 ${accountCooldownRemaining(PLATFORM, this.accountId).toFixed(0)}s`,
    );
    throw new Error(`deepseek 限流：${hit}`);
  }
}

/** 便于单测与文档：导出内部常量（不含函数，避免误用）。 */
export const __deepseekInternals = {
  MAX_INPUT_LEN,
  IDLE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  SEND_COOLDOWN_SECONDS,
  BUSY_MARKERS,
};
