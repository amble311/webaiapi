/**
 * ChatGPT 浏览器 Provider —— 驱动 `chatgpt.com` 网页版（2026-10-19 新增）。
 *
 * ## 为什么走「页面驱动 + 抓流」而不是直调 API
 * ChatGPT 的 `POST /backend-api/conversation` 需要 `openai-sentinel-*` 一串由页面 JS 现算的
 * 证明（PoW/风控），并且还要过 Cloudflare —— 自己造请求几乎必败。所以和 deepseek 一样：
 * **在页面里输入并发送**（页面自己算证明），**抓它自己的 SSE**。
 *
 * ## 实测契约（详见 `chatgpt-sse.ts` 的文件头）
 * - 输入框：首页先有占位 `<textarea id="pending-home-input">`（React 未接状态，键入无效），
 *   **点一下**才换成真正的 `<div contenteditable="true">`；水合要 **10~45s**（必须轮询等）。
 * - 发送：`keyboard.type`（真实按键，`fill` 不触发 React）→ `button[aria-label="Send"]` 变可用 → 点击。
 * - 流：`event: delta` + `data: {"v":{"message":…}}` / `{"p":"/message/…","o":"append|replace",…}`，
 *   结束于 `status=finished_successfully` + `end_turn=true` 或 `[DONE]`。
 *
 * ⚠️ 已知取舍（与 deepseek 同）：没有会话复用，每轮发完整提示词（由路由层的历史压缩兜住）；
 * `deleteConversation` 未实现（平台侧删除是 UI 操作）。
 */
import type { Page } from 'playwright';

import { logger } from '../log/logger.js';
import { logError } from '../log/error-log.js';
import { evaluateFn, iife } from '../browser/js-eval.js';
import { STEALTH_JS } from '../browser/stealth.js';
import { getChannelPage, loadCookies, peekPage } from '../browser/manager.js';
import { PlatformUnavailableError } from '../utils/errors.js';
import { BaseProvider, type ChatRequest, type ChatResponse } from './base.js';

const PLATFORM = 'chatgpt';
const HOME_URL = 'https://chatgpt.com/';

/** 真实编辑器（水合完成后才有）。 */
const EDITOR_SELECTOR = '#prompt-textarea, [contenteditable="true"]';
/** 水合前的占位输入框（点它一次会触发换成真实编辑器）。 */
const PLACEHOLDER_SELECTOR = '#pending-home-input, textarea[placeholder*="Ask ChatGPT"]';
const SEND_SELECTOR = 'button[aria-label="Send"], button[aria-label="发送"]';

/** 等编辑器出现的最长时间。
 *
 * ⚠️⚠️ 2026-10-22 真机实测（headless + 该网络环境）：`goto` 3s 成功、`readyState` 16s 到
 * `interactive`，但编辑器要到 **46s** 才出现；`goto` 遇到网络抖动（`NS_ERROR_NET_PARTIAL_TRANSFER`）
 * 时还要再重试 —— 原来 60s 的预算刚好卡死在边界上 ✗（日志「输入框在 60s 内没渲染出来」）。
 * 整个 HTTP 请求有 300s，这里给到 180s。 */
const EDITOR_WAIT_MS = 180_000;

/** 编辑器等待期间的进度日志间隔。 */
const EDITOR_PROGRESS_MS = 15_000;
/** 轮询间隔。 */
const POLL_MS = 700;
/** 多久没有任何新内容就判定卡住。 */
const IDLE_TIMEOUT_MS = 120_000;

/**
 * 检测到「说完了」之后，还要**静置**这么久没有新增才收尾。
 *
 * ⚠️⚠️ 2026-10-22 实测：ChatGPT 的长回答可能**分多次请求推送**（续写/分段），
 * 一看到 `finished` 就返回 → 用户在「昨天我们主要在推进」这种半句处被截断 ✗。
 */
