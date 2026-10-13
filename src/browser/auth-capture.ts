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
import { createInterface } from 'node:readline';

import { firefox, type Browser, type BrowserContext, type Page, type Request } from 'playwright';

import { logger } from '../log/logger.js';
import { iife } from './js-eval.js';
import {
  authBaseDir,
  authFilePath,
  legacyAuthFilePath,
  listAccounts,
  type AccountInfo,
  type AuthRecord,
} from './credentials.js';
import {
  PLATFORM_API_PATTERNS,
  PLATFORM_LOGIN_URLS,
  PLATFORM_NAMES,
  extractAccountInfoSync,
} from './platforms.js';

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

/** 交互式提问（等价于 Python 的 `input()`）。 */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
export async function fetchAccountInfo(platform: string, auth: AuthRecord): Promise<AccountInfo> {
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
  } else if (platform === 'kimi') {
    apiUrl = `https://www.kimi.com/api/user?t=${Date.now()}`;
    headers['Referer'] ??= 'https://www.kimi.com/';
    headers['Origin'] ??= 'https://www.kimi.com';
  }

  if (!apiUrl) return info;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(apiUrl, { headers, signal: controller.signal });
      if (!resp.ok) {
        logger.debug(`[${platform}] user info API 返回 ${resp.status}`);
        return info;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      logger.info(`[${platform}] 获取到 user info: ${JSON.stringify(data).slice(0, 200)}`);

      if (platform === 'deepseek') {
        const outer = (data['data'] ?? {}) as Record<string, unknown>;
        const biz = (outer['biz_data'] ?? {}) as Record<string, unknown>;
        const profile = (biz['id_profile'] ?? {}) as Record<string, unknown>;
        const email = biz['email'] ? String(biz['email']) : '';
        const phone = biz['mobile_number'] ?? biz['phone'];
        const name = profile['name'] ?? biz['name'];

        if (email) info['email'] = email;
        if (name) info['name'] = String(name);
        if (phone) info['phone'] = String(phone);
        if (biz['id']) info['user_id'] = String(biz['id']);
        // 标签优先级：name（真实名字）> email > phone
        if (name) info['label'] = String(name);
        else if (email) info['label'] = email;
        else if (phone) info['label'] = String(phone);
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
    logger.debug(`[${platform}] 获取 user info 失败（不影响主流程）: ${String(error)}`);
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
  /** 捕获超时（秒）。目前仅用于提示，实际由用户的 Enter 决定。 */
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

  constructor(platform: string, options: AuthCaptureOptions = {}) {
    this.platform = platform;
    this.authDirOption = options.authDir;
    this.saveOnCapture = options.saveOnCapture ?? true;
    this._accountId = options.accountId ?? 'default';
    this.headless = options.headless ?? false;
    this.captureTimeout = options.captureTimeout ?? 600;

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
      this.browser = await firefox.launch({ headless: this.headless });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();

      // 监听所有请求，抓 Authorization 与样本请求
      this.page.on('request', (request) => {
        this.onRequest(request).catch(() => {
          // 回调里的异常不能冒泡
        });
      });

      logger.info('='.repeat(60));
      logger.info(`【第 1 步】准备登录 ${platformName}`);
      logger.info(`超时时间: ${this.captureTimeout} 秒`);
      logger.info('='.repeat(60));
      await ask('准备好登录了吗？按 Enter 继续（或按 Ctrl+C 取消）...');

      logger.info(`导航到登录页: ${loginUrl}`);
      await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

      logger.info('='.repeat(60));
      logger.info(`【第 2 步】请在 ${platformName} 页面中完成登录`);
      logger.info('登录成功后（页面刷新或显示已登录状态），按 Enter 完成');
      // ⚠️ 头号坑：系统 Firefox 常已是**旧账号**的登录态 → 抓到同一个人。
      //    加第二个账号前必须先在浏览器里退出登录。
      logger.warn('⚠️ 若要添加**第二个账号**，请先在该页面退出登录，再登录目标账号；');
      logger.warn('   否则抓到的还是上一个人（捕获结束后会打印身份供你核对）。');
      logger.info('='.repeat(60));
      await ask('是否登录完成？按 Enter 完成（或按 Ctrl+C 取消）...');

      logger.info('等待页面加载完成...');
      await sleep(3000);

      await this.captureCookiesAndUa();
      logger.info(`✓ 已捕获 ${this.capturedAuth.cookies?.length ?? 0} 个 cookies`);

      if (this.capturedAuth.bearer) {
        logger.info('✓ 已捕获 bearer token');
      } else if (!cookieOnly) {
        logger.warn('未捕获到 bearer token（该平台可能使用 Cookie 认证，或登录后未触发新请求）');
      }

      // 提取账号身份（chatglm 走同步提取，其他平台会调 API）
      try {
        const accountInfo = await fetchAccountInfo(this.platform, this.capturedAuth);
        this.capturedAuth.account_info = accountInfo;
        if (accountInfo.label) logger.info(`✓ 账号身份: ${accountInfo.label}`);
      } catch (error) {
        logger.debug(`提取账号身份信息失败（不影响主流程）: ${String(error)}`);
      }

      if (this.saveOnCapture) this.saveAuth();
      return this.capturedAuth;
    } finally {
      await this.cleanup();
    }
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
        logger.info(`✓ 记录样本请求: ${request.method()} ${url.slice(0, 120)}`);
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
