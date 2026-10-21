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
import { evaluateFn } from '../browser/js-eval.js';
import { STEALTH_JS } from '../browser/stealth.js';
import { RESET_SSE_JS, SSE_CAPTURE_JS } from '../browser/sse-capture.js';
import { getChannelPage, loadCookies, peekPage } from '../browser/manager.js';
import { PlatformUnavailableError } from '../utils/errors.js';
import { BaseProvider, type ChatRequest, type ChatResponse } from './base.js';
import { extractChatgptSse } from './chatgpt-sse.js';

const PLATFORM = 'chatgpt';
const HOME_URL = 'https://chatgpt.com/';

/** 真实编辑器（水合完成后才有）。 */
const EDITOR_SELECTOR = '#prompt-textarea, [contenteditable="true"]';
/** 水合前的占位输入框（点它一次会触发换成真实编辑器）。 */
const PLACEHOLDER_SELECTOR = '#pending-home-input, textarea[placeholder*="Ask ChatGPT"]';
const SEND_SELECTOR = 'button[aria-label="Send"], button[aria-label="发送"]';

/** 等编辑器出现的最长时间（实测 10~45s；首次水合更慢）。 */
const EDITOR_WAIT_MS = 60_000;
/** 轮询间隔。 */
const POLL_MS = 700;
/** 多久没有任何新内容就判定卡住。 */
const IDLE_TIMEOUT_MS = 120_000;
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

/**
 * **专用**流捕获：hook `fetch`，只抓 `POST /backend-api/conversation` 的响应体。
 *
 * ⚠️ 为什么不用通用捕获（2026-10-19 实测）：页面加载时的 `/backend-api/accounts/check`
 * 会返回 **200KB JSON**，把通用捕获的 `text` 覆盖掉 → 我们只拿到一两个字 ✗。
 * ⚠️ 必须读 `resp.clone()`：直接读 `resp.body` 会把应用的流**抢走** ✗。
 */
