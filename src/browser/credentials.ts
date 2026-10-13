/**
 * 凭证读取 —— `legacy-python/src/browser/cdp_capture.py` 中**运行时用到**的那部分。
 *
 * 拆出本模块的原因：凭证路径/格式是 `manager`（注入 Cookie）、`router`（挑账号、判身份）
 * 与 CLI（登录并保存）三处共用的；Python 版把它们散在 `cdp_capture.py`（1,040 行）里，
 * 而那个文件大部分是**只在登录流程用**的 `AuthCapture` 类。
 *
 * 只移植运行时需要的：路径解析、`loadAuth`、`listAccounts`、`isAuthAvailable`、
 * JWT/Cookie 身份提取。
 * ⬜ **登录捕获流程（`AuthCapture` / `capturePlatformAuth`）推迟到 M5**（只被 CLI 使用）。
 *
 * ⚠️ 与 Python 版的差异：Python 的 `load_auth()` 把目录写死成 `~/.ai-api/auth`，
 * 而 `settings.auth_dir` 配置项形同虚设。这里统一走 `settings.authDir`
 * （默认值就是 `~/.ai-api/auth`，所以实际行为一致，但配置项从此真的生效）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expandHome, settings } from '../config.js';
import { logger } from '../log/logger.js';

/* ------------------------------------------------------------------ */
/* 平台元数据                                                          */
/* ------------------------------------------------------------------ */

/**
 * 各平台 Web UI 内部 API 的匹配特征（用于从被抓请求里认出哪个含认证信息）。
 *
 * ⚠️ 类型留在这里（凭证的读取方要用），但**具体每个平台的值已迁到
 * `platforms.ts`** —— 那边是「一个平台 = 一个条目」的单一真相。
 * 本文件只负责凭证的**类型与读写**，不再持有平台清单。
 */
export interface PlatformApiPattern {
  urlPattern: string;
  authHeader: string;
  authPrefix: string;
  cookieOnly?: boolean;
}

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 抓到的 cookie（CDP / cookie jar 导出的形态）。 */
export interface CapturedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  [key: string]: unknown;
}

/** 账号身份信息（用于人工核对「到底登录了哪个账号」）。 */
export interface AccountInfo {
  identifier?: string;
  label?: string;
  token_type?: string;
  [key: string]: string | undefined;
}

