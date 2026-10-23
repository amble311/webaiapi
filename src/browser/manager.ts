/**
 * 浏览器统一管理 —— `legacy-python/src/browser/playwright_manager.py` 的 TypeScript 移植。
 *
 * 提供**全局单例**的 Playwright Firefox 实例，供所有 Provider 共享。
 *
 * ## 与原实现的差异（都是有意为之）
 *
 * 1. **不再显式 `playwright.stop()`**：Node 的 `firefox.launch()` 由模块级单例管理
 *    driver 生命周期（进程退出时一并结束），没有 Python 那种「手动 start/stop」API。
 *    这对我们反而更安全 —— 服务重启不会遗留 driver 进程。
 * 2. **`addInitScript({ content })` 而非裸字符串**：Playwright Node 里裸字符串会被
 *    当成**脚本文件路径**，必须显式给 `content`。
 * 3. `asyncio.Lock` → 自实现的 {@link Mutex}（Node 没有内置异步锁）。
 * 4. 凭证读取复用 {@link loadAuth}（Python 在 manager 与 cdp_capture 里各写了一份）。
 *
 * ## 三条必须守住的铁律（都对应真实事故，见 docs/hard-constraints.md）
 *
 * - **健康检查必须廉价**：只用 `isConnected()` / `isClosed()` 读本地状态。
 *   ⚠️ 旧实现用 `await browser.version()`（RPC），页面繁忙时超时 → 误判「已断开」
 *   → 又 launch 一个新 Firefox，旧的还活着（实测堆到 3 组 / 21 进程 / 3.5GB）。
 * - **重建前必须先释放**：`disposeSharedBrowser()`（close page/context/browser + 清引用）。
 *   只把 `initialized = false` 会留下孤儿进程。
 * - **同一账号同一时刻只能服务一个角色**：账号角色/冷却/busy 原语在这里共享，
 *   但「挑哪个账号」的业务决策留在 provider 与 router 里。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright';

import { settings } from '../config.js';
import { logger } from '../log/logger.js';
import { iife } from './js-eval.js';
import { Mutex } from '../utils/mutex.js';
import {
  type CapturedCookie,
  authFilePath,
  loadAuth,
  normalizeCookies,
} from './credentials.js';
import { SSE_CAPTURE_JS } from './sse-capture.js';
import { STEALTH_JS } from './stealth.js';

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let initialized = false;

const initLock = new Mutex();

/** 辅助通道：channelKey → Page / BrowserContext。 */
const channelPages = new Map<string, Page>();
const channelContexts = new Map<string, BrowserContext>();

/* ------------------------------------------------------------------ */
/* 账号角色 / 冷却 / busy（跨 provider 共享的「账号基础设施」）          */
/* ------------------------------------------------------------------ */

/** `{platform}:{accountId}` → 角色（main / aux）。 */
const accountRole = new Map<string, string>();
/** `{platform}:{accountId}` → 冷却截止时间戳（ms）。 */
const accountCooldown = new Map<string, number>();
/** `{platform}:{accountId}` → 正在该账号上干活的重入计数。 */
const accountBusy = new Map<string, number>();

/** 账号在共享状态里的键（约定 `{platform}:{accountId}`）。 */
export function accountKey(platform: string, accountId: string): string {
  return `${platform}:${accountId}`;
}

/**
 * 标记「正在这个账号上干活」（provider 在拿到锁之后调用）。
 *
 * ⚠️ 这是**重入计数**，必须与 {@link exitAccount} 成对（放 `finally`），
 * 否则计数泄漏会让账号被永久当成「正忙」。
 */
export function enterAccount(platform: string, accountId: string): void {
  const key = accountKey(platform, accountId);
  accountBusy.set(key, (accountBusy.get(key) ?? 0) + 1);
}

/** 解除「正在这个账号上干活」的标记（与 {@link enterAccount} 配对）。 */
export function exitAccount(platform: string, accountId: string): void {
  const key = accountKey(platform, accountId);
  const left = (accountBusy.get(key) ?? 0) - 1;
  if (left > 0) accountBusy.set(key, left);
  else accountBusy.delete(key);
}

/** 该账号此刻是否有人正在用。 */
export function isAccountBusy(platform: string, accountId: string): boolean {
  return (accountBusy.get(accountKey(platform, accountId)) ?? 0) > 0;
}