/** 提示词长度守卫（与其它 provider 同量级）。 */
const MAX_INPUT_LEN = 64_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提示词长度守卫（纯函数，可单测）：超长保留**末尾**并告警。 */
export function guardChatgptPrompt(message: string): string {
  if (message.length <= MAX_INPUT_LEN) return message;
  logger.warn(
    `[chatgpt] 提示词 ${message.length} 字符超过上限 ${MAX_INPUT_LEN}，已截断` +
      '（正常应由路由层的历史压缩处理）',
  );
  return message.slice(-MAX_INPUT_LEN);
}


/** 登录态探测（页面内调 `/api/auth/session`，cookie 认证）。 */
function sessionProbeJs(): string {
  return `async () => {
  try {
    const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json();
    return {
      ok: Boolean(d && d.user),
      email: String((d && d.user && d.user.email) || ''),
      hasToken: Boolean(d && d.accessToken),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}`;
}

/**
 * 读 DOM 里的最后一条助手回复 **并判断它是否还在生成**。
 *
 * ⚠️⚠️ 2026-10-22 实测两次截断的教训：
 * - 「两次轮询文本相同」**不能**当成生成结束（模型中途停顿 0.7s 很常见 ✗）；
 * - 真正可靠的信号是页面上有没有 **停止生成（Stop）按钮** —— 生成中它一直在，
 *   生成结束才变回 Send ✓。
 */
/** 读一段页面文本的脚本（函数表达式，交给 iife 包装）。 */
const READ_DOM_TEXT_JS = `() => {
  /* ⚠️⚠️ 2026-10-22 真机实测（两轮）：用"整个 body 的文本"提取会被**页面噪音**污染 ✗ ——
   * 第一版拿到的是 "ChatGPT is responding…You're using the free version of ChatGPT…Try Plus free"，
   * 全是 UI 提示而不是回答。
   *
   * 正确做法：**定位「包含 ChatGPT said: 的最内层元素」**（= 那一条消息块本身），
   * 只取它的文本；多条时取最后一条（最新回答）。这样天然排除页脚/侧边栏/升级提示。
   *
   * ⚠️ 本段在 TS 模板字符串里：**不写反斜杠转义**（换行用 String.fromCharCode(10)）。
   * ⚠️ 注释里不许出现反引号（会提前终止模板字符串）。 */
  const NL = String.fromCharCode(10);
  const MARK = 'ChatGPT said:';

  const ownText = (el) => {
    try {
      let t = String(el.innerText || '');
      if (!t) t = String(el.textContent || '');
      return t;
    } catch (e) {
      return '';
    }
  };

  /* 找「包含标记的**最内层**元素」：从所有匹配者里挑文本最短的那个，
   * 再在同样短的里面取**文档顺序最后**的（= 最新一条回答）。 */
  let candidates = [];
  try {
    const all = document.querySelectorAll('div, section, article, main, li');
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      const t = ownText(el);
      if (t && t.indexOf(MARK) >= 0) candidates.push({ el, len: t.length, i });
    }
  } catch (e) {
    candidates = [];
  }

  let text = '';
  let found = false;
  if (candidates.length > 0) {
    const minLen = Math.min.apply(null, candidates.map((c) => c.len));
    const narrowed = candidates.filter((c) => c.len <= minLen * 1.5);
    const last = narrowed[narrowed.length - 1];
    const raw = ownText(last.el);
    const idx = raw.lastIndexOf(MARK);
    text = idx >= 0 ? raw.slice(idx + MARK.length) : '';
    found = true;
  }

  /* 生成状态：页面上有「停止生成」按钮 = 还在写 */
  let generating = false;
  try {
    generating = Array.from(document.querySelectorAll('button')).some((b) =>
      /stop/i.test(String(b.getAttribute('aria-label') || '')),
    );
  } catch (e) {
    generating = false;
  }

  /* 占位/壳文案（出现这些说明**还没开始真正作答**） */
  const isPlaceholder =
    !text.trim() ||
    /ChatGPT is responding/i.test(text) ||
    /^(Thinking|Thinking\.\.\.)$/im.test(text.trim());

  const bodyText = String((document.body && document.body.textContent) || '');
  const complete = /Response complete/i.test(bodyText) && !generating && !isPlaceholder;

  /* 清掉消息块里的零散 UI 尾巴 */
  text = text
    .split(NL)
    .filter((line) => {
      const l = line.trim();
      if (!l) return true;
      if (/ChatGPT is responding/i.test(l)) return false;
      if (/free version of ChatGPT|Upgrade for advanced models|Try Plus/i.test(l)) return false;
      if (/^(Copy|Good response|Bad response|Regenerate|Edit|Share|Read aloud)$/i.test(l)) return false;
      return true;
    })
    .join(NL)
    .trim();

  return {
    text: isPlaceholder ? '' : text,
    complete,
    generating,
    rawLen: text.length,
    hasMarker: found,
  };
}`;

