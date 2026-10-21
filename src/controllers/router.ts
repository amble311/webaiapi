/**
 * 模型路由器 —— `legacy-python/src/controllers/router.py` 的 TypeScript 移植。
 *
 * 职责：
 * - 注册 Provider，把「模型名 → Provider」映射起来；
 * - `mix` 模型的候选挑选（跨平台）；
 * - **辅助通道**：给辅助任务（后台预压缩、两轮转换）挑一个「与主通道不同账号」的
 *   Provider 实例，从而能与主对话真正并行（不同账号 → 不同并发额度；不同页面 → 不抢锁）。
 *
 * ## 与原实现的差异
 * - Python 里到处 `from src.browser.cdp_capture import list_accounts, load_auth`
 *   （函数内 import，为了绕开循环依赖）。TS 用正常的顶层 import，
 *   `credentials.ts` 不依赖 router，不存在循环。
 * - Python 版用 `if platform == "chatglm": ... else: continue` 建 Provider；
 *   TS 改成 {@link PROVIDER_FACTORIES} 工厂表，新增平台只改一行
 *   （并把它加进 {@link PLATFORM_MODEL_NAMES}）。
 * - `getattr(provider, "_account_id")` → `provider.getAccountId()`（显式接口）。
 * - `_identity_of` / `_cookie_fingerprint` 直接复用 `credentials.ts` 的实现
 *   （`cookieFingerprint` 用 sha256 取前 32 位；Python 是 sha1——两者都是稳定摘要，
 *   只用于「两凭证是否相同」的**相等比较**，不对外暴露，因此无需逐字节对齐）。
 */
import {
  accountCooldownRemaining,
  clearAccountRole,
  getAccountRole,
  isAccountBusy,
  setAccountRole,
} from '../browser/manager.js';
import {
  cookieFingerprint,
  type AuthRecord,
  listAccounts,
  loadAuth,
} from '../browser/credentials.js';
import { PLATFORMS_WITH_PROVIDER } from '../browser/platforms.js';
import { logger } from '../log/logger.js';
import { getAvailableModelsList } from '../config.js';
import { ChatGLMBrowserProvider } from '../providers/chatglm.js';
import { DeepSeekBrowserProvider } from '../providers/deepseek.js';
import { ChatGptBrowserProvider } from '../providers/chatgpt.js';
import { type BaseProvider } from '../providers/base.js';
import { ModelNotFoundError, PlatformUnavailableError } from '../utils/errors.js';

/**
 * 平台名作为独立模型暴露给用户：调用 `model=<平台名>` 时只调度该平台的 Provider，
 * 不跨平台（与 `mix` 不同）。
 *
 * ⚠️ **本列表由 `browser/platforms.ts` 派生**（`providerImplemented: true` 的平台），
 * 不再手写 —— 手写一份必然会和注册表写岔，而写岔的表现是
 * 「菜单里有这个平台、但 `model=xxx` 报找不到模型」这类难查的问题。
 *
 * 目前只有 chatglm。DeepSeek/Kimi/Qianwen/Doubao/Zhipu 五个 Provider 已于
 * 2026-10-12 删除（它们的 `_ensure_browser()` 调用从不存在的
 * `browser_utils.ensure_browser_page()` → 一调用就 AttributeError，跨平台
 * failover 实际上一直是失效的）。将来要加平台：实现 Provider →
 * 在 `platforms.ts` 里把 `providerImplemented` 翻成 `true` →
 * 在 {@link PROVIDER_FACTORIES} 加一行。有单测核对三者一致。
 */
export const PLATFORM_MODEL_NAMES: readonly string[] = PLATFORMS_WITH_PROVIDER;

/**
 * 平台 → Provider 工厂。
 *
 * `channelKey` 非空时创建的是**辅助通道**实例（独立 context + 指定账号，见
 * `ChatGLMBrowserProvider` 的 `channelKey` 参数说明）。
 */
/**
 * 辅助通道候选的**平台优先顺序**：主通道所在平台排第一，其余按声明顺序兜底。
 *
 * 为什么要同平台优先（2026-10-16 用户要求）：用户在同一个平台登录了两个可用账号时
 * （例如两个 deepseek），应当「一个当主账号、另一个当辅助账号」—— 不同账号、不同页面、
 * 不同锁，可以真并行，也不必再依赖别的平台凑数。
 *
 * @param mainPlatform 主通道平台（未知 / `mix` 时传 `null`/`undefined`）
 * @param auxPlatforms 已启用辅助通道的平台（声明顺序即兜底顺序）
 */
