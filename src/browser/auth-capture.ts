/**
 * 凭证捕获 —— `legacy-python/src/browser/cdp_capture.py` 第 264~935 行的移植。
 *
 * 启动**可见的** Firefox，让用户手动登录目标平台，然后抓取 cookies + Authorization
 * 并写入 `~/.ai-api/auth/{platform}/{account}.json`。
 *
 * ## 为什么必须用 Firefox 而不是 Chromium
 * Firefox 的指纹更接近用户日常浏览器，不易被判定为机器人 —— 这是原实现的既定选择，
 * 也是整个项目「禁止 Chrome/Chromium」这条硬约束的来源。
 *
 * ## 与原实现的差异（有意不移植的部分）
 * - **Chrome/CDP 遗留路径**（`_should_use_real_chrome` / `_launch_and_connect_real_chrome`
 *   / `launch_real_chrome`）不移植：那些方法返回常量或走另一条已废弃的分支，
 *   `capture()` 里从未调用过。统一走 Playwright 的 `firefox.launch()`。
 * - `/tmp/ai-api-chrome-*` 残留目录清理不移植（那是 Chrome 路径的产物）。
 * - `fetchAccountInfo` 里 **deepseek / kimi 的 API 分支**保留（成本低、便于将来重加平台），
 *   但注意：chatglm **直接短路返回**（它的 JWT 已含用户名，且调 API 需要 `x-sign` 签名）。
 * - 「denied bearer」的交互确认流程保留数据结构（`rejectedBearers`），
 *   但不做逐条交互 —— 当前只有 chatglm 一个平台，且它用 Cookie 认证。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';

import {
  chromium,
  firefox,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from 'playwright';

import { resolveBrowserProxy } from './manager.js';
import { expandHome, settings } from '../config.js';
import { logger } from '../log/logger.js';
import {
  filterCookiesForPlatform,
  parseDeepseekUserInfo,
  platformDisplayName,
} from './platforms.js';
import { STEALTH_JS } from './stealth.js';
import { classifyLoginState, initTokenJs, probeSessionJs } from './deepseek-session.js';
import { isInteractive } from '../utils/prompt.js';
import { evaluateFn, iife } from './js-eval.js';
import {
  type LoginHintAction,
  isLoginHintAction,
  loginHintContent,
  loginHintJs,
  looksLoggedIn,
  removeLoginHintJs,
} from './login-hint.js';
import {
  authBaseDir,
  authFilePath,
  legacyAuthFilePath,
  listAccounts,
  type AccountInfo,
  type AuthRecord,
  loadAuth,
  normalizeCookies,
} from './credentials.js';
import {
  PLATFORM_API_PATTERNS,
  PLATFORM_LOGIN_URLS,
  PLATFORM_NAMES,
  extractAccountInfoSync,
} from './platforms.js';

/**
 * 用户在**页面上点了「✕ 取消」**（或等价操作）。
 *
 * 调用方（`login-flow.ts`）按「未写入任何文件」处理 —— 不要打印成「捕获失败」，
 * 那是我们自己的功能失败，而这是用户的正常选择。
 */
export class LoginCancelledError extends Error {
  constructor() {
    super('用户取消了登录（未写入任何凭证）');
    this.name = 'LoginCancelledError';
  }
}

/**
 * 「完成」闸门的默认等待上限（秒）。
 *
 * 用户要在这段时间里去客户端把模型参数设置好 —— 给足 10 分钟；
 * 超时也会自动关浏览器（不能把窗口无限留在那里）。
 */
const FINISH_GATE_TIMEOUT_SECONDS = 600;

/** 仅所有者可读写（凭证是敏感信息，与 Python 的 chmod 0o600 一致）。 */
const AUTH_FILE_MODE = 0o600;

/** 捕获到的凭证（写入文件的形状）。 */
export interface CapturedAuth extends AuthRecord {
  cookies?: AuthRecord['cookies'];
  cookie_str?: string;
  bearer?: string;
  user_agent?: string;
  captured_at?: number;
  platform?: string;
  account_info?: AccountInfo;
  sample_requests?: Array<Record<string, unknown>>;
}

/* ==================================================================== */
/* 账号身份提取                                                        */
/* ==================================================================== */

/**
 * 调用平台 user info API 丰富账号信息（捕获后立即调用）。
 *
 * 失败时返回同步提取的结果（{@link extractAccountInfoSync}）。
 *
 * ⚠️ `platform === 'chatglm'` **直接短路**：它的 JWT 里已经含用户名，
 * 而调它的 user info API 需要 `x-sign` 签名（我们没有）。
 */