/**
 * 读页面上的助手回复（**遍历所有 frame**）。
 *
 * ⚠️⚠️ 2026-10-22 真机定位：
 * - `document.body.innerText` 在这个页面**不可用**（只有 112~386 字符 ✗）；
 * - `textContent` 去掉脚本后也只有 ~700 字符 ✗ —— 对话**不在主文档里** ✗；
 * - 但页面有 **1 个 iframe**（`frames: 1` ✓），对话内容在**那个 frame** 里 ✓。
 * 所以：逐个 frame 读，取内容最丰富的那个。
 */
async function readDomAnswerState(
  page: Page,
): Promise<{
  text: string;
  complete: boolean;
  generating: boolean;
  rawLen?: number;
  hasMarker?: boolean;
}> {
  type State = {
    text: string;
    complete: boolean;
    generating: boolean;
    rawLen?: number;
    hasMarker?: boolean;
  };
  let best: State = { text: '', complete: false, generating: false, rawLen: 0, hasMarker: false };

  /* ⚠️ **优先主 frame**（2026-10-22 实测：遍历 page.frames() 时拿到的是 about:blank 或
   * 跨域子 frame → 全部抛错 → raw=0 ✗；而主 frame 里那段脚本单独跑是好的 ✓）。 */
  const ordered = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of ordered) {
    try {
      const state = (await frame.evaluate(iife(READ_DOM_TEXT_JS))) as State | null;
      if (!state) continue;
      if (process.env['CHATGPT_DEBUG_DOM'] === '1') {
        logger.info(
          `[chatgpt:frame] ${frame.url().slice(0, 60)} raw=${state.rawLen ?? 0} marker=${state.hasMarker ? 'y' : 'n'}`,
        );
      }
      if (Number(state.rawLen ?? 0) > Number(best.rawLen ?? 0)) best = state;
      // 已经找到带标记（真正对话）的 frame 就没必要继续
      if (state.hasMarker && state.complete) break;
    } catch (frameError) {
      if (process.env['CHATGPT_DEBUG_DOM'] === '1') {
        logger.warn(
          `[chatgpt:frame] ${frame.url().slice(0, 60)} 读取失败: ${String(frameError).slice(0, 200)}`,
        );
      }
    }
  }

  return {
    text: String(best.text ?? '').trim(),
    complete: Boolean(best.complete),
    generating: Boolean(best.generating),
    rawLen: Number(best.rawLen ?? 0),
    hasMarker: Boolean(best.hasMarker),
  };
}

/**
 * 失败现场快照：把页面状态 + 截图落盘，并写一条结构化异常记录。
 *
 * ⚠️ 为什么要它（2026-10-22 实测）：ChatGPT 失败时只有一句「没抓到对话流」，
 * 完全看不出页面当时是什么状态（限流提示？登录页？还是发送没生效？）。
 * 抓一次「URL + 正文前 1500 字 + 编辑器状态 + 截图」，下次一眼就能定性。
 */