export function auxPlatformOrder(
  mainPlatform: string | null | undefined,
  auxPlatforms: readonly string[],
): string[] {
  const rest = auxPlatforms.filter((p) => p !== mainPlatform);
  if (mainPlatform && auxPlatforms.includes(mainPlatform)) return [mainPlatform, ...rest];
  return rest;
}

const PROVIDER_FACTORIES: Record<
  string,
  (accountId: string, channelKey?: string) => BaseProvider
> = {
  chatglm: (accountId, channelKey) => new ChatGLMBrowserProvider({ accountId, channelKey }),
  deepseek: (accountId, channelKey) => new DeepSeekBrowserProvider({ accountId, channelKey }),
  chatgpt: (accountId, channelKey) => new ChatGptBrowserProvider({ accountId, channelKey }),
};

/**
 * **真的**实现了工厂的平台。
 *
 * 存在的唯一理由：让「注册表的 `providerImplemented`」与「工厂表」能被**自动核对**
 * （`PLATFORM_MODEL_NAMES` 是从 `providerImplemented` 派生的，拿它比对是自说自话）。
 * 两者写岔的表现很难查：菜单里能看到这个平台、`model=xxx` 却报找不到模型。
 *
 * ⚠️ 不要在业务逻辑里用它挑平台 —— 那是 {@link PLATFORM_MODEL_NAMES} 的职责。
 */
export const PROVIDER_IMPLEMENTED_PLATFORMS: readonly string[] = Object.keys(PROVIDER_FACTORIES);

/** `mix` 候选三元组：`[providerName, provider, accountCount]`。 */
export type MixCandidate = [name: string, provider: BaseProvider, accountCount: number];

/** 账号总览条目（`/v1/status` 用）。 */
export interface AccountSummaryItem {
  account_id: string;
  identity: string;
  cookies: number;
  roles: string[];
  cooldown_seconds: number;
  busy: boolean;
}

export class ModelRouter {
  /** Provider 注册表（键 = 平台名）。 */
  readonly providers = new Map<string, BaseProvider>();

  /** 模型名 → Provider 名。 */
  readonly modelToProvider = new Map<string, string>();

  /**
   * 辅助通道 Provider（**平台 → 实例**）。
   *
   * 辅助任务（后台预压缩等）用的「另一个账号 + 独立 context 的专用页面」。
   * 有了它辅助任务才能与主对话**同时**跑。为空时辅助任务回落到主通道（串行，原行为）。
   */
  readonly auxProviders = new Map<string, BaseProvider>();

  private auxLastScan = 0;

  /**
   * 主通道最近一次使用的平台 —— 辅助通道候选据此**优先同平台**。
   *
   * 由 `streamWithFailover` 在每次请求入口调 {@link noteMainPlatform} 更新；
   * 压缩 / 状态查询等拿不到请求平台的地方直接读它。
   */
  private lastMainPlatform: string | null = null;

  /** 已启用辅助通道的平台（**只读**，供 `webaiapi model` 与文档展示）。 */
  static auxChannelPlatforms(): readonly string[] {
    return ModelRouter.AUX_CHANNEL_PLATFORMS;
  }

  /** 记录主通道平台（只有真实平台名才记，`mix` 不算）。 */
  noteMainPlatform(platform: string | null | undefined): void {
    if (platform && (PLATFORM_MODEL_NAMES as readonly string[]).includes(platform)) {
      this.lastMainPlatform = platform;
    }
  }

  /* ---------------- 辅助通道常量 ---------------- */

  /**
   * 目前只有 ChatGLM 的 Provider 实现了「通道页面」（`channelKey`）。
   * 其他平台为什么没启用，见 {@link getAuxCandidates} 的说明。
   */
  private static readonly AUX_CHANNEL_PLATFORMS: readonly string[] = [
    'chatglm',
    /* deepseek：**前向声明** —— 它的 provider 还没实现（`providerImplemented: false`），
     * 循环里 `this.providers.get('deepseek')` 拿不到实例会自动跳过，所以现在写进来是安全的。
     * provider 支持 `channelKey`（独立 context 页面）后，用户登录两个 deepseek 账号即自动
     * 「一个主、一个辅」（2026-10-16 用户要求）。 */
    'deepseek',
  ];