/**
 * 把 busy 占用从旧账号转移到新账号。
 *
 * ⚠️ **换号时必须调用**。原因：`enterAccount()` 是按**进入时**的账号登记 busy 的，
 * 而 `chatStream()` 的 `finally` 只会 `exitAccount(当前账号)` —— 主通道被限流换号后
 * 账号已经变了，两个账号对不上：**旧账号的 busy 计数永远不会归零**
 * （被永久当成「正忙」，辅助通道挑账号、主通道再换号都会一直避开它）。
 * 这里一次性完成「旧的退出 + 新的进入」，使重入计数配平。
 */
export function transferAccountBusy(
  platform: string,
  oldAccountId: string,
  newAccountId: string,
): void {
  if (!oldAccountId || !newAccountId) return;
  // 同号 = 没有「转移」这回事（否则会多记一次 busy）
  if (oldAccountId === newAccountId) return;

  exitAccount(platform, oldAccountId);
  enterAccount(platform, newAccountId);
}

/** 登记某账号当前服务的角色（main / aux）。 */
export function setAccountRole(platform: string, accountId: string, role: string): void {
  if (platform && accountId && role) accountRole.set(accountKey(platform, accountId), role);
}

/** 查询某账号的服务角色（未登记返回 undefined）。 */
export function getAccountRole(platform: string, accountId: string): string | undefined {
  return accountRole.get(accountKey(platform, accountId));
}

/** 释放某账号的角色占用（传了 `role` 时只在匹配时释放）。 */
export function clearAccountRole(platform: string, accountId: string, role?: string): void {
  const key = accountKey(platform, accountId);
  if (role === undefined || accountRole.get(key) === role) accountRole.delete(key);
}

/** 把账号标记为冷却中（例如被平台限流），返回冷却截止时间戳。 */
export function markAccountCooldown(
  platform: string,
  accountId: string,
  seconds: number,
  now: () => number = Date.now,
): number {
  const until = now() + Math.max(0, seconds) * 1000;
  if (platform && accountId) accountCooldown.set(accountKey(platform, accountId), until);
  return until;
}

/** 账号剩余冷却秒数（0 表示不在冷却中）。 */
export function accountCooldownRemaining(
  platform: string,
  accountId: string,
  now: () => number = Date.now,
): number {
  const until = accountCooldown.get(accountKey(platform, accountId)) ?? 0;
  return Math.max(0, (until - now()) / 1000);
}

/** 该账号是否在冷却中。 */
export function isAccountCooling(
  platform: string,
  accountId: string,
  now: () => number = Date.now,
): boolean {
  return accountCooldownRemaining(platform, accountId, now) > 0;
}

/** 仅供测试：清空全部账号状态。 */
export function resetAccountState(): void {
  accountRole.clear();
  accountCooldown.clear();
  accountBusy.clear();
}

/* ------------------------------------------------------------------ */
/* 辅助通道页面                                                        */
/* ------------------------------------------------------------------ */

/** 给页面注入 stealth + SSE 捕获脚本（顺序与 Python 一致）。 */
async function injectPageScripts(target: Page): Promise<void> {
  await target.addInitScript({ content: STEALTH_JS });
  await target.addInitScript({ content: SSE_CAPTURE_JS });
}

/** 关闭并清掉某个通道的 context / page。 */
export async function disposeChannel(channelKey: string): Promise<void> {
  const ctx = channelContexts.get(channelKey);
  channelContexts.delete(channelKey);
  channelPages.delete(channelKey);

  if (ctx) {
    try {
      await ctx.close();
    } catch (error) {
      logger.debug(`关闭通道 ${channelKey} 的 context 失败（可忽略）: ${String(error)}`);
    }
  }
}

/**
 * 关闭所有通道。
 *
 * ⚠️ 浏览器重建/关闭时**必须**调用，否则会留下孤儿 context
 * （占内存，且再也无法从 Node 侧关掉）。
 */
export async function disposeAllChannels(): Promise<void> {
  for (const key of [...channelContexts.keys()]) {
    await disposeChannel(key);
  }
  channelContexts.clear();
  channelPages.clear();
}

/**
 * 返回（必要时创建）某个「通道」的页面：**独立 context** + 指定账号的 cookie。
 *
 * ⚠️ 与 {@link newWorkPage} 的区别：`newWorkPage()` 是在**同一个 context** 里再开一页
 * （cookie 与主页面共享 → 同一个账号）；本函数开的是**另一个 context**
 * （cookie 独立 → 可以换账号，从而绕开「同一账号同时只能有一个对话」的平台限制）。
 *
 * 这是辅助任务能与主对话**真并行**的唯一方式。
 */
