/**
 * 会话保鲜任务 —— 定期用**独立浏览器**把「未在使用」的已登录账号刷新一次。
 *
 * ## 为什么需要（2026-10-18 用户要求 + 实测事故）
 * deepseek 的**网页会话会失效**（页面跳 `/sign_in`、`userToken` 被清成 null），
 * 而 `token` 打 API 仍然 200 —— 说明是网页会话被作废（闲置过期 / 被别处登录顶掉）。
 * 失效后再靠 `probeSession` 写回 token 是**救不回来的**（它需要一个有效会话才能取到新 token）。
 *
 * 所以在服务运行期间**主动保鲜**：后台另开一个浏览器（**不复用服务的页面**），
 * 逐个打开「未在使用」的账号 → 探测登录态 → 把**最新 cookie（deepseek 还有新 token）写回** → 关掉。
 *
 * ## 三条硬约束
 * 1. ⚠️ **只刷新「未在使用」的账号**：同一账号在两处同时使用会互相顶掉会话
 *    （主/辅通道正在持有的账号由 `ModelRouter.getInUseAccounts()` 给出，直接跳过）。
 * 2. ⚠️ **每个账号一个独立 context**：`userToken` 是注入到 context 的，
 *    共用一个 context 会让后一个账号继续用前一个的 token（实测踩过）。
 * 3. ⚠️ 独立浏览器用完**必须关**；定时器随服务停止而终止（不留孤儿浏览器/定时器）。
 */
import { firefox, type Browser, type BrowserContext } from 'playwright';

import { logger } from '../log/logger.js';
import { STEALTH_JS } from '../browser/stealth.js';
import { evaluateFn } from '../browser/js-eval.js';
import { classifyLoginState, initTokenJs, probeSessionJs } from '../browser/deepseek-session.js';
import {
  listAccounts,
  loadAuth,
  normalizeCookies,
  updateAuthRecord,
  type CapturedCookie,
} from '../browser/credentials.js';
import { PLATFORM_LOGIN_URLS, PLATFORMS_WITH_PROVIDER } from '../browser/platforms.js';
import { fetchAccountInfo } from '../browser/auth-capture.js';

/** 默认间隔 24 小时（用户要求「定时 24 小时执行一次」）。 */
export const SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

/** 服务启动后首次执行的延迟（等主流程稳定，别和启动任务抢浏览器）。 */
export const SESSION_REFRESH_INITIAL_DELAY_MS = 60_000;

/** 打开页面后等多久再探测（页面要跑完启动逻辑才会恢复登录态）。 */
const PROBE_WAIT_MS = 4000;