  /** 运行中惰性重扫辅助通道的最小间隔（秒）：登录完第二个账号后**免重启**。 */
  private static readonly AUX_RESCAN_INTERVAL = 30;

  constructor(options: { verbose?: boolean } = {}) {
    this.registerProviders();
    this.setupAuxChannels(options.verbose ?? true);
  }

  /* ================================================================== */
  /* 主通道账号分配                                                      */
  /* ================================================================== */

  /**
   * 启动时**随机**挑一个账号做主通道（另一个留给辅助通道）。
   *
   * 为什么要随机：主通道是用户对话的主力。如果永远固定用 `default`，
   * 那个账号会先被限流/耗尽额度，而另一个账号一直闲着。随机分配把负载摊到两个账号上。
   *
   * 可用 `CHATGLM_MAIN_ACCOUNT=<id>` 钉死（运维需要时避免每次重启换主力账号）。
   */
  static pickRandomMainAccount(platform: string): string {
    const pinned = (process.env['CHATGLM_MAIN_ACCOUNT'] ?? '').trim();
    if (pinned) {
      logger.info(`[main] 环境变量 CHATGLM_MAIN_ACCOUNT=${pinned}，主通道固定使用该账号`);
      return pinned;
    }

    let usable: string[] = [];
    try {
      usable = listAccounts(platform).filter(
        (acc) => (loadAuth(platform, { accountId: acc })?.cookies?.length ?? 0) > 0,
      );
    } catch (error) {
      logger.warn(`[main] 枚举 ${platform} 账号失败: ${String(error)}`);
    }

    if (usable.length === 0) return 'default';
    const first = usable[0];
    if (usable.length === 1) return first as string;

    const picked = usable[Math.floor(Math.random() * usable.length)] as string;
    logger.info(`[main] ${platform} 随机分配主通道账号: ${picked}（候选 ${usable.join(',')}）`);
    return picked;
  }

  /**
   * 注册**所有**实现了 Provider 的平台。
   *
   * ⚠️⚠️ 2026-10-16 实测 bug：这里原来**写死只注册 chatglm**
   * （`new ChatGLMBrowserProvider(...)` 一行）。于是 deepseek 的 provider、
   * 工厂表 `PROVIDER_FACTORIES.deepseek`、`providerImplemented: true` 三样都齐了，
   * 却**永远不会被注册** → 客户端请求 `model=deepseek` 得到
   * 「模型 'deepseek' 不存在或不可用」（用户实测报上来）。
   * `PLATFORM_MODEL_NAMES`（= `PLATFORMS_WITH_PROVIDER`）是**唯一事实来源**，必须遍历它。
   */
  private registerProviders(): void {
    for (const platform of PLATFORM_MODEL_NAMES) {
      const factory = PROVIDER_FACTORIES[platform];
      if (!factory) {
        // 单测核对了「声明 ⟷ 工厂」一致，这里是运行时的最后一道防线
        logger.warn(`[main] 平台 ${platform} 声明了 providerImplemented 但没有工厂，跳过`);
        continue;
      }
      // 主通道账号**随机**分配（另一个账号自动成为辅助通道，见 setupAuxChannels）
      const accountId = ModelRouter.pickRandomMainAccount(platform);
      this.registerProvider(platform, factory(accountId));
    }
    logger.info(`已注册 ${this.providers.size} 个 Browser Provider`);
  }

  /** 注册 Provider，并把它声明的所有模型登记进 `modelToProvider`。 */
  registerProvider(name: string, provider: BaseProvider): void {
    this.providers.set(name, provider);
    for (const model of provider.getModels()) {
      this.modelToProvider.set(model, name);
      logger.info(`注册模型: ${model} -> ${name}`);
    }
  }

  /* ================================================================== */
  /* 辅助通道                                                            */
  /* ================================================================== */

  /** 取凭证的账号身份标识（用于判断「是不是同一个账号」）。 */
  private static identityOf(auth: AuthRecord | null | undefined): string {
    const info = auth?.account_info ?? {};
    return String(info.identifier ?? '') || String(info.label ?? '');
  }