export async function getChannelPage(
  channelKey: string,
  platform: string,
  accountId: string,
): Promise<Page | null> {
  if (!channelKey || !accountId) return null;

  try {
    const shared = await getBrowser();
    if (!shared.browser) return null;
  } catch {
    return null;
  }

  const existing = channelPages.get(channelKey);
  if (existing) {
    try {
      if (!existing.isClosed()) return existing;
    } catch {
      // 句柄失效 → 重建
    }
  }
  await disposeChannel(channelKey);

  try {
    const shared = await getBrowser();
    const ctx = await shared.browser.newContext();

    // 注入脚本必须在导航**之前** addInitScript
    try {
      await injectPageScriptsIntoContext(ctx);
    } catch (error) {
      logger.warn(`辅助通道 ${channelKey} 注入脚本失败: ${String(error)}`);
    }

    const auth = loadAuth(platform, { accountId });
    const cookies = auth?.cookies ?? [];
    if (cookies.length > 0) {
      try {
        await ctx.addCookies(normalizeCookies(cookies) as Parameters<BrowserContext['addCookies']>[0]);
      } catch (error) {
        logger.warn(`辅助通道 ${channelKey} 注入 Cookie 失败: ${String(error)}`);
      }
    }

    const newPage = await ctx.newPage();
    channelContexts.set(channelKey, ctx);
    channelPages.set(channelKey, newPage);
    logger.info(
      `辅助通道页面已创建: ${channelKey}（账号 ${accountId}，独立 context，${cookies.length} 个 Cookie）`,
    );
    return newPage;
  } catch (error) {
    logger.error(`创建辅助通道页面失败 ${channelKey}: ${String(error)}`);
    return null;
  }
}

/** 给一个 context 注入两项 init script（新建 context 时用）。 */
async function injectPageScriptsIntoContext(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript({ content: STEALTH_JS });
  await ctx.addInitScript({ content: SSE_CAPTURE_JS });
}

/* ------------------------------------------------------------------ */
/* 孤儿进程清理 / 释放                                                 */
/* ------------------------------------------------------------------ */

/**
 * 清理**孤儿** playwright Firefox / driver 进程（上一次服务运行留下的）。
 *
 * 只在启动全新实例前调用。判据是「父进程是 init(1)」—— 说明启动它的进程已经退出，
 * 没有任何一方还持有它，属于纯垃圾。
 *
 * ⚠️ 只匹配 `ms-playwright/.../firefox`，不会碰用户自己登录用的系统 Firefox。
 */
export function sweepOrphanBrowsers(): number {
  let killed = 0;

  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,cmd='], {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch (error) {
    logger.debug(`扫描孤儿浏览器进程失败: ${String(error)}`);
    return 0;
  }

  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/, 3);
    if (parts.length < 3) continue;

    const pid = Number.parseInt(parts[0] as string, 10);
    const ppid = Number.parseInt(parts[1] as string, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

    const cmd = parts[2] as string;
    if (ppid !== 1 || pid === process.pid) continue;
    if (!cmd.includes('ms-playwright')) continue;
    if (!cmd.includes('/firefox/firefox') && !cmd.includes('playwright/driver/node')) continue;

    try {
      process.kill(pid, 'SIGTERM');
      killed += 1;
    } catch {
      // 进程可能已经退出
    }
  }

  if (killed > 0) {
    logger.warn(`清理了 ${killed} 个孤儿 playwright 进程（上次服务运行残留）`);
  }
  return killed;
}

/**
 * 释放当前（多半已失效的）浏览器实例。
 *
 * ⚠️ **重建前必须先释放**：旧实现只把 `initialized` 置 false 就 `launch()` 新实例，
 * 旧 Firefox 永远不会退出（Python 侧引用被覆盖后没有任何代码再去关它）。
 */
export async function disposeSharedBrowser(): Promise<void> {
  // 辅助通道的 context 属于这个浏览器实例，必须先一并释放，
  // 否则重建后会留下孤儿 context。
  try {
    await disposeAllChannels();
  } catch (error) {
    logger.debug(`释放辅助通道失败（可忽略）: ${String(error)}`);
  }

  for (const [obj, name] of [
    [page, 'page'],
    [context, 'context'],
    [browser, 'browser'],
  ] as const) {
    if (!obj) continue;
    try {
      await obj.close();
    } catch (error) {
      logger.debug(`关闭旧 ${name} 失败（连接已断，可忽略）: ${String(error)}`);
    }
  }

  browser = null;
  context = null;
  page = null;
  initialized = false;
}

/* ------------------------------------------------------------------ */
/* 获取 / 创建浏览器                                                   */
/* ------------------------------------------------------------------ */

export interface SharedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * 获取或创建共享的 Playwright Firefox 实例。
 *
 * 健康检查**只读本地状态**（不发 RPC），见文件头「三条铁律」。
 */