async function captureFailureSnapshot(
  page: Page,
  phase: string,
  context: {
    requestId?: string;
    model?: string;
    accountId?: string;
    /** 额外的观测结果（会合并进快照）。 */
    extra?: Record<string, unknown>;
  },
  error: unknown,
): Promise<string> {
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot =
      (await evaluateFn<Record<string, unknown>>(
        page,
        `() => {
  try {
    const el = document.querySelector('#prompt-textarea, [contenteditable="true"], #pending-home-input');
    return {
      url: String(location.href),
      title: String(document.title || ''),
      bodyText: String((document.body && document.body.innerText) || '').slice(0, 1500),
      editorText: String((el && (el.innerText || el.value)) || '').slice(0, 200),
      hasEditor: Boolean(el),
      bodyLength: String((document.body && document.body.innerText) || '').length,
    };
  } catch (e) {
    return { error: String(e) };
  }
}`,
      ).catch(() => ({}))) || {};
  } catch {
    // 忽略
  }

  try {
    await page.screenshot({ path: '/tmp/chatgpt-failure.png', fullPage: false });
    snapshot['screenshot'] = '/tmp/chatgpt-failure.png';
  } catch {
    // 忽略
  }

  return logError(
    {
      requestId: context.requestId,
      model: context.model,
      platform: PLATFORM,
      accountId: context.accountId,
      phase,
      extra: { ...(context.extra ?? {}), ...snapshot },
    },
    error,
  );
}

/**
 * 把文本写进编辑器（**瞬时**）。
 *
 * ⚠️⚠️ 2026-10-21 实测教训：原来是**逐字键入**（`keyboard.type`，25ms/字）——
 * 真实请求的提示词 = system + 20+ 个工具描述 = **上万字符** ✗
 * → 键入要 5~10 分钟，早就超过 300s 请求超时 ✗；而且键入过程中 React 重渲染还会**丢字**
 * （日志里「编辑器文本 8 字符」✗）。
 *
 * 现在用 `document.execCommand('insertText')`：浏览器会生成**真实的 beforeinput/input 事件**
 * （React/ProseMirror 都认 ✓），且是**瞬时**的 ✓。
 */
async function fillEditor(page: Page, text: string): Promise<boolean> {
const ok = await evaluateFn<boolean>(
    page,
    `() => {
try {
    const el = document.querySelector('#prompt-textarea, [contenteditable="true"]');
    if (!el) return false;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return document.execCommand('insertText', false, ${JSON.stringify(text)});
} catch (e) {
    return false;
}
}`,
).catch(() => false);
return Boolean(ok);
}

/** 读编辑器当前文本。 */
async function editorText(page: Page): Promise<string> {
return (
    (await evaluateFn<string>(
      page,
      `() => { const el = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}); return String((el && (el.innerText || el.value)) || ''); }`,
    ).catch(() => '')) || ''
);
}


export class ChatGptBrowserProvider extends BaseProvider {
  private readonly accountId: string;
  private readonly channelKey: string;
  private page: Page | null = null;
  private preparedFor: string | null = null;
  private lastLoginCheck = 0;
  private loggedIn = false;

  constructor(options: { accountId: string; channelKey?: string }) {
    super('chatgpt-browser');
    this.accountId = options.accountId;
    this.channelKey = options.channelKey ?? `${PLATFORM}:${options.accountId}`;
    this.models = [PLATFORM];
  }

  /** 登录态缓存时长（秒）：避免每个请求都打一次 session API。 */
  private static readonly LOGIN_CACHE_TTL = 120;

  override getAccountId(): string {
    return this.accountId;
  }