  /** Cookie 指纹（把两个凭证文件其实是同一登录会话的情况识别出来）。 */
  private static cookieFingerprintOf(auth: AuthRecord | null | undefined): string {
    return cookieFingerprint(auth?.cookies);
  }

  /** 主通道**当前**用的账号（provider 被限流换号后这里会跟着变）。 */
  private currentMainAccount(platform: string): string {
    return this.providers.get(platform)?.getAccountId() || 'default';
  }

  /** 该账号是否归主通道使用（避免辅助通道和主通道撞同一个账号）。 */
  private isAccountOwnedByMain(platform: string, accountId: string): boolean {
    if (accountId === this.currentMainAccount(platform)) return true;
    return getAccountRole(platform, accountId) === 'main';
  }

  /**
   * 为辅助通道挑选「与主通道**不同账号**」的凭证。
   *
   * 策略：**优先同平台的第二个账号**；没有则暂不启用
   * （其他平台的独立通道尚未实现，原因见 {@link getAuxCandidates}）。
   *
   * @param verbose 没有通道时是否打日志。启动时 true；运行中惰性重扫时 false，
   *   避免每分钟刷一条「未启用」。
   */
  private setupAuxChannels(verbose = false): void {
    for (const platform of ModelRouter.AUX_CHANNEL_PLATFORMS) {
      const provider = this.providers.get(platform);
      if (!provider) continue;

      const mainAccount = provider.getAccountId() || 'default';
      const mainAuth = loadAuth(platform, { accountId: mainAccount });
      const mainIdentity = ModelRouter.identityOf(mainAuth);
      const mainFp = ModelRouter.cookieFingerprintOf(mainAuth);

      let accounts: string[];
      try {
        accounts = listAccounts(platform);
      } catch (error) {
        logger.warn(`[aux] 列出 ${platform} 账号失败: ${String(error)}`);
        continue;
      }

      for (const acc of accounts) {
        if (acc === mainAccount) continue;

        // 主通道被限流后会**换账号**：换过去之后那个账号就成了主账号。
        // 这里必须按「当前角色」过滤，不能只看 mainAccount：
        //   - 角色是 main → 主通道在用，辅助不能碰；
        //   - 正在被主通道干活（busy）→ 更不能用；
        //   - 在冷却中（刚被限流）→ 辅助用了也会被拒。
        if (this.isAccountOwnedByMain(platform, acc)) continue;
        if (isAccountBusy(platform, acc)) {
          logger.info(`[aux] 账号 ${acc} 正被主通道使用，跳过`);
          continue;
        }
        const cooldown = accountCooldownRemaining(platform, acc);
        if (cooldown > 0) {
          logger.info(`[aux] 账号 ${acc} 仍在冷却中（剩余 ${cooldown.toFixed(0)}s），跳过`);
          continue;
        }

        const auth = loadAuth(platform, { accountId: acc });
        if (!auth?.cookies?.length) continue;

        const identity = ModelRouter.identityOf(auth);
        if (mainIdentity && identity && identity === mainIdentity) {
          // 同一账号换个文件名：并行会立刻触发「请等待其他对话生成完毕」
          logger.warn(
            `[aux] 账号 ${acc} 与主账号身份相同（${identity}），不能用于并行辅助通道，跳过`,
          );
          continue;
        }
        if (mainFp && ModelRouter.cookieFingerprintOf(auth) === mainFp) {
          logger.warn(
            `[aux] 账号 ${acc} 的 Cookie 与主账号**完全相同**（同一个登录会话），` +
              '不能用于并行辅助通道，跳过',
          );
          continue;
        }

        const factory = PROVIDER_FACTORIES[platform];
        if (!factory) continue;

        let auxProvider: BaseProvider;
        try {
          auxProvider = factory(acc, `${platform}:${acc}`);
        } catch (error) {
          logger.warn(`[aux] 创建 ${platform}/${acc} 辅助通道失败: ${String(error)}`);
          continue;
        }

        this.auxProviders.set(platform, auxProvider);
        // 登记角色：主通道换号时靠它避开这个账号
        setAccountRole(platform, acc, 'aux');
        logger.info(
          `[aux] 辅助通道已启用: ${platform}/${acc}` +
            `（身份 ${identity || '未知'}，主账号 ${mainAccount}/` +
            `${mainIdentity || '未知'} → 与主通道不同账号，可并行）`,
        );
        break;
      }
    }

    if (this.auxProviders.size === 0 && verbose) {
      logger.info('[aux] 未启用辅助通道（同平台只有一个账号）→ 辅助任务与主对话串行');
    }
  }