export async function getBrowser(): Promise<SharedBrowser> {
  return initLock.run(async () => {
    if (initialized && browser) {
      let healthy = false;
      try {
        const pageOk = page !== null && !page.isClosed();
        healthy = browser.isConnected() && pageOk;
        if (!healthy) {
          logger.warn(
            `共享浏览器已失效（connected=${browser.isConnected()}, ` +
              `page=${page === null ? 'None' : page.isClosed() ? 'closed' : 'open'}），重新初始化`,
          );
        }
      } catch (error) {
        logger.warn(
          `共享浏览器健康检查异常（${(error as Error).name}: ${String(error)}），重新初始化`,
        );
      }

      if (healthy) return { browser, context: context as BrowserContext, page: page as Page };

      initialized = false;
      // 先释放旧实例再建新的，否则孤儿 Firefox 会一直堆积
      await disposeSharedBrowser();
    }

    // 建新实例前清掉「父进程已是 init」的残留进程（服务重启留下的纯垃圾）
    sweepOrphanBrowsers();

    const headless = settings.browserHeadless;
    if (!headless && !process.env['DISPLAY']) {
      logger.warn(
        'BROWSER_HEADLESS=false 但环境里没有 DISPLAY —— ' +
          '无 X 显示时 Firefox 会启动失败，请检查运行服务的环境变量',
      );
    }
    logger.info(`启动 Playwright Firefox: ${headless ? '无头(headless)' : '可见(headed)'}`);

    try {
      const { firefox } = await import('playwright');
      browser = await firefox.launch({ headless, slowMo: 0 });

      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'zh-CN',
      });

      page = await context.newPage();

      await page.addInitScript({ content: STEALTH_JS });
      await page.addInitScript({ content: SSE_CAPTURE_JS });
      logger.info('SSE 原始流捕获脚本已注入');

      initialized = true;
      logger.info('Playwright Firefox 浏览器实例已就绪');
    } catch (error) {
      logger.error(`启动浏览器失败: ${String(error)}`);
      throw new Error(`无法启动 Playwright Firefox 浏览器: ${String(error)}`);
    }

    return { browser, context, page };
  });
}

/**
 * 在同一浏览器上下文里再开一个「工作页面」。
 *
 * 用途：需要在**独立对话**里再问一次模型的场景（两轮策略的 reparse）。
 * 若共用主页面，reparse 会把主页面上的会话切走 —— 主会话上下文丢失、
 * 会话复用（只补发增量）失效。
 *
 * ⚠️ 返回的是**新页面**，不会改动共享单例 `page`。
 * Cookie / localStorage 属于 context，页面间共享，登录态自动沿用。
 */
export async function newWorkPage(): Promise<Page | null> {
  const shared = await getBrowser();
  if (!shared.context) return null;

  const newPage = await shared.context.newPage();
  try {
    await injectPageScripts(newPage);
  } catch (error) {
    logger.warn(`辅助页面注入脚本失败: ${String(error)}`);
  }
  logger.info('辅助工作页面已创建（供两轮策略使用独立对话）');
  return newPage;
}

/**
 * 标记共享浏览器实例已失效，下次 `getBrowser()` 会重建它。
 *
 * 用于「操作时报了连接类错误」的场景：此时 `isConnected()` 可能还没更新，
 * 不主动失效就会一直拿到坏实例、每个请求都失败，只能重启服务。
 */
export function invalidateBrowser(reason = ''): void {
  if (initialized) {
    logger.warn(`标记共享浏览器失效${reason ? `（${reason}）` : ''}，下次请求将重建`);
  }
  initialized = false;
}

/** 关闭共享浏览器（服务优雅退出时调用）。 */
export async function closeBrowser(): Promise<void> {
  try {
    await disposeAllChannels();
  } catch {
    // 忽略
  }

  for (const obj of [page, context, browser]) {
    if (!obj) continue;
    try {
      await obj.close();
    } catch {
      // 忽略
    }
  }

  browser = null;
  context = null;
  page = null;
  initialized = false;
  logger.info('共享浏览器已关闭');
}

/* ------------------------------------------------------------------ */
/* Cookie / 页面操作                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把某账号的 Cookie 注入**主 context**。
 *
 * ⚠️ 注入后**必须重新导航**才生效（调用方负责）。
 * 另外：旧实现把这段嵌在 `if (!page)` 里，导致 `checkLoginStatus()` 先赋好 `page` 之后
 * 整块被跳过 —— 表现为「凭证明明在却永远是访客」。
 * 所以本函数**每次都要独立调用**，不要加任何前置条件。
 */