function convCaptureJs(): string {
  return `(() => {
  try {
    if (window.__cgHooked) return;
    window.__cgHooked = true;
    window.__cgConv = { text: '', done: false, started: 0 };
    const orig = window.fetch;
    window.fetch = async function (...args) {
      const raw = args[0];
      const url = String((raw && raw.url) || raw || '');
      /* ⚠️ 真实端点是 POST /backend-api/f/conversation（多一层 /f/，2026-10-19 实测）。
       * 用正则精确匹配，别用子串 —— 否则会误抓 /conversations?...（历史列表，200KB JSON ✗）。
       * ⚠️ 本段代码活在 TS 模板字符串里：注释里**不许出现反引号**（会提前终止字符串）。 */
      const isConv = /backend-api\/(?:f\/)?conversation(?:\?|$)/.test(url);
      if (!isConv) return orig.apply(this, args);
      window.__cgConv = { text: '', done: false, started: Date.now() };
      const resp = await orig.apply(this, args);
      try {
        const reader = resp.clone().body.getReader();
        const dec = new TextDecoder();
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              window.__cgConv.text += dec.decode(value, { stream: true });
            }
          } catch (e) {}
          window.__cgConv.done = true;
        })();
      } catch (e) {
        window.__cgConv.done = true;
      }
      return resp;
    };
  } catch (e) {}
})()`;
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
    `(() => {
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
})()`,
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
        await page.context().addInitScript({ content: SSE_CAPTURE_JS });
        await page.context().addInitScript({ content: convCaptureJs() });
        /* ⚠️ `addInitScript` 只对**新文档**生效；页面此时可能已加载完 →
         * 必须再往**当前文档**注入一次（幂等，靠 __cgHooked 守卫）。 */
        await evaluateFn<boolean>(page, convCaptureJs()).catch(() => false);
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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await page.goto(HOME_URL, { waitUntil: 'commit', timeout: 30_000 });
        break;
      } catch (error) {
        logger.warn(
          `[chatgpt] 打开首页第 ${attempt} 次未完成（${String(error).slice(0, 100)}）→ ` +
            (attempt === 1 ? '重试' : '继续等编辑器'),
        );
        await sleep(2000);
      }
    }
    await sleep(1500);
  }

  /** 等到**真实编辑器**出现（水合慢，必须轮询；可用原始鼠标点占位框催一下）。 */
  private async waitForEditor(page: Page): Promise<void> {
    const deadline = Date.now() + EDITOR_WAIT_MS;
    let clicks = 0;
    while (Date.now() < deadline) {
      const has = await evaluateFn<boolean>(page, `() => Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`).catch(
        () => false,
      );
      if (has) return;
      /* 每 5 秒用**原始鼠标**点一下占位框（它被覆盖时 Playwright 的 click 会超时，
       * 但点击本身能触发内容编辑器挂载）。 */
      if (clicks < 6 && Date.now() + EDITOR_WAIT_MS - deadline > 0) {
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
        if ((await editorText(page)).trim().length === 0) return; // 清空 = 已提交
      }

      logger.warn(
        `[chatgpt] 输入未生效（第 ${attempt} 次）：编辑器文本 ${typed.length} 字符` +
          `（期望 ${text.length}），发送按钮仍不可用 → 重试`,
      );
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Backspace').catch(() => undefined);
      await sleep(400);
    }

    throw new PlatformUnavailableError(
      PLATFORM,
      '输入框填不进去/发送按钮不可用（页面可能被风控、未登录，或前端水合未完成）',
    );
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<ChatResponse> {
    const page = await this.ensurePage();
    const text = guardChatgptPrompt(request.message);

    await evaluateFn<boolean>(page, RESET_SSE_JS).catch(() => false);

    /* ⚠️ **用 Playwright 直接读响应体**（2026-10-21 实测：页面内 hook `fetch` 太脆弱 ——
     * 水合/导航/多处重置都会让它抓不到；而 Playwright 的 `page.on('response')` 是浏览器级，
     * 且 `resp.text()` 在流结束后给出**完整**内容，正是我们要的）。
     * 代价：**没有逐字流式**（要等整段结束）—— 先保证"完整"，流式后续再补。 */
    const bodies: string[] = [];
    let sawStream = false;
    const onResponse = (response: {
      url: () => string;
      headers: () => Record<string, string>;
      text: () => Promise<string>;
    }): void => {
      try {
        if (!/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(response.url())) return;
        const ct = String(response.headers()['content-type'] ?? '');
        if (!ct.includes('event-stream')) return;
        sawStream = true;
        void response
          .text()
          .then((body) => bodies.push(body))
          .catch(() => undefined);
      } catch {
        // 忽略
      }
    };
    page.on('response', onResponse as never);

    try {
      await this.sendMessage(page, text);

      const startedAt = Date.now();
      const deadline = Math.min(
        request.deadlineTs ?? Number.POSITIVE_INFINITY,
        startedAt + 10 * 60_000,
      );
      let lastSize = 0;
      let lastGrowth = Date.now();

      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const raw = bodies.join('\n');
        const parsed = extractChatgptSse(raw);

        if (raw.length > lastSize) {
          lastSize = raw.length;
          lastGrowth = Date.now();
        }

        if (parsed.finished && parsed.answer.length > 0) {
          /* 排查用：CHATGPT_DUMP_STREAM=1 时把**捕获到的原始响应体**落盘。
           * 2026-10-21 实测「正文只有 6 字符」就是靠它下一步定位（是 body 短，还是解析停早）。 */
          if (process.env['CHATGPT_DUMP_STREAM'] === '1') {
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync('/tmp/chatgpt-last-stream.txt', raw, 'utf8');
              logger.info(`[chatgpt] 已转储原始流: /tmp/chatgpt-last-stream.txt（${raw.length} 字节）`);
            } catch {
              // 忽略
            }
          }
          logger.info(
            `[chatgpt] 本轮结束（正文 ${parsed.answer.length} 字符，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
          );
          yield { content: parsed.answer, model: PLATFORM };
          return;
        }

        // 流已结束但解析不出正文 → 直接报错（别等到 idle 超时）
        if (parsed.answer.length === 0 && raw.length > 0 && sawStream) {
          const probe = await evaluateFn<Record<string, unknown>>(page, sessionProbeJs()).catch(
            () => null,
          );
          if (!probe?.['ok']) {
            throw new PlatformUnavailableError(
              PLATFORM,
              '网页登录态已失效 → 请重跑 webaiapi login chatgpt 刷新凭证',
            );
          }
        }

        if (Date.now() - lastGrowth > IDLE_TIMEOUT_MS && lastSize > 0) {
          throw new PlatformUnavailableError(
            PLATFORM,
            `等待回复超时（${IDLE_TIMEOUT_MS / 1000}s 无新增内容，已收到 ${lastSize} 字节流）`,
          );
        }
        if (Date.now() - lastGrowth > IDLE_TIMEOUT_MS && lastSize === 0) {
          const probe = await evaluateFn<Record<string, unknown>>(page, sessionProbeJs()).catch(
            () => null,
          );
          if (!probe?.['ok']) {
            throw new PlatformUnavailableError(
              PLATFORM,
              '网页登录态已失效 → 请重跑 webaiapi login chatgpt 刷新凭证',
            );
          }
          throw new PlatformUnavailableError(
            PLATFORM,
            `没有抓到对话流（${IDLE_TIMEOUT_MS / 1000}s 内没等到 ${'backend-api/f/conversation'} 的响应）`,
          );
        }
      }
    } finally {
      page.off('response', onResponse as never);
    }

    throw new PlatformUnavailableError(PLATFORM, '请求超过截止时间（deadline）');
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