  /**
   * 辅助任务（压缩 / 两轮转换等）可用的通道列表。
   *
   * 顺序与理由：
   * 1. **同平台的第二个账号**（独立通道）—— 不同账号、不同页面、不同锁，
   *    可以与主对话真正并行，且不占用主账号的并发额度。
   * 2. 其他平台 —— **当前不存在**：原先那批 Provider 都用**全局共享页面**
   *    （`playwright_manager._page`），与主通道并行会互相劫持页面（这是架构问题，
   *    不是额度问题），且实现差异很大（例如会把消息截断到 8000 字符，
   *    而压缩动辄几万字符 → 必然被截断损坏）。它们已于 2026-10-12 整体删除。
   *    将来新增平台要启用辅助通道：先实现 `channelKey` 独立 context 页面，
   *    再把平台名加进 {@link AUX_CHANNEL_PLATFORMS}。
   * 3. 调用方拿不到候选时**回落到主候选**（同账号同页面 → 与主对话串行），
   *    保证功能不退化。
   *
   * @returns 三元组列表；空列表表示没有独立通道可用，调用方应回落主候选。
   */
  getAuxCandidates(mainPlatform?: string): MixCandidate[] {
    const now = Date.now() / 1000;
    /* ⚠️ 2026-10-16 改：原来写死 `AUX_CHANNEL_PLATFORMS[0]`（chatglm）——
     * 主通道是 deepseek 且用户登录了两个 deepseek 账号时，辅助通道**永远不会**用同平台
     * 的第二个账号（会去 chatglm 找，找不到就串行）。现在改为「**主通道所在平台优先**」：
     * 同平台没有副账号时才退到其它已启用辅助通道的平台（用户要求）。 */
    const preferred = mainPlatform ?? this.lastMainPlatform ?? undefined;
    const order = auxPlatformOrder(preferred, ModelRouter.AUX_CHANNEL_PLATFORMS);
    const candidates: MixCandidate[] = [];

    for (const platform of order) {

    if (!this.auxProviders.has(platform)) {
      // 惰性重扫：用户刚登录完第二个账号时**不需要重启服务**
      // （每 30s 最多重扫一次，成本只是读几个 json 文件）
      if (now - this.auxLastScan > ModelRouter.AUX_RESCAN_INTERVAL) {
        this.auxLastScan = now;
        try {
          this.setupAuxChannels(false);
        } catch (error) {
          logger.warn(`[aux] 重扫辅助通道失败: ${String(error)}`);
        }
      }
    } else {
      // 已有通道：每次使用前做一次廉价校验，以下几种情况必须**撤销**通道
      // （辅助任务回落主通道串行执行，功能不退化，只是慢）：
      //   1) 凭证文件消失 / 没有 Cookie；
      //   2) **账号已被主通道接管** —— 主通道被限流后会换到这个账号，
      //      两边同时用同一个账号会立刻触发「请等待其他对话生成完毕」；
      //   3) 账号正在冷却（刚被限流），用了也只会被拒。
      const provider = this.auxProviders.get(platform);
      const acc = provider?.getAccountId();
      let revoke: string | null = null;

      try {
        const auth = acc ? loadAuth(platform, { accountId: acc }) : null;
        if (!acc) {
          revoke = '账号未知';
        } else if (this.isAccountOwnedByMain(platform, acc)) {
          revoke = '该账号已被主通道接管（主通道被限流后切到了这里）';
        } else if (accountCooldownRemaining(platform, acc) > 0) {
          revoke = `该账号在冷却中（剩余 ${accountCooldownRemaining(platform, acc).toFixed(0)}s）`;
        } else if (!auth?.cookies?.length) {
          revoke = '凭证不可用（文件缺失或无 Cookie）';
        }
      } catch {
        // 校验失败不影响主流程（保守起见不撤销）
      }

      if (revoke) {
        logger.warn(`[aux] 撤销辅助通道 ${platform}/${acc}：${revoke} → 辅助任务回落主通道`);
        clearAccountRole(platform, acc ?? '', 'aux');
        this.auxProviders.delete(platform);
      }
    }

      const provider = this.auxProviders.get(platform);
      if (provider) {
        if (preferred && platform !== preferred) {
          logger.info(`[aux] 同平台（${preferred}）没有可用副账号 → 改用 ${platform} 的辅助通道`);
        }
        /* ⚠️ 2026-10-18 改：**收集全部候选**而不是取第一个 ——
         * 用户要求「辅助通道失败优先用其他同平台模型，然后找不同平台，最后回落主通道」。
         * 顺序由 `auxPlatformOrder` 保证：主通道平台在前，其余按声明顺序。
         * 失败逐级回落由 `streamWithFailover` 负责（它拿到的就是这个有序列表）。 */
        candidates.push([platform, provider, 1]);
      }
    }

    return candidates;
  }