/** 凭证文件的内容。 */
export interface AuthRecord {
  cookies?: CapturedCookie[];
  bearer?: string;
  cookie_str?: string;
  user_agent?: string;
  extra_headers?: Record<string, string>;
  account_info?: AccountInfo;
  captured_at?: number;
  /** `loadAuth` 注入，便于调用方知道用的是哪个账号。 */
  _account_id?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

/** 凭证根目录（`~/.ai-api/auth`）。 */
export function authBaseDir(authDir?: string): string {
  return expandHome(authDir ?? settings.authDir ?? '~/.ai-api/auth');
}

/** 某账号的凭证文件路径（新格式 `{base}/{platform}/{account}.json`）。 */
export function authFilePath(platform: string, accountId = 'default', authDir?: string): string {
  return join(authBaseDir(authDir), platform, `${accountId}.json`);
}

/** 旧格式单文件路径（`{base}/{platform}.json`）。 */
export function legacyAuthFilePath(platform: string, authDir?: string): string {
  return join(authBaseDir(authDir), `${platform}.json`);
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/**
 * 加载某账号的凭证；不存在或没有 cookies 时返回 `null`。
 *
 * ⚠️ **必须真的检查 cookies**：Python 版这里曾经整段读取/校验逻辑丢失，
 * 函数体退化成「打开文件 → 打一条 warning → 返回 None」，
 * 导致 `load_auth()` 永远返回 None，登录检查全部误报「凭证缺少 cookies」。
 * 这个校验不能再丢。
 */
export function loadAuth(
  platform: string,
  options: { accountId?: string; authDir?: string } = {},
): AuthRecord | null {
  const { accountId = 'default', authDir } = options;

  let file = authFilePath(platform, accountId, authDir);
  if (!existsSync(file)) {
    // 向后兼容：旧格式单文件（仅 default 账号）
    const legacy = legacyAuthFilePath(platform, authDir);
    if (accountId === 'default' && existsSync(legacy)) {
      file = legacy;
    } else {
      return null;
    }
  }

  try {
    const auth = JSON.parse(readFileSync(file, 'utf8')) as AuthRecord;

    const cookies = auth.cookies ?? [];
    if (cookies.length === 0) {
      logger.warn(`[credentials] ${platform}/${accountId} 凭证缺少 cookies`);
      return null;
    }

    auth._account_id = accountId;
    return auth;
  } catch (error) {
    logger.error(`[credentials] 加载 ${platform}/${accountId} 凭证失败: ${String(error)}`);
    return null;
  }
}

/**
 * 列出某平台已捕获的账号 ID。
 *
 * 会跳过捕获过程中的临时文件（`__tmp__<ts>.json` / `__new__*`）——
 * 崩溃残留不是真实账号。
 */
export function listAccounts(platform: string, authDir?: string): string[] {
  const platformDir = join(authBaseDir(authDir), platform);
  const accounts: string[] = [];

  if (existsSync(platformDir)) {
    for (const entry of readdirSync(platformDir)) {
      if (!entry.endsWith('.json')) continue;
      const stem = entry.slice(0, -'.json'.length);
      if (stem.startsWith('__tmp__') || stem.startsWith('__new__')) continue;
      accounts.push(stem);
    }
  }

  // 向后兼容：旧格式单文件
  if (accounts.length === 0 && existsSync(legacyAuthFilePath(platform, authDir))) {
    accounts.push('default');
  }

  return accounts.sort();
}

/** 指定平台/账号是否有可用凭证。 */
export function isAuthAvailable(
  platform: string,
  options: { accountId?: string; authDir?: string } = {},
): boolean {
  return loadAuth(platform, options) !== null;
}

/* ------------------------------------------------------------------ */
/* 身份提取                                                            */
/* ------------------------------------------------------------------ */

/** 解码 JWT payload（不验签，仅用于读用户标识）。 */
export function decodeJwt(token: string | null | undefined): Record<string, unknown> {
  if (!token) return {};

  const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
  const parts = raw.split('.');
  if (parts.length !== 3) return {};

  try {
    let payload = parts[1] as string;
    // 补齐 base64 padding
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    logger.debug(`[credentials] JWT 解码失败: ${String(error)}`);
    return {};
  }
}

/** 从 cookie 列表里取指定名称的值。 */
export function getCookieValue(
  cookies: ReadonlyArray<CapturedCookie> | undefined,
  name: string,
): string | undefined {
  for (const c of cookies ?? []) {
    if (c?.name === name) return c.value;
  }
  return undefined;
}

/*
 * ⬜ `extractAccountInfoSync` 已**迁到 `platforms.ts`**：
 * 它按平台名分支，属于「平台元数据」而不是「凭证读写」。
 * 留在这里会造成 `credentials ⇄ platforms` 循环 import。
 * 需要它请从 `./platforms.js` 引入。
 */

/**
 * 计算 Cookie 指纹（用于判断「两份凭证是不是同一个会话」）。
 *
 * 用途：`ModelRouter` 启用辅助通道前的三重校验之一。
 * 实测踩坑：把 `default.json` 复制成 `acc2.json` 后，账号数变成 2，
 * 但其实是同一个人的登录态 → 辅助通道「并行」时立刻撞
 * 「请等待其他对话生成完毕」。只看账号数看不出来，必须比 Cookie 值。
 *
 * 用 Node 内置 crypto，返回稳定的十六进制摘要。
 */
export function cookieFingerprint(cookies: ReadonlyArray<CapturedCookie> | undefined): string {
  const pairs = (cookies ?? [])
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => `${c.name}=${c.value ?? ''}`)
    .sort();

  return createHash('sha256').update(pairs.join(';')).digest('hex').slice(0, 32);
}

/**
 * 把抓到的 cookie 规范成 Playwright `addCookies` 能接受的形态。
 *
 * 为什么需要：Playwright 会校验 `sameSite`（只认 Strict/Lax/None）与
 * `expires`（必须是数值）。从 cookie jar / 扩展导出的数据里常见
 * `"no_restriction"` / `"unspecified"` 这类字面量，直接透传会**抛异常**导致
 * 整批 Cookie 注入失败（表现为「莫名其妙未登录」）。
 * Python 版直接透传，因为它的数据源恰好都是合规的 —— 这里做一层兜底。
 */
export function normalizeCookies(
  cookies: ReadonlyArray<CapturedCookie> | undefined,
): CapturedCookie[] {
  const out: CapturedCookie[] = [];

  for (const c of cookies ?? []) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;

    const cookie: CapturedCookie = { name: c.name, value: c.value };
    if (typeof c.domain === 'string') cookie.domain = c.domain;
    if (typeof c.path === 'string') cookie.path = c.path;
    if (typeof c.url === 'string') cookie.url = c.url;
    if (typeof c.expires === 'number' && Number.isFinite(c.expires)) cookie.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') cookie.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') cookie.secure = c.secure;

    if (typeof c.sameSite === 'string') {
      const mapped = mapSameSite(c.sameSite);
      if (mapped) cookie.sameSite = mapped;
    }

    out.push(cookie);
  }

  return out;
}

function mapSameSite(raw: string): 'Strict' | 'Lax' | 'None' | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'strict':
      return 'Strict';
    case 'lax':
      return 'Lax';
    case 'none':
    case 'no_restriction':
      return 'None';
    default:
      // 'unspecified' 等无法映射的值直接丢弃该字段（用浏览器默认）
      return undefined;
  }
}
