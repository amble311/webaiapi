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
import { disposeChannel, getChannelPage, loadCookies, peekPage } from '../browser/manager.js';
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

/** 等编辑器出现的最长时间。
 *
 * ⚠️⚠️ 2026-10-22 真机实测（headless + 该网络环境）：`goto` 3s 成功、`readyState` 16s 到
 * `interactive`，但编辑器要到 **46s** 才出现；`goto` 遇到网络抖动（`NS_ERROR_NET_PARTIAL_TRANSFER`）
 * 时还要再重试 —— 原来 60s 的预算刚好卡死在边界上 ✗（日志「输入框在 60s 内没渲染出来」）。
 * 整个 HTTP 请求有 300s，这里给到 180s。 */
const EDITOR_WAIT_MS = 100_000;

/** 编辑器等待期间的进度日志间隔。 */
const EDITOR_PROGRESS_MS = 15_000;
/** 轮询间隔。 */
/* 轮询间隔：**1000ms**。
 * ⚠️ 2026-10-24 实测：改成 250ms 反而更糟 —— 生成期间页面内 fetch 会挂住，
 * 轮询越密堆积越多（每次 fetch 已加 2.5s 独立超时）。1s 一轮既够快又不堆积。 */
const POLL_MS = 1_000;
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
/**
 * 统计账号的「记忆（Memory）」条数。
 *
 * ⚠️⚠️ 2026-10-23 真机定位：ChatGPT 的 **Memory 是跨对话持久化**的 ——
 * 实测它把「用户指定的暗号是紫水晶」「玄猪/Auto.js 的工作规范…」都存进了记忆，
 * 于是**即使开新对话**，模型仍然带着别的项目的信息回答 ✗
 * （用户在 btc 项目里却收到 xzh 项目的内容，就是这个原因）。
 * 记忆开关是**账号级设置**，我们不改它（那是用户的个人数据），但会告警提示。
 */