  /**
   * 账号总览：每个平台的账号、身份、以及它被用作 main / aux 还是闲置。
   *
   * 用途：把「多账号到底有没有生效」变成可验证的事实（`/v1/status`）。
   * 实测踩坑：登录了两个账号但其实是同一个（浏览器里还是旧账号的登录态），
   * 只看「账号数」看不出来，看身份才能。
   */
  getAccountsSummary(): Record<string, AccountSummaryItem[]> {
    const out: Record<string, AccountSummaryItem[]> = {};

    for (const platform of PLATFORM_MODEL_NAMES) {
      let accounts: string[] = [];
      try {
        accounts = listAccounts(platform);
      } catch {
        accounts = [];
      }
      if (accounts.length === 0) continue;

      const auxAccount = this.auxProviders.get(platform)?.getAccountId();
      const mainAccount = this.providers.get(platform)?.getAccountId() || 'default';

      out[platform] = accounts.map((acc) => {
        const auth = loadAuth(platform, { accountId: acc }) ?? {};
        const info = auth.account_info ?? {};
        const roles: string[] = [];
        if (acc === mainAccount) roles.push('main');
        if (auxAccount && acc === auxAccount) roles.push('aux');

        return {
          account_id: acc,
          identity: String(info.label ?? '') || String(info.identifier ?? ''),
          cookies: auth.cookies?.length ?? 0,
          roles: roles.length > 0 ? roles : ['unused'],
          // 被平台限流过的账号会进入冷却，冷却期内主通道不再优先用它
          cooldown_seconds: Math.round(accountCooldownRemaining(platform, acc) * 10) / 10,
          busy: isAccountBusy(platform, acc),
        };
      });
    }

    return out;
  }

  /* ================================================================== */
  /* 模型 → Provider 路由                                                */
  /* ================================================================== */

  /**
   * 根据模型名取 Provider。
   *
   * 策略：
   * - `mix`：跨平台调度，按优先级依次尝试各平台；
   * - 平台名（如 `chatglm`）：直接返回该平台的 Provider；
   * - 具体模型名（如 `glm-4`）：映射到对应平台的 Provider。
   *
   * @throws {ModelNotFoundError} 模型不可用 / 凭证失效
   */
  async getProvider(model: string): Promise<BaseProvider> {
    if (!this.isModelAvailable(model)) {
      throw new ModelNotFoundError(model);
    }

    if (model === 'mix') {
      return this.getBestProvider();
    }

    // 平台名作为模型：直接返回对应平台的 Provider
    if (PLATFORM_MODEL_NAMES.includes(model)) {
      const provider = this.providers.get(model);
      if (!provider) {
        throw new ModelNotFoundError(model);
      }

      // 检查登录状态。注意 `checkLoginStatus()` 失败只作为**错误**抛出，
      // 不参与 mix 候选排序（见 getMixCandidates 的说明）。
      try {
        const usable = await provider.checkLoginStatus();
        if (!usable) {
          /* ⚠️ 用户规则（2026-10-17）：「用户指定模型类型时，如果该平台没有一个连接成功的，
           * 则返回错误提醒并停止对话」—— 这里**必须报明确错误**（不再笼统说「模型不存在」），
           * 也**不做跨平台故障转移**（指定了平台就只走这个平台）。 */
          throw new PlatformUnavailableError(
            model,
            `当前没有任何可用账号（连接失败）。请用 webaiapi accounts 查看，` +
              `或重跑 webaiapi login ${model} 刷新凭证`,
          );
        }
      } catch (error) {
        if (error instanceof ModelNotFoundError || error instanceof PlatformUnavailableError) throw error;
        logger.warn(`检查 ${model} 登录状态失败: ${String(error)}`);
      }

      return provider;
    }

    const providerName = this.modelToProvider.get(model);
    if (!providerName) {
      throw new ModelNotFoundError(model);
    }

    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ModelNotFoundError(model);
    }