export async function fetchAccountInfo(
  platform: string,
  auth: AuthRecord,
  /**
   * 当前页面（可选）。给了就**先在页面里调**这个 API：
   * 页面带着浏览器自己的 cookie、TLS 指纹与 WAF 会话（`HWWAFSESID`），
   * 比 Node 直连稳（2026-10-16：Node 直连偶发失败且只打 debug 日志，导致
   * 登录后身份停在 `session:<ds_session_id>`、拿不到用户名）。
   */
  page?: Page | null,
): Promise<AccountInfo> {
  const info = extractAccountInfoSync(platform, auth);

  // chatglm 无需（也不该）再调 API
  if (platform === 'chatglm') return info;

  const bearer = auth.bearer ?? '';
  const cookieStr = auth.cookie_str ?? '';
  const userAgent = auth.user_agent ?? '';
  const extraHeaders = auth.extra_headers ?? {};

  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Cookie: cookieStr,
    Accept: 'application/json',
  };
  if (bearer) {
    // chatglm 的 bearer 已含 "Bearer " 前缀，其他平台通常没有
    headers['Authorization'] = bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`;
  }
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (['content-length', 'host', 'connection', 'accept-encoding'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }

  let apiUrl: string | null = null;
  if (platform === 'deepseek') {
    apiUrl = 'https://chat.deepseek.com/api/v0/users/current';
  } else if (platform === 'chatgpt') {
    /* ChatGPT 的登录态是 session cookie；`/api/auth/session` 返回
     * `{ user: { id, name, email }, accessToken, expires }` —— 身份取 `user.id`，
     * 标签优先 name / email（否则只有不透明 cookie，拿不到用户名）。 */
    apiUrl = 'https://chatgpt.com/api/auth/session';
  } else if (platform === 'kimi') {
    apiUrl = `https://www.kimi.com/api/user?t=${Date.now()}`;
    headers['Referer'] ??= 'https://www.kimi.com/';
    headers['Origin'] ??= 'https://www.kimi.com';
  }

  if (!apiUrl) return info;

  /* ① **先在页面里调**（2026-10-16 加）：浏览器带着自己的 cookie、TLS 指纹与 WAF 会话，
   *    比 Node 直连稳得多。⚠️ `Cookie` / `User-Agent` 是浏览器**禁止脚本设置**的头，
   *    必须剔掉（页面自己会带）。 */
  if (page) {
    const pageHeaders: Record<string, string> = { Accept: 'application/json' };
    if (headers['Authorization']) pageHeaders['Authorization'] = headers['Authorization'];
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (['cookie', 'user-agent', 'accept', 'content-length', 'host', 'connection'].includes(lower)) continue;
      pageHeaders[k] = v;
    }
    try {
      /* ⚠️ 登录刚完成时页面正在导航 → 页面内 evaluate 会抛
       * 「Execution context was destroyed, most likely because of a navigation」（2026-10-19 实测：
       * ChatGPT 登录成功后立刻跳转，第一次就撞上 → 身份退回 `chatgpt:xxx`、拿不到邮箱）。
       * 所以这里重试 3 次（每次等 1.5s 让导航稳定）。 */
      let inPage: unknown = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          inPage = await evaluateFn<unknown>(
        page,
        `async () => {
    try {
      const r = await fetch(${JSON.stringify(apiUrl)}, {
        headers: ${JSON.stringify(pageHeaders)},
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) return { __waiapi_status: r.status };
      return await r.json();
    } catch (e) {
      return { __waiapi_error: String(e) };
    }
  }`,
      );
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 3) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      if (!inPage && lastError) {
        logger.warn(
          `[${platform}] 页面内取用户信息重试 3 次仍失败（${String(lastError).slice(0, 120)}）→ 改走 Node 直连`,
        );
      }

      const rec = (inPage ?? {}) as Record<string, unknown>;
      if (rec['__waiapi_status']) {
        logger.warn(
          `[${platform}] 页面内取用户信息失败（HTTP ${String(rec['__waiapi_status'])}）→ 改走 Node 直连`,
        );
      } else if (rec['__waiapi_error']) {
        logger.warn(
          `[${platform}] 页面内取用户信息异常（${String(rec['__waiapi_error'])}）→ 改走 Node 直连`,
        );
      } else if (rec['code'] !== undefined) {
        const parsed = platform === 'deepseek' ? parseDeepseekUserInfo(rec) : {};
        if (parsed['label']) {
          logger.info(`[${platform}] 页面内取到用户信息: ${String(parsed['label'])}`);
          return { ...info, ...parsed };
        }
        logger.warn(`[${platform}] 页面内调用成功但没解析出身份（shape 可能变了）`);
      }
    } catch (error) {
      logger.warn(`[${platform}] 页面内取用户信息失败（${String(error)}）→ 改走 Node 直连`);
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(apiUrl, { headers, signal: controller.signal });
      if (!resp.ok) {
        // ⚠️ 这里原来是 debug —— 失败后身份会停在 `session:<ds_session_id>`（每次都变），
        //    用户看到的就是「登录成功了但没拿到用户名」。提到 warn 才能被发现。
        logger.warn(
          `[${platform}] user info API 返回 ${resp.status}（拿不到用户名，身份退回 cookie/前缀）`,
        );
        return info;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      logger.info(`[${platform}] 获取到 user info: ${JSON.stringify(data).slice(0, 200)}`);

      if (platform === 'chatgpt') {
        /* 形状：`{ user: { id, name, email }, accessToken, expires }` */
        const user = (data['user'] ?? {}) as Record<string, unknown>;
        const email = String(user['email'] ?? '');
        const name = String(user['name'] ?? '');
        const userId = String(user['id'] ?? '');
        if (email) info['email'] = email;
        if (name) info['name'] = name;
        if (userId) {
          info['user_id'] = userId;
          info['identifier'] = userId;
        }
        if (name) info['label'] = name;
        else if (email) info['label'] = email;
        else if (userId) info['label'] = `ChatGPT ${userId.slice(0, 8)}`;
      } else if (platform === 'deepseek') {
        // 解析逻辑抽成纯函数（可单测），并**用 user id 当稳定身份**而不是 session cookie
        Object.assign(info, parseDeepseekUserInfo(data));
      } else if (platform === 'kimi') {
        // 匿名用户 name 通常是「虚拟用户」，不应作为标识
        const isAnon = Boolean(data['is_anonymous']);
        const name = String(data['name'] ?? '');
        const email = data['email'] ? String(data['email']) : '';
        const phone = data['phone'] ? String(data['phone']) : '';
        if (email) info['email'] = email;
        if (phone) info['phone'] = phone;
        if (name && !isAnon && name !== '虚拟用户') {
          info['name'] = name;
          info['label'] = name;
        } else if (email) {
          info['label'] = email;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    logger.warn(`[${platform}] 获取 user info 失败（不影响主流程，但身份会退回 cookie/前缀）: ${String(error)}`);
  }

  return info;
}

/* ==================================================================== */
/* 捕获器                                                              */
/* ==================================================================== */

export interface AuthCaptureOptions {
  authDir?: string;
  /** 是否无头。凭证捕获**建议 false**（用户需要看到浏览器才能登录）。 */
  headless?: boolean;
  /**
   * 等待登录的超时（秒）。
   *
   * ⚠️ 2026-10-16 起它是**真正生效**的上限：登录完成靠自动检测（或用户按回车）判定，
   * 超时后仍会尝试捕获现有凭证（用户可能登成了、但信号我们没识别出来）。
   */
  captureTimeout?: number;
  /** 账号 ID（同平台多账号）。 */
  accountId?: string;
  /**
   * 捕获结束后是否**立即落盘**（默认 `true`）。
   *
   * 交互式流程（`login-flow.ts`）传 `false`：它要先看捕获到的**身份**、
   * 问用户「这份凭证存成哪个账号」，再调 {@link AuthCapture.saveAs} 写。
   * 若照旧立即写，就会先落一个 `__new__<ts>.json` 再改名 —— 中途崩溃会留下
   * 一个「看起来像账号文件」的残骸（`listAccounts` 跳过它，但人肉 ls 会看到）。
   */
  saveOnCapture?: boolean;
  /**
   * **选中已有账号时**先用保存的凭证试一次登录（2026-10-17 用户要求）：
   * 凭证仍有效 → 直接跳过登录（省掉手工输密码）；失效 → 才打开登录页。
   *
   * 判定口径按平台：deepseek 看**页面会话**（`classifyLoginState`），
   * 其它平台看 user-info API（`fetchAccountInfo`）—— 不能一律用 API，
   * deepseek 的旧 token 打 API 仍 200，但网页会话可能已作废（实测）。
   */
  reuseSavedCredential?: boolean;
  /**
   * 捕获成功后是否**保持浏览器打开**，等调用方显式调用 {@link AuthCapture.finish}
   * 或 {@link AuthCapture.dispose} 再关（默认 `false` = 老行为：立刻关）。
   *
   * 只有「成功捕获」才会保持；失败/取消仍然立刻关闭。
   */
  keepAlive?: boolean;
}

export class AuthCapture {
  readonly platform: string;

  private readonly authDir: string;

  /** 用户传入的 `authDir`（`saveAs()` 重算路径时要原样带上）。 */
  private readonly authDirOption: string | undefined;

  private readonly saveOnCapture: boolean;

  private _accountId: string;

  private _authFile: string;

  private readonly headless: boolean;

  private readonly captureTimeout: number;

  private apiConfig: (typeof PLATFORM_API_PATTERNS)[string] | undefined;

  private browser: Browser | null = null;

  private context: BrowserContext | null = null;

  private page: Page | null = null;

  readonly capturedAuth: CapturedAuth = {};

  /** 页面按钮最近回传的动作（刷新循环从 DOM 属性读到后写入，由等待循环处理）。 */
  private pendingAction: LoginHintAction | null = null;

  /**
   * 捕获成功后**是否保持浏览器打开**（等用户点「完成」）。
   *
   * `login-flow` 传 `true`：它要先落盘、打印账号/身份，再让用户在客户端把模型参数
   * 设置好、点「完成」才关浏览器（2026-10-16 用户要求；之前是捕获完立刻关窗，
   * 用户还没看清账号就没了）。**非成功路径仍会关**，见 `keepAliveArmed`。
   */
  private readonly keepAlive: boolean;

  /** 选中的是已有账号时，先用保存的凭证试登录（{@link AuthCaptureOptions.reuseSavedCredential}）。 */
  private readonly reuseSavedCredential: boolean;

  /** 只有**成功捕获**后才置位 —— 失败/取消路径照样关掉浏览器（不留孤儿窗口）。 */
  private keepAliveArmed = false;

  constructor(platform: string, options: AuthCaptureOptions = {}) {
    this.platform = platform;
    this.authDirOption = options.authDir;
    this.saveOnCapture = options.saveOnCapture ?? true;
    this._accountId = options.accountId ?? 'default';
    this.headless = options.headless ?? false;
    this.captureTimeout = options.captureTimeout ?? 600;
    this.keepAlive = options.keepAlive === true;
    this.reuseSavedCredential = options.reuseSavedCredential === true;

    this.authDir = authBaseDir(options.authDir);
    mkdirSync(this.authDir, { recursive: true });
    mkdirSync(`${this.authDir}/${platform}`, { recursive: true });

    this._authFile = authFilePath(platform, this._accountId, options.authDir);

    /* 向后兼容：旧格式单文件存在而新格式不存在时，迁移一份过去。
     * ⚠️ 只复制不移动 —— 旧文件留着，避免迁移出问题时两头都没有。 */
    const legacy = legacyAuthFilePath(platform, options.authDir);
    if (existsSync(legacy) && !existsSync(this._authFile) && this._accountId === 'default') {
      try {
        copyFileSync(legacy, this._authFile);
        logger.info(`迁移旧凭证: ${legacy} → ${this._authFile}`);
      } catch (error) {
        logger.warn(`迁移旧凭证失败: ${String(error)}`);
      }
    }

    this.apiConfig = PLATFORM_API_PATTERNS[platform];
    if (!this.apiConfig) {
      logger.warn(`平台 ${platform} 暂未配置 API 模式，将仅捕获 cookies`);
    }
  }

  /** 当前账号 ID（`saveAs()` 会改写它，调用方不要缓存）。 */
  get accountId(): string {
    return this._accountId;
  }

  /** 当前目标文件路径（随 `saveAs()` 变化）。 */
  get authFile(): string {
    return this._authFile;
  }

  /** 启动浏览器、引导用户登录、抓取凭证并落盘。 */
  async capture(): Promise<CapturedAuth> {
    logger.info(`开始捕获 ${this.platform} 凭证...`);

    const loginUrl = PLATFORM_LOGIN_URLS[this.platform];
    if (!loginUrl) {
      throw new Error(`未配置 ${this.platform} 的登录 URL`);
    }

    const platformName = PLATFORM_NAMES[this.platform] ?? this.platform;
    const cookieOnly = Boolean(this.apiConfig?.cookieOnly);

    try {
      logger.info('启动 Firefox 浏览器...');
      /* ===== 浏览器档案的选择（2026-10-19 用户要求）=====
       * 背景：ChatGPT 走 **Google 登录** —— 每次都开空白浏览器，就等于每次都要先登 Google ✗。
       * 三档，优先级从高到低：
       *   ① `BROWSER_CDP_ENDPOINT`：直连**用户已安装的 Chrome**（CDP）→ 用它现成的 profile
       *      与登录态（Google 等），完全不用重登；
       *   ② `BROWSER_PROFILE_DIR`（默认开）：**持久化档案** → 登录态跨启动保留；
       *   ③ 空字符串：每次开空白档案（旧行为）。 */
      const cdpEndpoint = String(settings.browserCdpEndpoint ?? '').trim();
      const profileDirRaw = String(settings.browserProfileDir ?? '').trim();
      /* ⚠️ 默认 **Firefox**（2026-10-19 实测）：Cloudflare Turnstile 只放行 Firefox 路径；
       * Chromium（Playwright 驱动）即使去掉自动化标记也会被判定，ChatGPT 登录过不了验证 ✗。 */
      const useFirefox = String(settings.loginBrowser ?? 'firefox').trim().toLowerCase() !== 'chrome';

      if (cdpEndpoint) {
        logger.info(`连接已安装的 Chrome（CDP）: ${cdpEndpoint}（直接复用它的登录态）`);
        this.browser = await chromium.connectOverCDP(cdpEndpoint);
        /* 复用它已有的 context；没有就新建。⚠️ 不要动用户正在看的标签页 —— 下面另开一个新页。 */
        this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      } else if (useFirefox) {
        /* Firefox + 空白 context（= 2026-10-19 之前一直在用、且能过 Cloudflare 的路径）。
         * ⚠️ Firefox 的档案**存不住 cookie**（实测），所以这里不做持久化，
         * 也就不用 `BROWSER_PROFILE_DIR`（只有 `LOGIN_BROWSER=chrome` 时才用它）。 */
        logger.info(
          '使用 Firefox 登录（默认；能过 Cloudflare Turnstile）。' +
            (profileDirRaw ? '持久化档案仅对 LOGIN_BROWSER=chrome 生效。' : ''),
        );
        /* ⚠️ 登录流程同样要显式传代理（Playwright 不读环境变量）✗ */
        const loginProxy = resolveBrowserProxy();
        this.browser = await firefox.launch({
          headless: this.headless,
          ...(loginProxy ? { proxy: { server: loginProxy } } : {}),
        });
        this.context = await this.browser.newContext();
      } else if (profileDirRaw) {
        const profileDir = expandHome(profileDirRaw);
        try {
          mkdirSync(profileDir, { recursive: true });
          logger.info(`使用持久化浏览器档案（Google 等登录态会保留）: ${profileDir}`);
          /* ⚠️ 用 **Chromium** 而不是 Firefox（2026-10-19 实测）：
           * Firefox 的持久化档案**存不住 cookie**（重开就丢 ✗，只保住 localStorage）；
           * Chromium profile 的 cookie 与 localStorage 都能保留（实测：页面/服务端写的 cookie 重启后仍在 ✓）。
           * 优先用**系统已装的 Google Chrome**（`channel: 'chrome'`）：真实浏览器登录 Google 更顺，
           * 也不需要额外下载 Playwright 内核；装不上再退回自带 Chromium。 */
          /* ⚠️ Cloudflare / Turnstile（2026-10-19 用户实测「过不了真人验证」）：
           * Playwright 默认会给 Chrome 加 `--enable-automation` 并开启
           * `AutomationControlled` 特性 —— 这两样是 Turnstile 最典型的判据。
           * 下面去掉它们，再补几个让实例更像「普通 Chrome」的参数。 */
          const stealthArgs = [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
          ];
          try {
            this.context = await chromium.launchPersistentContext(profileDir, {
              channel: 'chrome',
              headless: this.headless,
              ignoreDefaultArgs: ['--enable-automation'],
              args: stealthArgs,
            });
          } catch (chromeError) {
            logger.warn(
              `系统 Chrome 启动失败（${String(chromeError).slice(0, 100)}）→ 退回 Playwright 自带 Chromium`,
            );
            this.context = await chromium.launchPersistentContext(profileDir, {
              headless: this.headless,
            });
          }
          this.browser = this.context.browser();
        } catch (error) {
          /* ⚠️ 不要静默退回空白档案 —— 那会丢掉登录态，用户会以为"又要重登"是随机现象。
           * 常见原因：上一次的登录浏览器没关干净 → 档案仍被占用。 */
          throw new Error(
            `打开持久化浏览器档案失败: ${String(error).slice(0, 160)}。` +
              '通常是上一次的登录浏览器没关干净（档案被占用）→ 关掉残留的 Firefox 窗口后重试；' +
              '也可以用 BROWSER_PROFILE_DIR= 临时走空白档案。',
          );
        }
      } else {
        this.browser = await firefox.launch({ headless: this.headless });
        this.context = await this.browser.newContext();
      }
      this.page = await this.context.newPage();

      /* ⚠️ 登录页也必须注入 STEALTH（2026-10-16 实测）：
       * 干净上下文里 `navigator.webdriver === true` —— 滑块/图形验证最经典的
       * 一票否决项，用户实测「滑动验证始终过不了」就是它
       * （STEALTH 原来只在聊天页注入）。它同时修补 plugins / languages / permissions 等指纹。
       * 必须在导航**之前**注入。 */
      try {
        await this.context.addInitScript({ content: STEALTH_JS });
      } catch (error) {
        logger.debug(`注入 STEALTH 失败（登录仍可进行，但可能撞人机验证）: ${String(error)}`);
      }

      /* 页面按钮的动作走 **HTML 属性**回传（不用 `exposeBinding`：它会往页面塞可枚举的
       * `__playwright__binding__`，反爬 `for…in` 一眼看到）。动作在 `waitForLogin`
       * 的刷新循环里读取，且**白名单校验**（`isLoginHintAction`）。 */
      this.pendingAction = null;

      // 监听所有请求，抓 Authorization 与样本请求
      this.page.on('request', (request) => {
        this.onRequest(request).catch(() => {
          // 回调里的异常不能冒泡
        });
      });

      /* ⚠️ **选中已有账号时，先用保存的凭证试一次**（2026-10-17 用户要求）：
       * 凭证还有效 → **跳过登录**；失效 → 才打开登录页（不要一上来就给空白登录页）。 */
      if (this.reuseSavedCredential && this.accountId && this.accountId !== '__pending__') {
        const saved = loadAuth(this.platform, {
          accountId: this.accountId,
          authDir: this.authDirOption,
        });
        if (saved && (saved.cookies ?? []).length > 0) {
          logger.info(`先用已保存的凭证试一下（账号 ${this.accountId}）…`);
          try {
            await this.context.addCookies(
              normalizeCookies(saved.cookies) as Parameters<BrowserContext['addCookies']>[0],
            );
            /* deepseek 的登录态在 localStorage（必须在**页面启动前**注入） */
            if (this.platform === 'deepseek' && saved.bearer) {
              await this.context.addInitScript({ content: initTokenJs(String(saved.bearer)) });
            }
            await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
            await sleep(3000);

            if (await this.probeSavedCredential(saved)) {
              logger.info('✓ 已保存的凭证仍然有效 → 跳过登录');
              await this.collectFromContext(saved);
              if (this.saveOnCapture) this.saveAuth();
              if (this.keepAlive) this.keepAliveArmed = true;
              else await this.dropLoginHint();
              return this.capturedAuth;
            }
            logger.info('已保存的凭证已失效 → 打开登录页重新登录');
          } catch (error) {
            logger.warn(`用已保存凭证试登录失败（继续走登录页）: ${String(error)}`);
          }
        }
      }

      /* 引导**只放在页面里**（2026-10-16 改）：
       * 用户此时盯着的是浏览器，终端上的「请回终端按回车」根本看不见
       * （何况登录期间每个 API 请求都会打一行日志把终端刷满）。
       * 所以：页面上一条悬浮横幅写明步骤，终端只留一行会原地刷新的进度。 */
      const warnExistingSession = listAccounts(this.platform, this.authDirOption).length > 0;
      const waitOptions = {
        platformName,
        timeoutSeconds: this.captureTimeout,
        warnExistingSession,
      };

      // `addInitScript` 保证**每次导航后**横幅还在（登录成功常伴随跳转/刷新）
      await this.page.addInitScript({
        content: iife(loginHintJs(loginHintContent({ ...waitOptions, elapsedSeconds: 0 }))),
      });

      logger.info(
        `正在打开 ${platformName} 登录页，浏览器里会显示操作引导` +
          `（登录成功后**自动继续**，不需要回终端按回车；最多等 ${this.captureTimeout}s）`,
      );
      await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.applyLoginHint(loginHintContent({ ...waitOptions, elapsedSeconds: 0 }));

      const reason = await this.waitForLogin({ ...waitOptions, loginUrl });
      this.clearProgressLine();

      if (reason === 'detected') {
        logger.info('✓ 已自动检测到登录完成');
      } else if (reason === 'manual') {
        logger.info('✓ 已确认登录完成（页面按钮「我已登录，继续」或终端回车）');
        await sleep(1000); // 让最后一次请求把 bearer 带回来
      } else if (reason === 'cancel') {
        logger.warn('已按「取消」终止登录，未写入任何凭证');
        throw new LoginCancelledError();
      } else {
        logger.warn(
          `⚠️ 等待 ${this.captureTimeout}s 未检测到登录，仍尝试捕获现有凭证` +
            '（若身份不对，请重跑 `webaiapi login`）',
        );
      }

      await this.applyLoginHint(
        loginHintContent({ ...waitOptions, elapsedSeconds: 0, tone: 'done' }),
      );

      await this.captureCookiesAndUa();

      /* ⚠️ 只留**平台相关**的 cookie（2026-10-19 实测：ChatGPT 走 Google 登录会把 34 个
       * Google/YouTube cookie 一起捕获 → 隐私风险 + 噪音；provider 也用不到）。 */
      const beforeCount = this.capturedAuth.cookies?.length ?? 0;
      this.capturedAuth.cookies = filterCookiesForPlatform(
        this.capturedAuth.cookies ?? [],
        this.platform,
      );
      const afterCount = this.capturedAuth.cookies.length;
      if (beforeCount !== afterCount) {
        logger.info(
          `  已过滤 ${beforeCount - afterCount} 个与 ${this.platform} 无关的 cookie` +
            '（例如同一浏览器里的 Google 账号 cookie）',
        );
        this.capturedAuth.cookie_str = this.capturedAuth.cookies
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      }
      logger.info(`✓ 已捕获 ${afterCount} 个 cookies`);
      /* 打印 cookie **名字**（不含值）：登录类问题（尤其 ChatGPT 的 session-token 分片命名）
       * 光看「捕获了 N 个」是查不出来的（2026-10-19 实测：登录成功却没落盘）。 */
      logger.info(
        `  cookie 名: ${(this.capturedAuth.cookies ?? [])
          .map((c) => c.name)
          .slice(0, 20)
          .join(', ')}`,
      );

      if (this.capturedAuth.bearer) {
        logger.info('✓ 已捕获 bearer token');
      } else if (!cookieOnly) {
        logger.warn('未捕获到 bearer token（该平台可能使用 Cookie 认证，或登录后未触发新请求）');
      }

      // 提取账号身份（chatglm 走同步提取，其他平台会调 API）
      try {
        const accountInfo = await fetchAccountInfo(this.platform, this.capturedAuth, this.page);
        this.capturedAuth.account_info = accountInfo;
        if (accountInfo.label) logger.info(`✓ 账号身份: ${accountInfo.label}`);
      } catch (error) {
        logger.debug(`提取账号身份信息失败（不影响主流程）: ${String(error)}`);
      }

      if (this.saveOnCapture) this.saveAuth();
      if (this.keepAlive) {
        /* 交给调用方决定何时关（它会先落盘 + 打印账号，再调 finish()）。
         * 光标位置保持在页面上那条绿色横幅，告诉用户「别关窗」。 */
        this.keepAliveArmed = true;
        logger.info('浏览器保持打开：等你在客户端配好参数后点页面上的「完成」（或终端按回车）');
      } else {
        await this.dropLoginHint();
      }
      return this.capturedAuth;
    } finally {
      // ⚠️ 只有成功捕获且开了 keepAlive 才留窗；失败/取消必须关掉（别留孤儿浏览器）
      if (!this.keepAliveArmed) await this.cleanup();
    }
  }

  /* ================================================================== */
  /* 登录引导与等待（2026-10-16）                                        */
  /* ================================================================== */

  /**
   * 已保存的凭证是否仍然可用。
   *
   * ⚠️ 不能一律用 `fetchAccountInfo`：deepseek 的**旧 token 打 API 仍然 200**，
   * 但网页会话可能已被作废（实测）—— 所以它要看页面会话（`classifyLoginState`）。
   */
  private async probeSavedCredential(saved: AuthRecord): Promise<boolean> {
    if (!this.page) return false;
    try {
      if (this.platform === 'deepseek') {
        const raw = await evaluateFn<{ path?: string; hasToken?: boolean; code?: number | null }>(
          this.page,
          probeSessionJs(),
        ).catch(() => null);
        if (!raw) return false;
        return (
          classifyLoginState({
            path: String(raw.path ?? ''),
            hasToken: Boolean(raw.hasToken),
            code: typeof raw.code === 'number' ? raw.code : null,
          }) === 'ok'
        );
      }

      const info = await fetchAccountInfo(this.platform, saved, this.page);
      return Boolean(String(info.label ?? '').trim() || String(info.identifier ?? '').trim());
    } catch (error) {
      logger.debug(`探测已保存凭证失败: ${String(error)}`);
      return false;
    }
  }

  /** 从当前 context 收集最新 cookie（复用保存的身份 / bearer / 请求头）。 */
  private async collectFromContext(saved: AuthRecord): Promise<void> {
    const cookies = this.context ? await this.context.cookies() : [];
    this.capturedAuth.cookies = cookies as unknown as CapturedAuth['cookies'];
    this.capturedAuth.cookie_str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    this.capturedAuth.bearer = saved.bearer;
    this.capturedAuth.user_agent = this.capturedAuth.user_agent ?? saved.user_agent;
    this.capturedAuth.extra_headers = this.capturedAuth.extra_headers ?? saved.extra_headers;
    this.capturedAuth.account_info = saved.account_info;
  }

  /**
   * 把引导横幅画到当前页面上（幂等；失败不影响主流程）。
   *
   * @returns 页面按钮刚回传的动作（**读走即清除**，无动作时为空串）。
   *          一次 evaluate 同时完成「刷新横幅 + 取动作」，省一次往返。
   */
  private async applyLoginHint(content: ReturnType<typeof loginHintContent>): Promise<string> {
    if (!this.page) return '';
    try {
      const action = await evaluateFn<unknown>(this.page, loginHintJs(content));
      return typeof action === 'string' ? action : '';
    } catch (error) {
      logger.debug(`注入登录引导失败（不影响流程）: ${String(error)}`);
      return '';
    }
  }

  /** 横幅已经不需要了（落盘后调用；关浏览器时也会随之消失）。 */
  private async dropLoginHint(): Promise<void> {
    if (!this.page) return;
    try {
      await evaluateFn(this.page, removeLoginHintJs());
    } catch {
      // 忽略
    }
  }

  /**
   * 凭证里是否已经出现**真实登录身份**（= 登录完成）。
   *
   * 判据本身在 `login-hint.ts::looksLoggedIn`（纯函数、有单测）；
   * 这里只负责取当前 cookies，并把顺手拿到的快照留在 `capturedAuth` 里。
   */
  private async detectLoggedIn(): Promise<boolean> {
    if (!this.context) return false;
    try {
      const cookies = await this.context.cookies();
      const snapshot: AuthRecord = {
        cookies: cookies as unknown as AuthRecord['cookies'],
        cookie_str: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        // bearer 由请求监听器异步抓到，此刻可能已经有了
        bearer: this.capturedAuth.bearer,
      };
      if (!looksLoggedIn(this.platform, snapshot)) return false;
      // 顺手留下 cookies，省掉后面一次往返
      this.capturedAuth.cookies = snapshot.cookies;
      this.capturedAuth.cookie_str = snapshot.cookie_str;
      return true;
    } catch (error) {
      logger.debug(`登录检测出错（继续等）: ${String(error)}`);
      return false;
    }
  }

  /**
   * 等用户完成登录。
   *
   * 三个并行信号，谁先到用谁：
   * 1. **自动检测**：每 2s 看凭证里是否出现真实身份 → `detected`；
   * 2. **手动确认** → `manual`：页面按钮「✓ 我已登录，继续」，或终端按一次回车。
   *    ⚠️ 回车只在 **cooked 模式**下监听 `stdin` 的 `data`
   *    （回车才会触发一次），**不开 raw 模式** —— raw 模式下 Ctrl+C 不再触发 SIGINT，
   *    我们绝不能剥夺用户唯一的中断手段；
   * 3. **取消** → `cancel`：页面按钮「✕ 取消」。
   * 4. **超时** → `timeout`（照样往下捕获：用户可能登成了，只是信号没被我们识别）。
   *
   * 每次轮询都会刷新页面横幅（含已等待秒数），所以页面上的提示始终是活的。
   */
  private async waitForLogin(options: {
    platformName: string;
    timeoutSeconds: number;
    warnExistingSession: boolean;
    loginUrl: string;
  }): Promise<'detected' | 'manual' | 'cancel' | 'timeout'> {
    const { platformName, timeoutSeconds, warnExistingSession, loginUrl } = options;
    const startedAt = Date.now();
    const timeoutMs = Math.max(30, timeoutSeconds) * 1000;
    const pollMs = 2000;

    let enterPressed = false;
    const onStdinData = (): void => {
      enterPressed = true;
    };
    const listenStdin = Boolean(process.stdin.isTTY);
    if (listenStdin) {
      process.stdin.resume();
      process.stdin.on('data', onStdinData);
    }

    try {
      for (;;) {
        const elapsed = (Date.now() - startedAt) / 1000;

        /* 0) 页面按钮：用户已经明确表态，优先级最高 */
        if (this.pendingAction === 'cancel') return 'cancel';
        if (this.pendingAction === 'done') return 'manual';
        if (this.pendingAction === 'reload') {
          this.pendingAction = null;
          logger.info('按页面按钮「重开登录页」重新导航');
          try {
            await this.page?.goto(loginUrl, { waitUntil: 'domcontentloaded' });
          } catch (error) {
            logger.debug(`重开登录页失败: ${String(error)}`);
          }
          await sleep(500);
          continue;
        }

        if (await this.detectLoggedIn()) return 'detected';
        if (enterPressed) return 'manual';
        if (Date.now() - startedAt >= timeoutMs) return 'timeout';

        const action = await this.applyLoginHint(
          loginHintContent({
            platformName,
            elapsedSeconds: elapsed,
            timeoutSeconds,
            warnExistingSession,
          }),
        );
        if (isLoginHintAction(action)) {
          logger.info(`[login] 页面按钮: ${action}`);
          this.pendingAction = action;
          continue; // 立刻回到循环顶部处理，不白等一个轮询周期
        }
        this.printWaitingLine(platformName, elapsed, timeoutSeconds);
        await sleep(pollMs);
      }
    } finally {
      if (listenStdin) {
        process.stdin.off('data', onStdinData);
        process.stdin.pause();
      }
    }
  }

  /** 终端上那**一行**等待进度（TTY 原地刷新；非 TTY 每 15s 一条，避免刷屏）。 */
  private printWaitingLine(platformName: string, elapsed: number, timeoutSeconds: number): void {
    const text =
      `⏳ 等待 ${platformName} 登录… ${Math.round(elapsed)}s / ${timeoutSeconds}s` +
      '（登录后自动继续，也可按回车立即完成）';
    if (isInteractive()) {
      process.stdout.write(`\r${text}   `);
    } else if (Math.round(elapsed) % 15 === 0) {
      logger.info(text);
    }
  }

  /** 清掉终端上那行原地刷新的进度（否则会和后续日志糊在一起）。 */
  private clearProgressLine(): void {
    if (isInteractive()) process.stdout.write(`\r${' '.repeat(100)}\r`);
  }

  /** 请求回调：抓 bearer / 额外请求头 / 样本请求。 */
  private async onRequest(request: Request): Promise<void> {
    try {
      // ⚠️ Playwright 的 Request.url() 是**方法**（不是属性）
      const url = request.url();
      const headers = request.headers();

      const cookieOnly = Boolean(this.apiConfig?.cookieOnly);
      const authHeaderName =
        this.apiConfig && !cookieOnly
          ? (this.apiConfig.authHeader || 'authorization').toLowerCase()
          : '';
      const authValue = authHeaderName
        ? (headers[authHeaderName] ?? headers['authorization'] ?? '')
        : '';

      const pattern = this.apiConfig?.urlPattern ?? '';
      const urlMatches = Boolean(pattern && url.includes(pattern));

      if (!urlMatches && !authValue) return;

      // 提取 bearer（cookie_only 平台跳过）
      if (authValue && !cookieOnly) {
        const prefix = this.apiConfig?.authPrefix ?? '';
        let bearer = authValue;
        if (prefix && authValue.startsWith(prefix)) bearer = authValue.slice(prefix.length);
        else if (authValue.startsWith('Bearer ')) bearer = authValue.slice(7);

        if (bearer && bearer !== this.capturedAuth.bearer) {
          logger.info(`✓ 捕获到 ${this.platform} bearer token (来源: ${url.slice(0, 80)})`);
          this.capturedAuth.bearer = bearer;
        }

        // 保存所有非标准请求头（x-msh-* 之类的签名头）
        const standard = new Set([
          'content-type', 'accept', 'user-agent', 'cookie', 'authorization', 'host',
          'content-length', 'connection', 'accept-encoding', 'accept-language',
          'origin', 'referer', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest',
        ]);
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
          if (!standard.has(k.toLowerCase())) extra[k] = v;
        }
        if (Object.keys(extra).length > 0) {
          this.capturedAuth.extra_headers = { ...(this.capturedAuth.extra_headers ?? {}), ...extra };
          logger.info(`✓ 捕获 ${Object.keys(extra).length} 个额外请求头: ${Object.keys(extra).join(', ')}`);
        }
      }

      /* 记录样本请求（跳过静态资源与 CDN）——
       * 用途：将来排查「平台改接口了」时，手里有真实报文可比对。 */
      if (authValue || urlMatches) {
        const lower = url.toLowerCase();
        const staticExts = ['.js', '.css', '.png', '.jpg', '.ico', '.woff', '.woff2', '.svg', '.webp'];
        if (staticExts.some((ext) => lower.endsWith(ext) || lower.includes(`${ext}?`))) return;
        if (lower.includes('cdn') || lower.includes('static')) return;

        this.capturedAuth.sample_requests ??= [];
        this.capturedAuth.sample_requests.push({
          url,
          method: request.method(),
          headers,
          body: request.postData() ?? null,
        });
        // ⚠️ 这里是终端刷屏的主因（登录期间每个 API 请求都会打一行）→ 降为 debug
        logger.debug(`✓ 记录样本请求: ${request.method()} ${url.slice(0, 120)}`);
      }
    } catch (error) {
      logger.debug(`处理请求事件出错: ${String(error)}`);
    }
  }

  /** 抓 cookies 与 User-Agent。 */
  private async captureCookiesAndUa(): Promise<void> {
    try {
      if (this.context) {
        const cookies = await this.context.cookies();
        this.capturedAuth.cookies = cookies as unknown as AuthRecord['cookies'];
        this.capturedAuth.cookie_str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        logger.info(`捕获 ${cookies.length} 个 cookies`);
      }
      if (this.page) {
        const ua = String(await this.page.evaluate(iife('() => navigator.userAgent')));
        this.capturedAuth.user_agent = ua;
        logger.info(`捕获 User-Agent: ${ua.slice(0, 80)}...`);
      }
      this.capturedAuth.captured_at = Math.floor(Date.now() / 1000);
      this.capturedAuth.platform = this.platform;
    } catch (error) {
      logger.error(`捕获 cookies/UA 失败: ${String(error)}`);
    }
  }

  /**
   * 保存凭证。
   *
   * 三重保护（避免「重登把另一个账号冲掉」这个最常见的损失）：
   * 1. 已有文件先备份为 `.bak`；
   * 2. 先写临时文件再 `rename`（原子替换，中途崩溃不会留下半截 JSON）；
   * 3. 权限设为 0600（仅所有者可读写）。
   */
  private saveAuth(): void {
    const target = this.authFile;
    const tmp = `${target}.tmp`;

    if (existsSync(target)) {
      try {
        copyFileSync(target, `${target}.bak`);
        logger.info(`已备份旧凭证: ${target}.bak`);
      } catch (error) {
        logger.warn(`备份旧凭证失败: ${String(error)}`);
      }
    }

    try {
      writeFileSync(tmp, JSON.stringify(this.capturedAuth, null, 2), 'utf8');
      try {
        chmodSync(tmp, AUTH_FILE_MODE);
      } catch {
        // 某些文件系统不支持 chmod（如 Windows / 部分挂载盘），忽略
      }
      renameSync(tmp, target);
      logger.info(`凭证已保存到: ${target}`);
    } catch (error) {
      logger.error(`保存凭证失败: ${String(error)}`);
      throw error;
    }
  }

  /**
   * 以指定账号 ID 落盘（交互式流程在「拿到身份、确认账号名」之后调用）。
   *
   * 复用 {@link saveAuth} 的三重保护（备份 `.bak` → 临时文件 → 原子 rename → 0600），
   * 所以覆盖旧账号时同样是安全的。
   *
   * ⚠️ `accountId` 会被**当成文件名**使用，必须校验：它可能来自平台返回的身份
   * 字符串（`slugAccountId` 已经清洗过一道），但这里是最后一道闸 ——
   * 不能让 `../` 之类的东西写出去。
   *
   * @returns 最终写入的文件路径
   */
  saveAs(accountId: string): string {
    if (!this.isAcceptableAccountId(accountId)) {
      throw new Error(
        `非法账号 ID: ${JSON.stringify(accountId)}（只允许字母、数字、. _ -；` +
          '已存在的账号名不受此限制）',
      );
    }

    this._accountId = accountId;
    this._authFile = authFilePath(this.platform, accountId, this.authDirOption);
    this.saveAuth();
    return this._authFile;
  }

  /**
   * 账号 ID 能不能当文件名用。
   *
   * 分两档，**不能合并成一条严格正则**：
   * 1. **硬性禁止**：`/` `\` NUL、空串、`.`、`..` —— 这条对「新账号」和
   *    「更新已有账号」都成立（防路径穿越）。
   * 2. **严格字符集**（字母数字 `._-`）：只用来约束**新**账号名。
   * 3. **放宽**：名字**已经存在于磁盘**时允许任意其它字符 —— 真实用户目录里
   *    就有 `用户_bFa15b` 这种（早期手工登录留下的），用严格正则会把
   *    「重新登录这个账号」直接判成非法，用户只能删号重登。
   *    安全性由 `listAccounts` 保证：它的值来自 `readdirSync`，是普通文件名。
   */
  private isAcceptableAccountId(accountId: string): boolean {
    if (accountId === '' || accountId === '.' || accountId === '..') return false;
    if (/[/\\\u0000]/.test(accountId)) return false;
    if (/^[A-Za-z0-9._-]+$/.test(accountId)) return true;

    return listAccounts(this.platform, this.authDirOption).includes(accountId);
  }

  /** 清理浏览器资源。 */
  /**
   * 「完成」闸门：把页面横幅换成「已捕获登录凭证」，**等用户点「完成」**（或终端回车）
   * 再关浏览器。
   *
   * 为什么要它（2026-10-16 用户要求）：凭证捕获完立刻关窗，用户还没来得及核对账号、
   * 更没时间在客户端把模型名/参数设置好。现在凭证**已经落盘**（调用方在 `saveAs` 之后
   * 才调这里），所以用户可以放心去配置，配好点「完成」即可。
   *
   * ⚠️ 无论走哪条路（点完成 / 回车 / 超时）都会关浏览器 —— 不能把窗口留在那里。
   */
  async finish(
    options: {
      accountId?: string;
      identity?: string;
      /** 建议客户端使用的模型名（默认用平台 id，即模型名）。 */
      modelHint?: string;
      timeoutSeconds?: number;
    } = {},
  ): Promise<void> {
    try {
      if (!this.page) return;
      const timeoutSeconds = options.timeoutSeconds ?? FINISH_GATE_TIMEOUT_SECONDS;
      const content = loginHintContent({
        platformName: platformDisplayName(this.platform),
        elapsedSeconds: 0,
        timeoutSeconds,
        tone: 'captured',
        accountId: options.accountId,
        identity: options.identity,
        modelHint: options.modelHint ?? this.platform,
      });

      let enterPressed = false;
      const onStdinData = (): void => {
        enterPressed = true;
      };
      const listenStdin = Boolean(process.stdin.isTTY);
      if (listenStdin) {
        process.stdin.resume();
        process.stdin.on('data', onStdinData);
      }

      try {
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
          // 一次 evaluate 完成「刷新横幅 + 读走按钮动作」
          if ((await this.applyLoginHint(content)) === 'finish') {
            logger.info('用户点了「完成」，关闭浏览器');
            return;
          }
          if (enterPressed) {
            logger.info('终端回车确认，关闭浏览器');
            return;
          }
          if (Date.now() >= deadline) {
            logger.warn(`等待「完成」超过 ${timeoutSeconds}s，自动关闭浏览器`);
            return;
          }
          await sleep(1000);
        }
      } finally {
        if (listenStdin) {
          process.stdin.off('data', onStdinData);
          process.stdin.pause();
        }
      }
    } finally {
      await this.cleanup();
      this.keepAliveArmed = false;
    }
  }

  /**
   * 无条件关闭浏览器（幂等）。
   *
   * 调用方在**任何早退分支**上都要调它 —— `keepAlive` 模式下浏览器不会自己关，
   * 忘了调就会留一个孤儿窗口（`webaiapi start` 有 `sweepOrphanBrowsers` 兜底，
   * 但 CLI 交互流程不该依赖它）。
   */
  async dispose(): Promise<void> {
    try {
      await this.dropLoginHint();
    } catch {
      // 忽略
    }
    this.keepAliveArmed = false;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.page) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch (error) {
      logger.debug(`清理资源时出错: ${String(error)}`);
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 交互式捕获入口（CLI 的 `login` 命令调用）。
 *
 * @returns 进程退出码（0 成功）
 */
export async function capturePlatformAuth(platform: string, accountId = 'default'): Promise<number> {
  if (!PLATFORM_LOGIN_URLS[platform]) {
    console.error(
      `未知平台: ${platform}\n可用平台: ${Object.keys(PLATFORM_LOGIN_URLS).join(', ')}`,
    );
    return 1;
  }

  if (accountId === 'default') {
    console.log(
      '⚠️ 未指定 --account：将写入 default.json。\n' +
        '   若这是**第二个账号**，请改用 `login ' + platform + ' --account acc2`，\n' +
        '   否则会覆盖掉现有 default 账号的凭证（原文件会备份为 .bak）。\n',
    );
  }

  const capture = new AuthCapture(platform, { accountId, headless: false });
  try {
    const auth = await capture.capture();
    const label = auth.account_info?.label ?? auth.account_info?.identifier ?? '(未识别)';
    console.log('');
    console.log('===== 捕获完成 =====');
    console.log(`平台: ${platform}`);
    console.log(`账号: ${accountId}`);
    console.log(`身份: ${label}   ← 请核对是不是你想登录的那个人`);
    console.log(`Cookie: ${auth.cookies?.length ?? 0} 个`);
    console.log(`Bearer: ${auth.bearer ? '有' : '无（该平台可能用 Cookie 认证）'}`);
    console.log(`文件: ${capture.authFile}`);
    console.log('');
    console.log('下一步: 启动服务（`webaiapi start`）后运行 `webaiapi accounts` 核对角色分配。');
    return 0;
  } catch (error) {
    console.error(`捕获失败: ${String(error)}`);
    return 1;
  }
}