async function countMemories(page: Page): Promise<number> {
  try {
    const count = await evaluateFn<number>(
      page,
      `async () => {
  try {
    const s = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
    const d = await s.json();
    const token = String((d && d.accessToken) || '');
    if (!token) return 0;
    const r = await fetch('https://chatgpt.com/backend-api/memories?include_memory_entries=true', {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      credentials: 'include',
    });
    if (!r.ok) return 0;
    const body = await r.json();
    const list = body && (body.memories || body.entries);
    return Array.isArray(list) ? list.length : 0;
  } catch (e) {
    return 0;
  }
}`,
    );
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

/**
 * 发送前把 `<tool_call>` 换成**安全标记**。
 *
 * ⚠️⚠️⚠️ 2026-10-24 真机 A/B 定位到的根因：
 *   A) 短消息 + `<tool_call>{...}</tool_call>`  → **120 秒没有任何回复** ✗
 *   B) 同样措辞但不含该标签（"你是 API 后端的工具调用层"） → 15 秒正常回复 ✓
 *   → ChatGPT 把 `<tool_call>` 当成**伪造工具调用 / 注入**，**静默拒答** ✗
 * 所以 chatgpt 平台发送前换成 `[TOOL_CALL]` / `[/TOOL_CALL]`，收到回复再换回来 ✓。
 * 只影响 chatgpt（其它平台仍用原生 `<tool_call>`）。
 */
export function sanitizePromptForChatgpt(prompt: string): string {
  return String(prompt ?? '')
    .replace(/<\/?tool_call>/gi, (m) => (m.startsWith('</') ? '[/TOOL_CALL]' : '[TOOL_CALL]'))
    .replace(/<\/?escape>/gi, '');
}

/** 把模型回复里的安全标记换回真实的 `<tool_call>`（解析器要用）。 */
export function restoreToolTags(text: string): string {
  return String(text ?? '')
    .replace(/\[\/?TOOL_CALL\]/gi, (m) => (m.startsWith('[/') ? '</tool_call>' : '<tool_call>'));
}

/**
 * 去掉 ChatGPT 正文里的 `<escape>` 包裹标签。
 *
 * ⚠️ 2026-10-24 实测：后端接口返回的工具调用正文长这样
 * `<escape><tool_call>{…}</tool_call></escape>` —— 解析器能取出工具调用 ✓，
 * 但**剩余正文**会留下 `<escape></escape>` 残渣 ✗（客户端会原样显示）。
 */
export function stripChatgptArtifacts(text: string): string {
  return String(text ?? '')
    .replace(/<\/?escape>/gi, '')
    /* ⚠️ 2026-10-24 实测：模型用自带代码解释器时，最终文本只有一个占位符 `<text>` ✗ */
    .replace(/^\s*<\/?text>\s*$/i, '')
    .replace(/<\/?text>/gi, '')
    .trim();
}

/** 从当前页面 URL 取会话 id（`/c/<uuid>`）；不在会话页则返回空串。 */
function readConversationId(page: Page): string {
  const match = /\/c\/([0-9a-f-]{8,})/i.exec(page.url());
  return match?.[1] ?? '';
}

/**
 * **从后端接口读本轮回复**（这是 2026-10-24 实测后的正解）。
 *
 * ⚠️⚠️ 为什么不再只靠 DOM：实测页面（前端）经常**卡在转圈、一直不渲染内容** ✗，
 * 但后端**其实已经生成好了** —— 同一条会话用 `GET /backend-api/conversation/<id>`
 * 能读到完整回复（那次正是 `read_file` 的工具调用），而 DOM 里 `ChatGPT said:` 一个字都没有 ✗。
 * 所以我们以接口为准：不依赖水合、不依赖渲染、也不依赖 DOM 结构改版。
 *
 * @returns `null` = 接口暂时取不到（调用方退回读 DOM）
 */
let apiWarned = false;

async function readAnswerViaApi(
  page: Page,
  conversationId: string,
): Promise<{ text: string; finished: boolean; count: number; usedOwnTools: boolean; status: number } | null> {
  try {
    const result = await evaluateFn<{
      ok: boolean;
      status?: number;
      text?: string;
      finished?: boolean;
      count?: number;
      usedOwnTools?: boolean;
      err?: string;
    }>(
      page,
      `async () => {
  /* ⚠️⚠️ 2026-10-24 实测：生成期间页面内 fetch **会一直挂着不返回** ✗ ——
   * 250ms 一轮的轮询越积越多，最后一律超时。必须给每次请求**独立超时**。 */
  const withTimeout = (url, opts, ms) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).finally(() => clearTimeout(timer));
  };

  try {
    const s = await withTimeout('https://chatgpt.com/api/auth/session', { credentials: 'include' }, 2500);
    if (!s.ok) return { ok: false, status: s.status };
    const sd = await s.json();
    const token = String((sd && sd.accessToken) || '');
    if (!token) return { ok: false };

    const res = await withTimeout('https://chatgpt.com/backend-api/conversation/' + ${JSON.stringify(conversationId)}, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      credentials: 'include',
    }, 2500);
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();

    const mapping = body && body.mapping ? body.mapping : {};
    const nodes = Object.keys(mapping).map((k) => mapping[k]);
    const messages = nodes.map((n) => n && n.message).filter(Boolean);

    /* 2026-10-24 实测：模型有时不用我们的工具，而是用 ChatGPT 自带的代码解释器
     * （content_type=code + role=tool 的 execution_output）→ 最终文本只有占位符 text。
     * 判据：最后一条 user 消息之后出现 code / execution_output。
     * 注意：本段在 TS 模板字符串里，注释中不许出现反引号。 */
    let lastUserIdx = -1;
    messages.forEach((m, i) => {
      if (m.author && m.author.role === 'user') lastUserIdx = i;
    });
    const usedOwnTools = messages.slice(lastUserIdx + 1).some((m) => {
      const ct = String((m.content && m.content.content_type) || '');
      const role = String((m.author && m.author.role) || '');
      return ct === 'code' || ct === 'execution_output' || role === 'tool';
    });
    // 只认**助手 + 文本**消息（tool 结果、model_editable_context 都不算）
    const textMsgs = messages.filter((m) => {
      const role = m.author && m.author.role;
      const ct = m.content && m.content.content_type;
      return role === 'assistant' && ct === 'text';
    });
    if (textMsgs.length === 0) return { ok: true, text: '', finished: false, count: 0 };

    const last = textMsgs[textMsgs.length - 1];
    const parts = (last.content && last.content.parts) || [];
    const text = parts.filter((x) => typeof x === 'string').join('').replace(/<\/?escape>/gi, '');
    return {
      ok: true,
      text,
      finished: String(last.status || '') === 'finished_successfully',
      count: textMsgs.length,
      usedOwnTools,
    };
  } catch (e) {
    return { ok: false, status: -1, err: String(e).slice(0, 120) };
  }
}`,
    ).catch(() => null);

    if (!result || !result.ok) {
      /* ⚠️ 404 = **这条会话在服务端根本不存在**（前端乐观显示，POST 没落地）✗。
       * 用特殊返回值让调用方能识别并重发。 */
      if (Number(result?.status) === 404) {
        return { text: '', finished: false, count: 0, usedOwnTools: false, status: 404 };
      }
      /* 只在第一次失败时打日志（轮询很密，别刷屏）。 */
      if (!apiWarned) {
        apiWarned = true;
        logger.warn(
          `[chatgpt] 接口读取失败（会话 ${conversationId.slice(0, 8)}…，status=${result?.status ?? '?'}` +
            `${result?.err ? `，${result.err}` : ''}）→ 走兜底`,
        );
      }
      return null;
    }
    return {
      text: String(result.text ?? ''),
      finished: Boolean(result.finished),
      count: Number(result.count ?? 0),
      usedOwnTools: Boolean(result.usedOwnTools),
      status: Number(result.status ?? 200),
    };
  } catch {
    return null;
  }
}

/**
 * 读页面文本的脚本（函数表达式，交给 iife 包装）。 */
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
    /* ⚠️ 2026-10-23 实测：切到新对话后，DOM 里**旧会话的编辑器还残留着（隐藏）** ——
     * 往隐藏元素 type 永远是 0 字符 ✗。必须挑**可见**的那个（有尺寸、在视口内）。 */
    const all = Array.from(document.querySelectorAll('#prompt-textarea, [contenteditable="true"]'));
    const visible = all.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const el = visible[visible.length - 1] || null;
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
if (ok) return true;

/* ⚠️ 2026-10-23 实测：**切到新对话后**编辑器是重新挂载的，execCommand 会落空
 * （日志「编辑器文本 0 字符（期望 23）」✗）→ 退回**真实按键**（React 只认这个）。 */
try {
  if ((await editorText(page)).trim().length === 0) {
    await page.keyboard.type(text, { delay: 1 });
    return true;
  }
} catch {
  // 忽略
}
return false;
}

/** 读编辑器当前文本。 */
async function editorText(page: Page): Promise<string> {
return (
    (await evaluateFn<string>(
      page,
      `() => {
        const all = Array.from(document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR)}));
        const visible = all.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const el = visible[visible.length - 1] || all[all.length - 1] || null;
        return String((el && (el.innerText || el.value)) || '');
      }`,
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

  /** 上一次成功发送时所属的**逻辑会话**（`session_key`）与它的网页会话 URL。
   * 两者都匹配时才复用（只发增量）；否则开新对话 + 发完整提示词。 */
  /** 本页是否已经就绪过一次（之后就绪不再等 networkidle，省 20s）。 */
  private editorReadyOnce = false;
  private reuseSessionKey = '';
  private reuseConversationUrl = '';

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
    try {
      await this.waitForEditor(page);
      return page;
    } catch (error) {
      /* ⚠️ 2026-10-23 实测：页面有时**彻底卡死**（占位框 60s 甚至 180s 都不挂载输入框，
       * reload 也救不回来）—— 大概率是前端 chunk 加载失败留下的坏状态。
       * 对策：**丢弃这个 context，重建通道页**再等一次（比 reload 彻底）。 */
      logger.warn(
        `[chatgpt] 输入框长时间未就绪（${String(error).slice(0, 100)}）→ 重建通道页重试`,
      );
      this.page = null;
      this.preparedFor = null;
      await disposeChannel(this.channelKey).catch(() => undefined);
      const fresh = await this.ensureSurface();
      await this.waitForEditor(fresh);
      return fresh;
    }
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
    /* ⚠️ 2026-10-23 实测：页面有时**卡在"只有占位框"**（`readyState=interactive` 但编辑器
     * 152s 都不挂载，前端的 JS 没跑完/某个请求挂住 ✗）。死等没用 → 卡满 60s 就**重载一次**。 */
    let reloaded = false;
    while (Date.now() < deadline) {
      const has = await evaluateFn<boolean>(
        page,
        `() => Array.from(document.querySelectorAll(${JSON.stringify(EDITOR_SELECTOR)})).some((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })`,
      ).catch(() => false);
      if (has) {
        /* ⚠️ 编辑器出现 ≠ 页面可用（2026-10-22 用户实测：控件有了但要挺久才真正就绪 ✗）。
         * 首次就绪用「网络静默」作代理信号；**之后切新对话不再等**——
         * 2026-10-24 实测：`networkidle` 在繁忙页面上经常耗满 20s ✗（发送总耗时 64s 里 20s 是它）。 */
        if (!this.editorReadyOnce) {
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
          await sleep(1000);
          this.editorReadyOnce = true;
        } else {
          await sleep(300);
        }
        return;
      }
      /* 卡满 60s 还没编辑器 → 重载一次（一次性，避免无限刷） */
      if (!reloaded && Date.now() - startedAt > 60_000) {
        reloaded = true;
        logger.warn('[chatgpt] 60s 仍只有占位框 → 重载页面再等（水合卡住）');
        await page.reload({ waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
        await sleep(2000);
        continue;
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

      /* 每轮都试着**点一下输入框**把它"激活"。
       * ⚠️⚠️ 2026-10-23 截图实证：新对话的输入框是**占位 textarea**（"Ask ChatGPT"），
       * **必须点一下**才会换成正可编辑的 contenteditable；只等不点 = 永远等不到 ✗。
       * 三种点法都试（占位框选择器 / 无障碍角色 / 坐标兜底），因为前端结构常变。 */
      if (clicks < 40) {
        let clicked = false;

        // ① 无障碍角色：textarea 与 contenteditable 都会暴露成 textbox
        try {
          const textbox = page.getByRole('textbox').last();
          if ((await textbox.count()) > 0) {
            await textbox.click({ timeout: 2000, force: true });
            clicked = true;
          }
        } catch {
          // 换下一种
        }

        // ② 占位框选择器（原始鼠标点击，绕开遮挡检查）
        if (!clicked) {
          const box = await page.locator(PLACEHOLDER_SELECTOR).first().boundingBox().catch(() => null);
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
            clicked = true;
          }
        }

        if (clicked) {
          clicks += 1;
          await sleep(600);
          continue; // 点完立刻复查编辑器是否挂载出来
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

  /**
   * 开一个**新对话**（每个请求都开）。
   *
   * ⚠️⚠️ 2026-10-23 用户实测（上下文串项目）：在 `btc` 项目里跑 agent，ChatGPT 回复的却是
   * `xzh` 项目的内容（`/home/amble/object/xzh`、`xuanzhu@0.4.5` 的发布记录…）——
   * 因为我们一直往**同一个网页会话**里追加消息，上一轮（xzh）的上下文留在那个 thread 里，
   * 模型自然带着它回答 ✗。
   *
   * 客户端**每轮都会发完整历史**，所以开新对话**不会丢上下文** ✓，只会丢掉「别的项目」的残留 ✓。
   *
   * ⚠️ 优先点「New chat」按钮（**客户端路由**，不重新加载页面）——
   * 直接 `goto` 首页会再走一次 46s 的页面水合 ✗。
   */
  /**
   * 保证当前页面处于**一个干净的新对话**（没有任何历史回答）。
   *
   * ⚠️⚠️ 2026-10-23 用户实测（上下文串项目）：在 `btc` 项目里跑 agent，ChatGPT 回复的却是
   * `xzh` 项目的内容 —— 因为我们一直往**同一个网页会话**追加消息，上一轮（xzh）的上下文
   * 留在 thread 里，模型自然带着它回答 ✗。客户端每轮都发完整历史，所以新对话不丢上下文 ✓。
   *
   * ⚠️ 实测的两条坑：
   * ① 对话页的侧栏是**折叠**的 → `button[aria-label="New chat"]` 存在但不可点击 ✗ → 要 `force`；
   * ② **回首页不一定干净**：ChatGPT 会自动恢复上一个会话（URL 又变成 `/c/…`）✗ ——
   *    所以必须**验证**（新对话里不该出现任何「ChatGPT said:」）。
   */
  private async startNewChat(page: Page): Promise<boolean> {
    const hasAnyAnswer = async (): Promise<boolean> => {
      const state = await readDomAnswerState(page).catch(() => ({ hasMarker: false }));
      return Boolean((state as { hasMarker?: boolean }).hasMarker);
    };

    const clickNewChat = async (): Promise<boolean> => {
      try {
        const button = page.getByRole('button', { name: 'New chat' }).first();
        if ((await button.count()) === 0) return false;
        await button.click({ timeout: 5000, force: true });
        return true;
      } catch {
        return false;
      }
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const inConversation = /\/c\//.test(page.url());
      logger.info(
        `[chatgpt:newchat] 第 ${attempt} 次：url=${page.url().slice(0, 60)} 在会话中=${inConversation} 有回答=${await hasAnyAnswer()}`,
      );
      if (!inConversation && !(await hasAnyAnswer())) return true; // 已经干净

      const clicked = await clickNewChat();
      if (clicked) {
        for (let i = 0; i < 20; i += 1) {
          await sleep(250);
          if (!/\/c\//.test(page.url())) break;
        }
        const clean = !/\/c\//.test(page.url()) && !(await hasAnyAnswer());
        logger.info(
          `[chatgpt:newchat] 点 New chat 后：url=${page.url().slice(0, 60)} 干净=${clean}`,
        );
        if (clean) {
          logger.info('[chatgpt] 已切换到新对话（点 New chat）');
          return true;
        }
      }

      /* 兜底：回首页。⚠️ 可能被自动恢复到上个会话 → 下一轮循环会再点一次 New chat。 */
      logger.warn(`[chatgpt] 第 ${attempt} 次尝试新对话未成功 → 回首页重试`);
      await page.goto(HOME_URL, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
      await sleep(2000);
    }

    const ok = !/\/c\//.test(page.url()) && !(await hasAnyAnswer());
    if (!ok) {
      logger.warn('[chatgpt] ⚠️ 没能确认已切到新对话 —— 可能会带上上一轮上下文');
    }
    return ok;
  }

  /** 在页面里输入并发送。 */  /** 在页面里输入并发送。 */
  private async sendMessage(page: Page, text: string): Promise<void> {
    /* ⚠️ 必须取**可见**的那个（2026-10-23 实测）：切新对话后 DOM 里还留着旧会话的隐藏编辑器，
     * `.first()` 会点到隐藏元素 → 键入全丢（日志「编辑器文本 0 字符」✗）。 */
    const editor = page.locator(`${EDITOR_SELECTOR} >> visible=true`).first();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      /* 点一下编辑器确保焦点（原始鼠标：Playwright 的 click 会因遮挡超时）。 */
      const box = await editor.boundingBox().catch(() => null);
      if (box) await page.mouse.click(box.x + 24, box.y + Math.min(box.height / 2, 20));
      await sleep(300);

      /* 焦点不在编辑器里 → 强制聚焦（点击可能落在遮罩上）。 */
      const focused = await evaluateFn<boolean>(
        page,
        `() => {
          const act = document.activeElement;
          return Boolean(act && act.getAttribute && act.getAttribute('contenteditable') === 'true');
        }`,
      ).catch(() => false);
      if (!focused) {
        await evaluateFn<boolean>(
          page,
          `() => {
            const all = Array.from(document.querySelectorAll('#prompt-textarea, [contenteditable="true"]'));
            const vis = all.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const el = vis[vis.length - 1] || null;
            if (!el) return false;
            el.focus();
            return true;
          }`,
        ).catch(() => false);
        await sleep(200);
      }

      await fillEditor(page, text);
      await sleep(600);

      let typed = await editorText(page);
      /* ⚠️ 兜底：编辑器仍是空的（切新对话后 execCommand 会落空）→ 真实按键。 */
      if (typed.trim().length === 0) {
        await page.keyboard.type(text, { delay: 1 }).catch(() => undefined);
        await sleep(600);
        typed = await editorText(page);
      }
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
      const page = await this.ensurePage();
      const memories = await countMemories(page);
      if (memories > 0) {
        logger.warn(
          `[chatgpt] ⚠️ 该账号开启了「记忆」（${memories} 条）—— 记忆是**跨对话**生效的，` +
            '会把你其它项目的信息带进当前任务的回答（实测：在 btc 项目里答出 xzh 的内容）。' +
            '建议在 ChatGPT → 设置 → 个性化 → 记忆 里关闭它。',
        );
      }
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
    const tEnter = Date.now();
    const page = await this.ensurePage();
    const tReady = Date.now();
    logger.info(`[chatgpt] 页面就绪 ${((tReady - tEnter) / 1000).toFixed(1)}s`);

    /* ⭐ **按会话复用**（2026-10-23 用户要求：每次新对话会逼 agent 重发完整历史，太浪费上下文）：
     * 同一个 `session_key` 且页面仍停在那条网页会话上 → **只发增量**（网页自己记得上文）；
     * 换会话 / 页面已经漂走 → 开新对话并改发**完整提示词**（保证不丢上下文）。
     * 这也顺带解决了「在 btc 项目里却带着 xzh 上下文」：不同会话一定是不同网页对话。 */
    const ctx = request.context ?? {};
    const deltaText = typeof ctx['delta_message'] === 'string' ? ctx['delta_message'] : '';
    const fullText = typeof ctx['full_message'] === 'string' ? ctx['full_message'] : request.message;
    const sessionKey = typeof ctx['session_key'] === 'string' ? ctx['session_key'] : '';
    const isDelta = deltaText.length > 0 && request.message === deltaText;
    const canReuse =
      isDelta &&
      sessionKey !== '' &&
      sessionKey === this.reuseSessionKey &&
      this.reuseConversationUrl !== '' &&
      page.url() === this.reuseConversationUrl;

    /* ⚠️ chatgpt 会把 `<tool_call>` 当伪造工具调用而**静默拒答** ✗（真机 A/B 验证）→ 换成安全标记。 */
    let text = sanitizePromptForChatgpt(guardChatgptPrompt(request.message));

    if (canReuse) {
      logger.info(`[chatgpt] 复用同一网页会话，只发增量 ${text.length} 字符（完整提示词 ${fullText.length} 字符）`);
    } else {
      if (isDelta) {
        /* 想发增量但没有可复用的会话 → 改发完整提示词（否则会丢上下文 ✗）。 */
        text = guardChatgptPrompt(fullText);
        logger.info(`[chatgpt] 无可复用会话 → 改发完整提示词 ${text.length} 字符`);
      }
      const isolated = await this.startNewChat(page);
      if (!isolated) {
        logger.warn('[chatgpt] 本轮未能切到干净的新对话（继续发送，但可能带上历史上下文）');
      }
    }
    await this.waitForEditor(page);

    /* 发送前记基线：DOM 里只认**新出现的**答案（历史答案一直都在）。 */
    const baseline = await readDomAnswerState(page);
    /* ⚠️ 复用会话时，接口里的「最后一条助手文本消息」可能是**上一轮**的答案 ✗ →
     * 先记下条数，只认**新增**的那条。 */
    const baselineConvId = readConversationId(page);
    const baselineCount = baselineConvId
      ? ((await readAnswerViaApi(page, baselineConvId))?.count ?? 0)
      : 0;

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

    /* ⭐ 第二来源：直接读 SSE 响应体（2026-10-24 实测：接口 GET 偶尔持续 403/超时，
     * 但 SSE 响应体里**一定**有完整内容）。三路兜底：接口 → SSE → DOM。 */
    const sseBodies: string[] = [];
    const onResponse = (response: {
      url: () => string;
      headers: () => Record<string, string>;
      text: () => Promise<string>;
    }): void => {
      try {
        if (!/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(response.url())) return;
        const ct = String(response.headers()['content-type'] ?? '');
        if (!ct.includes('event-stream')) return;
        void response
          .text()
          .then((body) => sseBodies.push(body))
          .catch(() => undefined);
      } catch {
        // 忽略
      }
    };
    page.on('response', onResponse as never);

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

      /* ⭐⭐ **从后端接口读答案**（2026-10-24 实测后的正解）：
       * 前端页面经常**卡在转圈、一直不渲染内容** ✗，但后端**其实已经生成好了** ——
       * 实测那条会话在后端有完整回复（`<tool_call>{"name":"read_file",…}</tool_call>`），
       * 而 DOM 里 `ChatGPT said:` 一个字都没有 ✗。
       * 所以以 `GET /backend-api/conversation/<id>` 为准，DOM 只在接口取不到时兜底。 */
      const startedAt = Date.now();
      logger.info(
        `[chatgpt] 发送完成 ${((startedAt - tEnter) / 1000).toFixed(1)}s（其中页面就绪 ${((tReady - tEnter) / 1000).toFixed(1)}s）`,
      );
      const deadline = Math.min(
        request.deadlineTs ?? Number.POSITIVE_INFINITY,
        startedAt + 10 * 60_000,
      );

      /* 会话 id：发送后 URL 变成 `/c/<id>` 是**异步**的 → 轮询等它。 */
      /* 会话 id：优先从 URL 取（发送后变 `/c/<id>`，异步）；
       * ⚠️ 拿不到时**从 SSE 里取**（流里带 `conversation_id`）——2026-10-24 实测
       * 页面水合慢时 URL 迟迟不变，但流里早就有 id ✗。 */
      let convId = readConversationId(page);
      const idDeadline = Date.now() + 20_000;
      while (!convId && Date.now() < idDeadline) {
        await sleep(400);
        convId = readConversationId(page);
        if (!convId && sseBodies.length > 0) {
          convId = extractChatgptSse(sseBodies.join('\n')).conversationId || '';
        }
      }
      if (!convId) {
        const failure = new PlatformUnavailableError(
          PLATFORM,
          '发送后拿不到会话 id（页面可能还停在首页）→ 稍后重试',
        );
        await captureFailureSnapshot(
          page,
          'chatgpt.conv.no-id',
          { model: PLATFORM, accountId: this.accountId, extra: { convRequestSeen } },
          failure,
        );
        throw failure;
      }
      /* ⚠️⚠️ 2026-10-24 实测：界面上的用户消息可能是**前端乐观显示**的 ——
       * `GET /backend-api/conversation/<id>` 直接 **404（服务端根本没有这条会话）** ✗
       * （截图里"只有提问、没有回答、下面还挂了广告"就是这种状态）。
       * 所以发送后必须**校验会话真的存在**，不存在就重发一次。 */
      let existsStatus = 0;
      const existDeadline = Date.now() + 8_000;
      while (Date.now() < existDeadline) {
        const probe = await readAnswerViaApi(page, convId);
        existsStatus = probe?.status ?? 0;
        if (existsStatus !== 0 && existsStatus !== 404) break;
        await sleep(600);
      }
      if (existsStatus === 404) {
        logger.warn('[chatgpt] 会话未落到服务端（404）→ 重发一次');
        try {
          await this.startNewChat(page);
          await this.waitForEditor(page);
          await this.sendMessage(page, text);
          const newIdDeadline = Date.now() + 20_000;
          let newId = '';
          while (!newId && Date.now() < newIdDeadline) {
            await sleep(400);
            newId = readConversationId(page);
          }
          if (newId) convId = newId;
        } catch (resendError) {
          logger.warn(`[chatgpt] 重发失败: ${String(resendError).slice(0, 120)}`);
        }
      }
      logger.info(`[chatgpt] 会话 ${convId.slice(0, 8)}… 就绪（status=${existsStatus}）→ 轮询后端回复`);

      let emitted = '';
      let lastGrowth = Date.now();
      let usedApi = false;
      /* ⚠️ 模型用了 ChatGPT 自带的代码解释器（而不是我们的工具）→ 记录下来快速失败。 */
      let ownToolsAt = 0;
      /** 是否退回到「读 DOM」这条兜底路径。 */
      let usedDom = false;
      /** DOM 文本最后一次变化的时刻（稳定判定用；DOM 的 complete 可能早于文本写完 ✗）。 */
      let domChangedAt = Date.now();
      let lastDomText = '';

      while (Date.now() < deadline) {
        await sleep(POLL_MS);

        const fromApi = await readAnswerViaApi(page, convId);
        let text = '';
        let finished = false;

        if (fromApi) {
          usedApi = true;
          if (fromApi.usedOwnTools && ownToolsAt === 0) {
            ownToolsAt = Date.now();
            logger.warn('[chatgpt] 模型在使用自带代码解释器（未按协议调用我们的工具）');
          }
          /* 只认**本轮新增**的助手消息（count > 基线），否则会把上一轮答案当本轮 ✗。 */
          if (fromApi.count > baselineCount) {
            text = fromApi.text;
            finished = fromApi.finished;
          }
        }

        if (process.env['CHATGPT_DEBUG_TAP'] === '1') {
          logger.info(
            `[chatgpt:tap] api=${fromApi ? 'y' : 'n'} sseN=${sseBodies.length} ` +
              `sseLen=${sseBodies.reduce((n, b) => n + b.length, 0)} ` +
              `sseDone=${sseBodies.some((b) => b.includes('[DONE]')) ? 'y' : 'n'} ` +
              `emitted=${emitted.length}`,
          );
        }

        /* ⭐⭐ **SSE 收到 `[DONE]` = 生成结束** → 此时**再用接口取一次**（最可靠）。
         * ⚠️ 2026-10-24 实测两条教训：
         * ① 生成**期间**接口一直失败（`status=?`），只有结束后才 200 ✓；
         * ② 直接解析 SSE 会拿到**中间那条 thoughts 消息**（"我检查了你给出的项目路径 `/…"
         *    只有 15 字符 ✗），不是最终答案。
         * 所以顺序是：接口 → （`[DONE]` 后）接口 → SSE → DOM。 */
        /* ⚠️⚠️ 2026-10-24 实测结论（用 39KB 原始流验证过）：
         * 通过 `page.on('response')` + `resp.text()` 抓到的 SSE **经常是半截** ✗
         * （那次体里根本没有模型的回答，`list_dir` 的 9 次匹配全来自我们自己的提示词）。
         * 而**事后查接口** `GET /backend-api/conversation/<id>` 能拿到完整答案 ✓
         * （生成期间接口会失败，结束后才 200）。
         * 所以：**只信接口**，DOM 仅在「接口一直没成功、且 DOM 明确 complete」时兜底。
         * SSE 仍抓（用于诊断），但**不再作为答案来源** ✗。 */
        if (process.env['CHATGPT_DEBUG_TAP'] === '1') {
          logger.info(
            `[chatgpt:tap] api=${fromApi ? 'y' : 'n'} sseN=${sseBodies.length} ` +
              `sseLen=${sseBodies.reduce((n, b) => n + b.length, 0)} emitted=${emitted.length}`,
          );
        }

        if (fromApi && fromApi.count > baselineCount && fromApi.text) {
          usedApi = true;
          text = fromApi.text;
          finished = fromApi.finished;
        } else if (!fromApi) {
          /* 接口完全不可用（连续失败）→ 才退回 DOM。
           * ⚠️ 2026-10-24 实测：DOM 的 `Response complete` 会**早于文本写完**出现 ✗
           * （实测只拿到一个 `<tool_call>` 开头）→ 必须再要求「文本稳定 ≥1.2s」。 */
          const dom = await readDomAnswerState(page);
          if (dom.text && dom.text !== lastDomText) {
            lastDomText = dom.text;
            domChangedAt = Date.now();
          }
          if (dom.complete && dom.text && dom.text !== baseline.text) {
            const stable = Date.now() - domChangedAt >= 1200;
            usedDom = true;
            text = dom.text;
            finished = stable;
          }
        }

        if (text.length > emitted.length) {
          const delta = text.slice(emitted.length);
          emitted = text;
          lastGrowth = Date.now();
          /* 把安全标记换回真实 `<tool_call>`，解析器/客户端才认得 ✓ */
          yield { content: restoreToolTags(delta), model: PLATFORM };
        }

        if (finished && emitted.length > 0) {
          if (process.env['CHATGPT_DUMP_STREAM'] === '1' && sseBodies.length > 0) {
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync('/tmp/chatgpt-last-sse.txt', sseBodies.join('\n'), 'utf8');
              logger.info(`[chatgpt] 已转储原始 SSE: /tmp/chatgpt-last-sse.txt（${sseBodies.join('').length} 字节）`);
            } catch {
              // 忽略
            }
          }
          if (process.env['CHATGPT_DUMP_STREAM'] === '1') {
            try {
              const { writeFileSync } = await import('node:fs');
              writeFileSync('/tmp/chatgpt-last-answer.txt', emitted, 'utf8');
            } catch {
              // 忽略
            }
          }
          logger.info(
            `[chatgpt] 本轮结束（正文 ${emitted.length} 字符，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s，来源 ${usedApi ? '后端接口' : usedDom ? 'DOM' : '?'}）`,
          );
          return;
        }

        /* ⚠️ **快速失败**：模型明显用自带工具、正文一直没有 → 不必干等 120s。
         * 抛错让 failover 换平台（deepseek/chatglm 不会这样）。 */
        if (ownToolsAt > 0 && emitted.length === 0 && Date.now() - ownToolsAt > 45_000) {
          const snapshotId = await captureFailureSnapshot(
            page,
            'chatgpt.stream.own-tools',
            { model: PLATFORM, accountId: this.accountId, extra: { convId, ownToolsAt } },
            new Error('模型使用了 ChatGPT 自带的代码解释器，未按协议调用工具'),
          );
          logger.error(`[chatgpt] 失败现场已记录（error:${snapshotId}）→ /tmp/chatgpt-failure.png`);
          throw new PlatformUnavailableError(
            PLATFORM,
            '模型使用了 ChatGPT 自带的代码解释器（没有调用我们提供的工具）→ 已换平台重试',
          );
        }

        /* 兜底：长时间没有任何新内容 → 有正文就保留，没有就报错（带现场）。 */
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
            {
              model: PLATFORM,
              accountId: this.accountId,
              extra: { convRequestSeen, convId, usedApi },
            },
            new Error('后端与页面都没有给出助手回复'),
          );
          logger.error(`[chatgpt] 失败现场已记录（error:${snapshotId}）→ /tmp/chatgpt-failure.png`);
          throw new PlatformUnavailableError(
            PLATFORM,
            `${IDLE_TIMEOUT_MS / 1000}s 内没拿到助手回复（后端接口 + DOM 都为空，详见 errors.log）`,
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
      page.off('response', onResponse as never);
      /* ⚠️ **在这里记录会话 URL**（2026-10-23 实测）：发送后 URL 变 `/c/<id>` 是异步的，
       * 紧接着读会读到 `/`（`(新对话/首页)`）→ 下轮只能退回完整提示词 ✗。
       * 本轮结束时导航必定已完成 ✓。 */
      if (convRequestSeen) {
        this.reuseSessionKey = sessionKey;
        this.reuseConversationUrl = /\/c\//.test(page.url()) ? page.url() : '';
        logger.info(
          `[chatgpt] 会话标记：session=${sessionKey || '(空)'} → ${this.reuseConversationUrl || '(未记录)'}`,
        );
      }
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