/** 一轮刷新的结果（便于日志与测试断言）。 */
export interface SessionRefreshResult {
  /** 刷新成功（cookie/token 已写回）。 */
  refreshed: string[];
  /** 正在服务里使用中 → 跳过（避免顶掉会话）。 */
  skipped: string[];
  /** 打开/探测/写回失败。 */
  failed: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 刷新一轮「未在使用」的账号会话。
 *
 * @param options.skip 正在服务里使用的账号（`platform/accountId`），一律跳过
 */
export async function refreshIdleSessions(
  options: { skip?: ReadonlySet<string> } = {},
): Promise<SessionRefreshResult> {
  const skip = options.skip ?? new Set<string>();
  const result: SessionRefreshResult = { refreshed: [], skipped: [], failed: [] };

  let browser: Browser | null = null;
  try {
    browser = await firefox.launch({ headless: true });

    for (const platform of PLATFORMS_WITH_PROVIDER) {
      const loginUrl = PLATFORM_LOGIN_URLS[platform];
      if (!loginUrl) continue;

      for (const accountId of listAccounts(platform)) {
        const key = `${platform}/${accountId}`;
        if (skip.has(key)) {
          result.skipped.push(key);
          continue;
        }

        const auth = loadAuth(platform, { accountId });
        if (!auth || (auth.cookies ?? []).length === 0) {
          result.failed.push(key);
          logger.warn(`[refresh] 跳过 ${key}：凭证不可用（文件缺失或无 Cookie）`);
          continue;
        }

        let context: BrowserContext | null = null;
        try {
          /* ⚠️ 每个账号一个独立 context（token 是 context 级的注入脚本，共用会串号） */
          context = await browser.newContext();
          await context.addInitScript({ content: STEALTH_JS });
          await context.addCookies(
            normalizeCookies(auth.cookies) as Parameters<BrowserContext['addCookies']>[0],
          );
          if (platform === 'deepseek' && auth.bearer) {
            await context.addInitScript({ content: initTokenJs(String(auth.bearer), true) });
          }

          const page = await context.newPage();
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await sleep(PROBE_WAIT_MS);

          let ok = false;
          let freshToken = '';
          if (platform === 'deepseek') {
            const raw = await evaluateFn<{
              path?: string;
              hasToken?: boolean;
              code?: number | null;
              token?: string;
            }>(page, probeSessionJs()).catch(() => null);
            ok =
              raw !== null &&
              classifyLoginState({
                path: String(raw.path ?? ''),
                hasToken: Boolean(raw.hasToken),
                code: typeof raw.code === 'number' ? raw.code : null,
              }) === 'ok';
            freshToken = String(raw?.token ?? '');
          } else {
            const info = await fetchAccountInfo(platform, auth, page);
            ok = Boolean(String(info.label ?? '').trim() || String(info.identifier ?? '').trim());
          }

          if (!ok) {
            result.failed.push(key);
            logger.warn(
              `[refresh] ${key} 会话已失效（探测未通过）→ 请重跑 webaiapi login ${platform} 刷新凭证`,
            );
            continue;
          }

          const cookies = (await context.cookies()) as unknown as CapturedCookie[];
          updateAuthRecord(
            platform,
            accountId,
            freshToken ? { cookies, bearer: freshToken } : { cookies },
          );
          result.refreshed.push(key);
          logger.info(
            `[refresh] 已刷新 ${key}：cookie ${cookies.length} 个` +
              (freshToken ? ' + 新 token' : '（token 未变）'),
          );
        } catch (error) {
          result.failed.push(key);
          logger.warn(`[refresh] 刷新 ${key} 失败: ${String(error).slice(0, 160)}`);
        } finally {
          await context?.close().catch(() => undefined);
        }
      }
    }
  } catch (error) {
    logger.warn(`[refresh] 会话保鲜任务失败: ${String(error)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  return result;
}

let initialTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * 启动定时保鲜（服务启动时调用一次）。
 *
 * @param options.isInUse 返回「正在服务里使用」的账号集合（每轮动态读取）
 */
export function startSessionRefreshLoop(options: {
  isInUse: () => ReadonlySet<string>;
  intervalMs?: number;
  initialDelayMs?: number;
}): void {
  if (initialTimer || intervalTimer) return;

  const intervalMs = options.intervalMs ?? SESSION_REFRESH_INTERVAL_MS;
  const delay = options.initialDelayMs ?? SESSION_REFRESH_INITIAL_DELAY_MS;

  const runOnce = (): void => {
    if (running) return;
    running = true;
    void refreshIdleSessions({ skip: options.isInUse() })
      .then((r) => {
        logger.info(
          `[refresh] 本轮完成：刷新 ${r.refreshed.length} / 跳过 ${r.skipped.length} / 失败 ${r.failed.length}` +
            (r.skipped.length > 0
              ? `（跳过：${r.skipped.join(', ')} —— 正在服务里使用，刷新会顶掉它们的会话）`
              : ''),
        );
      })
      .catch((error: unknown) => logger.warn(`[refresh] 本轮异常: ${String(error)}`))
      .finally(() => {
        running = false;
      });
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    logger.info(
      `[refresh] 会话保鲜已启用：每 ${Math.round(intervalMs / 3_600_000)} 小时刷新一次未在使用的账号`,
    );
    runOnce();
    intervalTimer = setInterval(runOnce, intervalMs);
    // 不要因为定时器把进程拖住（服务本身有 HTTP server 保活；CLI 用完即走）
    intervalTimer.unref?.();
  }, delay);
  initialTimer.unref?.();
}

/** 停止定时保鲜（服务关闭时调用）。 */
export function stopSessionRefreshLoop(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