export async function loadCookies(
  platformName: string,
  accountId = 'default',
  targetContext?: BrowserContext,
): Promise<boolean> {
  const ctx = targetContext ?? context;
  if (!ctx) {
    logger.warn('浏览器上下文未初始化');
    return false;
  }

  const auth = loadAuth(platformName, { accountId });
  if (!auth) return false;

  const cookies = auth.cookies ?? [];
  if (cookies.length === 0) return false;

  try {
    await ctx.addCookies(normalizeCookies(cookies) as Parameters<BrowserContext['addCookies']>[0]);
    logger.info(`已加载 ${cookies.length} 个 Cookie (${platformName}/${accountId})`);
    return true;
  } catch (error) {
    logger.error(`加载 Cookie 失败: ${String(error)}`);
    return false;
  }
}

/** 获取当前共享页面。 */
export function getPage(): Page {
  if (!page) throw new Error('浏览器未初始化');
  return page;
}

/** 当前共享页面（可能为 null，不抛异常）。 */
export function peekPage(): Page | null {
  return page;
}

/** 导航到指定 URL（主导航一律等 `networkidle`，见 hard-constraints）。 */
export async function navigateTo(url: string, timeout = 60000): Promise<void> {
  const target = getPage();
  try {
    await target.goto(url, { timeout, waitUntil: 'networkidle' });
    logger.info(`已导航到: ${url}`);
  } catch (error) {
    logger.error(`导航失败: ${String(error)}`);
    throw error;
  }
}

/**
 * 在页面里注册通用的响应提取函数（兜底用）。
 *
 * 注册 `window.__ai_api_get_response()` / `__ai_api_clear_input()` / `__ai_api_set_input()`。
 * ⚠️ ChatGLM 的正文**不用**这个（DOM innerText 已被 Markdown 渲染破坏），
 * 只作为其它场景的兜底。
 */
export async function injectResponseJs(targetPage?: Page): Promise<void> {
  const target = targetPage ?? page;
  if (!target) return;

  const responseJs = `() => {
    window.__ai_api_get_response = function() {
        const selectors = ['.message-content', '[class*="answer"]', '[class*="response"]', '.ai-message'];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        const allElements = document.querySelectorAll('div, p, span');
        for (let i = allElements.length - 1; i >= 0; i--) {
            const text = allElements[i].innerText ? allElements[i].innerText.trim() : '';
            if (text && text.length > 20) return text.substring(0, 5000);
        }
        return '';
    };
    window.__ai_api_clear_input = function() {
        const selectors = ['textarea', '[contenteditable]', 'input[type="text"]'];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                if (el.contentEditable === 'true') el.innerHTML = '';
                else el.value = '';
                break;
            }
        }
    };
    window.__ai_api_set_input = function(text) {
        const selectors = ['textarea', '[contenteditable]', 'input[type="text"]'];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
                if (el.contentEditable === 'true') el.innerHTML = text;
                else el.value = text;
                const events = ['input', 'change', 'keyup', 'keydown'];
                events.forEach(function(eventType) {
                    el.dispatchEvent(new Event(eventType, { bubbles: true }));
                });
                break;
            }
        }
    };
    return 'AI_API_RESPONSE_JS_LOADED';
}`;

  try {
    const result = await target.evaluate(iife(responseJs));
    logger.debug(`响应 JS 注入结果: ${String(result)}`);
  } catch (error) {
    logger.warn(`注入响应 JS 失败: ${String(error)}`);
  }
}

/** 供测试/诊断：当前实例状态。 */
export function browserState(): {
  initialized: boolean;
  hasBrowser: boolean;
  hasPage: boolean;
  channels: string[];
} {
  return {
    initialized,
    hasBrowser: browser !== null,
    hasPage: page !== null,
    channels: [...channelPages.keys()],
  };
}

/** 供测试：把一个假的 page/context/browser 塞进去（不启动真实浏览器）。 */
export function __setSharedForTest(state: {
  browser?: Browser | null;
  context?: BrowserContext | null;
  page?: Page | null;
  initialized?: boolean;
}): void {
  if ('browser' in state) browser = state.browser ?? null;
  if ('context' in state) context = state.context ?? null;
  if ('page' in state) page = state.page ?? null;
  if ('initialized' in state) initialized = state.initialized ?? false;
}

/** 落盘一份 cookie（供 CLI 复用）；目录不存在会自动创建。 */
export function writeAuthFile(
  platform: string,
  accountId: string,
  payload: Record<string, unknown>,
): string {
  const file = authFilePath(platform, accountId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

export type { CapturedCookie };