  async checkLoginStatus(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastLoginCheck < ChatGptBrowserProvider.LOGIN_CACHE_TTL * 1000) {
      return this.loggedIn;
    }
    this.lastLoginCheck = now;
    try {
      /* ⚠️ 只做「导航 + 探 session」，**不要等编辑器**（2026-10-19 实测：水合要 25~45s，
       * 等编辑器的版本会把登录态误判成 false，进而让上层以为账号不可用）。 */
      const page = await this.ensureSurface();

      /* ⚠️ 探测重试 3 次：页面可能还在导航/水合中（此时相对 URL 或文档 base 都不对，
       * 实测报 "is not a valid URL" 或 "NetworkError"）。 */
      let probe: Record<string, unknown> | null = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        probe = await evaluateFn<Record<string, unknown>>(page, sessionProbeJs()).catch(() => null);
        if (probe?.['ok']) break;
        if (attempt < 3) await sleep(1500);
      }
      if (!probe?.['ok']) {
        const where = await evaluateFn<Record<string, string>>(
          page,
          '() => ({ href: String(location.href), base: String(document.baseURI) })',
        ).catch(() => null);
        logger.warn(`[chatgpt] 探测位置: ${JSON.stringify(where ?? {})}`);
      }
      this.loggedIn = Boolean(probe?.['ok']);
      if (!this.loggedIn) {
        logger.warn(
          `[chatgpt] ${this.accountId} 登录态失效: ${JSON.stringify(probe ?? {}).slice(0, 160)}`,
        );
      }
      return this.loggedIn;
    } catch (error) {
      /* ⚠️ 用 warn 而不是 debug（2026-10-19 实测教训）：这里抛错会让上层以为"账号不可用"，
       * 藏在 debug 里根本查不到原因。 */
      logger.warn(`[chatgpt] 登录态检查失败: ${String(error).slice(0, 300)}`);
      this.loggedIn = false;
      return false;
    }
  }

  /** 拿到一个已就绪（已登录 + 编辑器可用）的页面。 */
  private async ensurePage(): Promise<Page> {
    const page = await this.ensureSurface();
    await this.waitForEditor(page);
    return page;
  }

  /** 页面 + cookie + 注入脚本 + 导航到首页（**不等编辑器**）。 */
  private async ensureSurface(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const channelPage = await getChannelPage(this.channelKey, PLATFORM, this.accountId).catch(
      () => null,
    );
    const page = channelPage ?? peekPage();
    if (!page) {
      throw new PlatformUnavailableError(PLATFORM, '浏览器页面尚未就绪（请稍后重试）');
    }
    this.page = page;

    const preparedKey = `${this.accountId}`;
    if (this.preparedFor !== preparedKey) {
      // cookie（context 级）+ 启动前注入 STEALTH / 流捕获
      await loadCookies(PLATFORM, this.accountId).catch(() => false);
      try {
        await page.context().addInitScript({ content: STEALTH_JS });
        /* ⚠️ `addInitScript` 只对**新文档**生效；页面此时可能已加载完 →
         * 必须再往**当前文档**注入一次（幂等，靠 __cgHooked 守卫）。 */
      } catch (error) {
        logger.debug(`[chatgpt] 注入脚本失败: ${String(error)}`);
      }
      this.preparedFor = preparedKey;
    }

    await this.openHome(page);

    /* ⚠️ `navigateTo` 返回时文档可能还没提交（此时 document.baseURI 仍是 about:blank，
     * 页面内相对 URL 的 fetch 会报 "is not a valid URL"）→ 等 location 真正到位。
     * 2026-10-19 实测：不等这一步会让登录态误判为 false。 */
    const urlDeadline = Date.now() + 20_000;
    while (Date.now() < urlDeadline) {
      const href = await evaluateFn<string>(page, '() => location.href').catch(() => '');
      if (String(href).startsWith('https://chatgpt.com')) break;
      await sleep(500);
    }
    return page;
  }

  /** 确保停在 ChatGPT 首页（已在该域就不重复导航）。 */
  private async openHome(page: Page): Promise<void> {
    const url = page.url();
    if (url.startsWith('https://chatgpt.com')) return;
    /* ⚠️ **必须导航我们自己的这个 page**（2026-10-19 实测）：`navigateTo()` 操作的是
     * **共享页**，对独立通道页面无效果 → 页面停在 about:blank → 探测时报
     * `NetworkError` / `is not a valid URL`，登录态误判为 false。
     * ⚠️ 用 `waitUntil: 'commit'` 且**吞掉超时**（2026-10-21 实测：chatgpt.com 的
     * `domcontentloaded` 会因 Cloudflare/水合拖到 45s 超时，但页面其实已经在加载）——
     * 真正的就绪判断交给后面的「等编辑器」。 */
    /* ⚠️ `waitUntil: 'commit'` 只等响应头；实测这个站点经常
     * `NS_ERROR_NET_PARTIAL_TRANSFER` / 30s 超时，但**页面往往已经在加载** ——
     * 所以失败**不再重试 goto**（重试只会白烧 30s 预算），直接交给 `waitForEditor` 轮询判断。 */
    try {
      await page.goto(HOME_URL, { waitUntil: 'commit', timeout: 30_000 });
    } catch (error) {
      logger.warn(
        `[chatgpt] 打开首页未完成（${String(error).slice(0, 100)}）→ 继续等编辑器渲染`,
      );
    }
    await sleep(1500);
  }

  /** 等到**真实编辑器**出现（水合慢，必须轮询；可用原始鼠标点占位框催一下）。 */
  private async waitForEditor(page: Page): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + EDITOR_WAIT_MS;
    let clicks = 0;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      const has = await evaluateFn<boolean>(page, `() => Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`).catch(
        () => false,
      );
      if (has) {
        /* ⚠️ 编辑器出现 ≠ 页面可用（2026-10-22 用户实测：控件有了但要挺久才真正就绪 ✗）。
         * 用「网络静默」作为水合完成的代理信号，再补 1.5s 余量。 */
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        await sleep(1500);
        return;
      }
      /* 进度日志：水合要几十秒，没有日志的话用户会以为卡死（2026-10-22 实测 46s）。 */
      const waited = Date.now() - startedAt;
      if (waited - lastProgress >= EDITOR_PROGRESS_MS) {
        lastProgress = waited;
        const state = await evaluateFn<Record<string, unknown>>(
          page,
          `() => ({
            url: String(location.href).slice(0, 60),
            ready: String(document.readyState),
            hasPlaceholder: Boolean(document.querySelector('#pending-home-input, textarea[placeholder*="Ask ChatGPT"]')),
          })`,
        ).catch(() => null);
        logger.info(
          `[chatgpt] 等待编辑器… ${Math.round(waited / 1000)}s ` +
            `(ready=${String(state?.['ready'] ?? '?')} 占位框=${state?.['hasPlaceholder'] ? '有' : '无'} url=${String(state?.['url'] ?? '')})`,
        );
      }

      /* 每 5 秒用**原始鼠标**点一下占位框（它被覆盖时 Playwright 的 click 会超时，
       * 但点击本身能触发内容编辑器挂载）。 */
      if (clicks < 10) {
        const box = await page
          .locator(PLACEHOLDER_SELECTOR)
          .first()
          .boundingBox()
          .catch(() => null);
        if (box) {
          await page
            .mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            .catch(() => undefined);
          clicks += 1;
        }
      }
      await sleep(2500);
    }

    const probe = await evaluateFn<Record<string, unknown>>(page, sessionProbeJs()).catch(() => null);
    throw new PlatformUnavailableError(
      PLATFORM,
      Boolean(probe?.['ok'])
        ? `页面已登录，但输入框在 ${Math.round(EDITOR_WAIT_MS / 1000)}s 内没渲染出来（前端水合慢，可稍后重试）`
        : '网页登录态无效 → 请重跑 webaiapi login chatgpt 刷新凭证',
    );
  }

  /** 在页面里输入并发送。 */
  private async sendMessage(page: Page, text: string): Promise<void> {
    const editor = page.locator(EDITOR_SELECTOR).first();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      /* 点一下编辑器确保焦点（原始鼠标：Playwright 的 click 会因遮挡超时）。 */
      const box = await editor.boundingBox().catch(() => null);
      if (box) await page.mouse.click(box.x + 24, box.y + Math.min(box.height / 2, 20));
      await sleep(300);

      await fillEditor(page, text);
      await sleep(600);

      const typed = await editorText(page);
      const sendReady = await page
        .locator(SEND_SELECTOR)
        .first()
        .isEnabled()
        .catch(() => false);

      if (sendReady) {
        await page.locator(SEND_SELECTOR).first().click({ timeout: 8000 });
        return;
      }

      /* Enter 兜底：文本确实在编辑器里，但按钮 disabled（React 状态间歇不接 ✗） */
      if (typed.trim().length > 0) {
        logger.info('[chatgpt] 发送按钮不可用但文本已在编辑器里 → 按 Enter 提交');
        await page.keyboard.press('Enter').catch(() => undefined);
        await sleep(1500);
        /* ⚠️ 「编辑器被清空」**不能**当作发送成功的证据（水合没完成时也是空的 ✗）。
         * 真正的证据由调用方校验 `convRequestSeen`。这里只做一次点击/回车尝试。 */
        return;
      }

      logger.warn(
        `[chatgpt] 输入未生效（第 ${attempt} 次）：编辑器文本 ${typed.length} 字符` +
          `（期望 ${text.length}），发送按钮仍不可用 → 重试`,
      );
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Backspace').catch(() => undefined);
      await sleep(400);
    }

    const failure = new PlatformUnavailableError(
      PLATFORM,
      '输入框填不进去/发送按钮不可用（页面可能被风控、未登录，或前端水合未完成）',
    );
    const snapshotId = await captureFailureSnapshot(page, 'chatgpt.send', { model: PLATFORM }, failure);
    logger.error(`[chatgpt] 失败现场已记录（error:${snapshotId}）→ /tmp/chatgpt-failure.png`);
    throw failure;
  }

  /**
   * 预热：把页面打开并等到编辑器就绪。
   *
   * ⚠️ ChatGPT 的页面水合要 30~90s，而整个 HTTP 请求只有 300s ——
   * 若不预热，第一个用户请求要同时付「压缩 + 冷启动」两笔成本，很容易超时
   * （2026-10-21 实测：压缩吃掉 198s，剩 73s 不够水合 ✗）。
   */
  override async warmup(): Promise<void> {
    try {
      await this.ensurePage();
      logger.info('[chatgpt] 预热完成：页面已就绪（首个请求不必再等水合）');
    } catch (error) {
      logger.warn(`[chatgpt] 预热失败（不影响后续请求，届时会重试）: ${String(error).slice(0, 160)}`);
    }
  }

  /**
   * 发消息并**以页面为准**读回复。
   *
   * ## 为什么不用流（2026-10-22 实测三次教训）
   * `POST /backend-api/f/conversation` 的 SSE **不可靠**：
   * ① `resp.text()` 偶尔拿不到内容（页面却已完整回答）；
   * ② 流会提前报 `finished`（provider 只拿到 13/32 字符）；
   * ③ 长回答可能分多次请求推送。
   * 而**页面上渲染的内容就是用户看到的** —— 所以最终以 DOM 为准：
   * 轮询页面，增量吐出；页脚出现 `Response complete` 才结束（这是 ChatGPT 自己的完成标记）。
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const page = await this.ensurePage();
    const text = guardChatgptPrompt(request.message);

    /* 发送前记基线：DOM 里只认**新出现的**答案（历史答案一直都在）。 */
    const baseline = await readDomAnswerState(page);

    /* ⚠️ 发送必须**校验真的发出去了**（页面控件出现 ≠ 可用；水合没完成时点 Send 是空操作 ✗）。 */
    let convRequestSeen = false;
    const onRequest = (req: { url: () => string }): void => {
      try {
        if (/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(req.url())) convRequestSeen = true;
      } catch {
        // 忽略
      }
    };
    page.on('request', onRequest as never);

    try {
      let sent = false;
      for (let attempt = 1; attempt <= 3 && !sent; attempt += 1) {
        try {
          await this.sendMessage(page, text);
        } catch (sendError) {
          logger.warn(
            `[chatgpt] 第 ${attempt} 次发送动作失败: ${String(sendError).slice(0, 140)} → 继续重试`,
          );
        }
        const waitUntil = Date.now() + 15_000;
        while (Date.now() < waitUntil && !convRequestSeen) await sleep(400);
        sent = convRequestSeen;
        if (!sent) {
          logger.warn(`[chatgpt] 第 ${attempt} 次发送后没有观察到对话请求（页面可能还没水合完）→ 重试`);
          await sleep(3000);
        }
      }
      if (!sent) {
        const failure = new PlatformUnavailableError(
          PLATFORM,
          '发送后没有产生对话请求（页面控件已出现但前端水合未完成）→ 稍后重试，或先手动打开一次 ChatGPT',
        );
        await captureFailureSnapshot(
          page,
          'chatgpt.send.no-request',
          { model: PLATFORM, accountId: this.accountId, extra: { convRequestSeen } },
          failure,
        );
        throw failure;
      }

      const startedAt = Date.now();
      const deadline = Math.min(
        request.deadlineTs ?? Number.POSITIVE_INFINITY,
        startedAt + 10 * 60_000,
      );
      let emitted = '';
      let lastGrowth = Date.now();
      let sawNewAnswer = false;

      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const state = await readDomAnswerState(page);

        /* 等新答案出现：DOM 可能还停在上一轮的文本（与基线相同）→ 先别吐。 */
        if (process.env['CHATGPT_DEBUG_DOM'] === '1') {
          logger.info(
            `[chatgpt:dom] text=${state.text.length} raw=${state.rawLen ?? 0} marker=${state.hasMarker ? 'y' : 'n'} complete=${state.complete} generating=${state.generating} baseline=${baseline.text.length}`,
          );
        }

        if (!sawNewAnswer) {
          if (state.text.length > 0 && state.text !== baseline.text) sawNewAnswer = true;
          else continue;
        }

        if (state.text.length > emitted.length) {
          const delta = state.text.slice(emitted.length);
          emitted = state.text;
          lastGrowth = Date.now();
          yield { content: delta, model: PLATFORM };
        }

        /* **页面说完成**才算完成（`Response complete`）—— 这是 ChatGPT 自己的标记 ✓。 */
        if (state.complete && emitted.length > 0) {
          if (process.env['CHATGPT_DUMP_STREAM'] === '1') {
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync('/tmp/chatgpt-last-answer.txt', emitted, 'utf8');
            } catch {
              // 忽略
            }
          }
          logger.info(
            `[chatgpt] 本轮结束（正文 ${emitted.length} 字符，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，页面标记 Response complete）`,
          );
          return;
        }

        /* 兜底：页面长时间没有任何变化（关掉了页面 / 平台卡住）。 */
        if (Date.now() - lastGrowth > IDLE_TIMEOUT_MS) {
          if (emitted.length > 0) {
            logger.warn(
              `[chatgpt] ${IDLE_TIMEOUT_MS / 1000}s 无新内容但有部分正文（${emitted.length} 字符）→ 结束本轮`,
            );
            return;
          }
          const probe = await evaluateFn<Record<string, unknown>>(page, sessionProbeJs()).catch(
            () => null,
          );
          if (!probe?.['ok']) {
            throw new PlatformUnavailableError(
              PLATFORM,
              '网页登录态已失效 → 请重跑 webaiapi login chatgpt 刷新凭证',
            );
          }
          const snapshotId = await captureFailureSnapshot(
            page,
            'chatgpt.stream.no-answer',
            { model: PLATFORM, accountId: this.accountId, extra: { convRequestSeen } },
            new Error('页面没有渲染出新的助手回复'),
          );
          logger.error(`[chatgpt] 失败现场已记录（error:${snapshotId}）→ /tmp/chatgpt-failure.png`);
          throw new PlatformUnavailableError(
            PLATFORM,
            `${IDLE_TIMEOUT_MS / 1000}s 内页面没有渲染出新的助手回复（详见 errors.log）`,
          );
        }
      }

      if (emitted.length > 0) {
        logger.warn(`[chatgpt] 到达截止时间但有部分正文（${emitted.length} 字符）→ 结束本轮`);
        return;
      }
      throw new PlatformUnavailableError(PLATFORM, '请求超过截止时间（deadline）');
    } finally {
      page.off('request', onRequest as never);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let content = '';
    for await (const chunk of this.chatStream(request)) {
      if (chunk.error) return { error: chunk.error } as ChatResponse;
      content += chunk.content ?? '';
    }
    return { content, model: PLATFORM } as ChatResponse;
  }

  /** 没有独立的「新建会话」概念：发送时会自动开新会话。 */
  async createConversation(): Promise<string> {
    return '';
  }

  /** 平台侧删除是 UI 操作，当前流程用不到（与 deepseek 同）。 */
  async deleteConversation(): Promise<void> {
    return;
  }
}