    try {
      const usable = await provider.checkLoginStatus();
      if (!usable) {
        throw new PlatformUnavailableError(
          providerName,
          `当前没有任何可用账号（连接失败）。请用 webaiapi accounts 查看，` +
            `或重跑 webaiapi login ${providerName} 刷新凭证`,
        );
      }
    } catch (error) {
      if (error instanceof ModelNotFoundError || error instanceof PlatformUnavailableError) throw error;
      logger.warn(`检查 ${model} 登录状态失败: ${String(error)}`);
    }

    return provider;
  }

  /** 自动选择最优 Provider（`mix`：按优先级取第一个候选）。 */
  async getBestProvider(): Promise<BaseProvider> {
    const candidates = await this.getMixCandidates();
    const best = candidates[0];
    if (best) {
      logger.info(`使用 ${best[0]} (浏览器自动化, ${best[2]} 个账号)`);
      return best[1];
    }

    throw new ModelNotFoundError(
      'mix（没有可用的 Provider，请先运行 `npx webaiapi login chatglm` 捕获凭证）',
    );
  }

  /**
   * `mix` 模式的候选 Provider 列表。
   *
   * ## ⚠️ 排序与兜底（2026-09-29 修正，不可回退）
   * 1. **平台优先顺序固定按 {@link PLATFORM_MODEL_NAMES}**（chatglm 第一）。
   *    登录检查的结果**只用来告警，不决定谁先谁后，更不能把平台整体剔除**。
   *    原因：chatglm 的 `checkLoginStatus()` 是**整页 DOM 探测**，刚重启 / 页面未就绪
   *    时会误判「未登录」。若按「已验证优先」排序，一次探测抖动就会把 chatglm
   *    排到后面甚至完全丢失 —— 2026-09-29 22:46 实测：`model=mix` 直接打到了
   *    （当时还注册着、但从来不可用的）deepseek/kimi，报
   *    `browser_utils has no attribute ensure_browser_page`，chatglm 压根没被尝试。
   *    （那批坏 Provider 已于 2026-10-12 删除，但这条规则仍要遵守：将来新增平台时
   *    同样的抖动还会发生。）
   * 2. **有账号的平台全部保留**（未通过登录检查的排在同优先级之后），
   *    避免一次误判导致「所有平台均不可用」。
   */
  async getMixCandidates(): Promise<MixCandidate[]> {
    const candidates: MixCandidate[] = [];
    // 登录检查未通过但有账号的平台（兜底候选）
    const unverified: MixCandidate[] = [];

    logger.info('[_get_mix_candidates] 开始扫描所有平台...');

    for (const platform of PLATFORM_MODEL_NAMES) {
      const provider = this.providers.get(platform);

      if (!provider) {
        logger.debug(`[_get_mix_candidates] 平台 ${platform} 无 Provider，跳过`);
        continue;
      }

      try {
        const accounts = listAccounts(platform);
        logger.info(`[_get_mix_candidates] 平台 ${platform}: ${accounts.length} 个账号`);
        if (accounts.length === 0) {
          logger.debug(`[_get_mix_candidates] 平台 ${platform} 无可用账号，跳过`);
          continue;
        }

        logger.info(`[_get_mix_candidates] 平台 ${platform}: 检查登录状态...`);
        const usable = await provider.checkLoginStatus();
        if (usable) {
          candidates.push([platform, provider, accounts.length]);
          logger.info(`[_get_mix_candidates] 平台 ${platform} 可用，加入候选列表`);
        } else {
          // 不直接淘汰：登录检查可能因页面正在重建/DOM 未就绪而误判，
          // 若因此把唯一平台剔除，会出现「聊着聊着突然全平台不可用」。
          unverified.push([platform, provider, accounts.length]);
          logger.warn(`[_get_mix_candidates] 平台 ${platform} 登录检查未通过，记为兜底候选`);
        }
      } catch (error) {
        logger.warn(
          `[_get_mix_candidates] 检查平台 ${platform} 时异常: ` +
            `${error instanceof Error ? error.name : 'Error'}: ${String(error)}`,
        );
      }
    }

    const priority = new Map<string, number>(
      PLATFORM_MODEL_NAMES.map((name, i) => [name, i]),
    );

    if (unverified.length > 0) {
      logger.warn(
        `[_get_mix_candidates] 登录检查未通过但仍保留为候选: ` +
          `[${unverified.map((c) => c[0]).join(', ')}]`,
      );
    }

    const all = [...candidates, ...unverified];
    all.sort((a, b) => {
      const pa = priority.get(a[0]) ?? 999;
      const pb = priority.get(b[0]) ?? 999;
      if (pa !== pb) return pa - pb;
      return b[2] - a[2]; // 账号多的优先（-x[2] 升序 = 账号数降序）
    });

    logger.info(`[_get_mix_candidates] 最终候选列表: [${all.map((c) => c[0]).join(', ')}]`);
    return all;
  }

  /** 所有已注册的模型名（来自各 Provider 的 `getModels()`）。 */
  getAllModels(): string[] {
    return [...this.modelToProvider.keys()];
  }

  /** 模型别名对应的平台名（未登记返回 `undefined`）。 */
  platformOfModel(model: string): string | undefined {
    return this.modelToProvider.get(model);
  }

  /**
   * 检查模型是否可用。
   *
   * ## ⚠️ 这里曾与 {@link registerProvider} 自相矛盾（实测踩过）
   * 启动日志明明打了「注册模型: glm-4 -> chatglm」，请求 `model=glm-4` 却报
   * 「模型 'glm-4' 不存在或不可用」—— 因为旧实现只看 `mix` / 平台名 /
   * `AVAILABLE_MODELS`，而 `AVAILABLE_MODELS` 的**默认值是 `'mix'`**，
   * 别名根本不在清单里。修复后以**登记表为准**：启动时真的注册了的模型就能路由。
   */
  isModelAvailable(modelId: string): boolean {
    // `mix` 总是可用（真正的可用性在候选挑选时判断）
    if (modelId === 'mix') return true;

    // 平台名作为模型：检查该平台是否有凭证
    if (PLATFORM_MODEL_NAMES.includes(modelId)) {
      try {
        return listAccounts(modelId).length > 0;
      } catch {
        return false;
      }
    }

    // 从配置里取可用模型列表（支持 `model:platform` 格式）
    for (const availableModel of getAvailableModelsList()) {
      const model = availableModel.includes(':')
        ? (availableModel.split(':', 1)[0] as string)
        : availableModel;
      if (model === modelId) return true;
    }

    // Provider 启动时登记过的模型别名（glm-4 / glm-3 → chatglm）
    if (this.modelToProvider.has(modelId)) return true;

    return false;
  }

  /** 已登录（有凭证）的平台名列表，作为可调用的独立模型。 */
  getAvailablePlatformModels(): string[] {
    const available: string[] = [];
    for (const platform of PLATFORM_MODEL_NAMES) {
      try {
        if (listAccounts(platform).length > 0) available.push(platform);
      } catch {
        // 忽略
      }
    }
    return available;
  }

  /** 所有 Provider（键 = 平台名）。 */
  /**
   * 当前服务**正在持有页面**的账号（`platform/accountId`）。
   *
   * 用途：`session-refresh` 会话保鲜任务要**跳过**它们 —— 同一个账号在两处同时使用
   * 会互相顶掉网页会话（用户 2026-10-18 遇到的「跑着跑着登录态失效」很可能就是它）。
   */
  getInUseAccounts(): Set<string> {
    const out = new Set<string>();
    for (const [platform, provider] of this.providers) {
      out.add(`${platform}/${provider.getAccountId()}`);
    }
    for (const [platform, provider] of this.auxProviders) {
      out.add(`${platform}/${provider.getAccountId()}`);
    }
    return out;
  }

  getAllProviders(): Map<string, BaseProvider> {
    return this.providers;
  }
}

let modelRouter: ModelRouter | null = null;

/** 获取全局模型路由器实例（单例）。 */
export function getModelRouter(): ModelRouter {
  modelRouter ??= new ModelRouter();
  return modelRouter;
}

/** 重置单例（测试用）。 */
export function __setModelRouterForTest(router: ModelRouter | null): void {
  modelRouter = router;
}
