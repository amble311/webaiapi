/**
 * 元信息路由 —— `/v1/models`、`/v1/health`、`/v1/status` 的移植
 * （`legacy-python/src/api/routes.py` 第 1266~1305、3025~3104 行）。
 */
import type { FastifyInstance } from 'fastify';

import { getAvailableModelsList, settings } from '../config.js';
import { getHistoryDb } from '../controllers/history-db.js';
import { getRequestPool, getScheduler } from '../controllers/request-pool.js';
import { getModelRouter } from '../controllers/router.js';
import { logger } from '../log/logger.js';
import { makeModelInfo, type ModelInfo } from '../types/openai.js';

/** 账号总览项（`/v1/status` 用）。 */
interface AccountSummary {
  account_id: string;
  identity: string;
  cookies: number;
  roles: string[];
  cooldown_seconds: number;
  busy: boolean;
}

interface AuxChannelInfo {
  enabled: boolean;
  platform?: string;
  account_id?: string | null;
  identity?: string;
  error?: string;
}

/**
 * 注册元信息路由。
 *
 * ⚠️ 路由前缀由调用方在 Fastify 注册时给出（`settings.apiPrefix`，
 * 默认 `/v1`），所以这里的路径都不带 `/v1`。
 */
export function registerMetaRoutes(app: FastifyInstance): void {
  /**
   * 可用模型列表（OpenAI 兼容）。
   *
   * 由两部分组成：
   * 1. 配置里的对外展示模型（`AVAILABLE_MODELS`，默认 `mix`）；
   * 2. **已捕获凭证的平台名**作为独立模型（动态：用户捕获了哪个平台，
   *    就能直接调用该平台名）。
   *
   * 调用平台名模型时只调度对应平台，不跨平台（与 `mix` 不同）。
   */
  app.get('/models', async () => {
    const modelRouter = getModelRouter();
    const modelList: ModelInfo[] = [];
    const seenIds = new Set<string>();

    for (const modelId of getAvailableModelsList()) {
      // 支持 `model:platform` 格式
      let model: string;
      let platform: string;
      if (modelId.includes(':')) {
        const idx = modelId.indexOf(':');
        model = modelId.slice(0, idx);
        platform = modelId.slice(idx + 1);
      } else {
        model = modelId;
        platform = 'unknown';
      }

      if (seenIds.has(model)) continue;
      seenIds.add(model);
      modelList.push(makeModelInfo(model, platform));
    }

    // 追加已登录平台名作为独立模型
    for (const platform of modelRouter.getAvailablePlatformModels()) {
      if (seenIds.has(platform)) continue;
      seenIds.add(platform);
      modelList.push(makeModelInfo(platform, platform));
    }

    // 追加 Provider 登记过的模型别名（glm-4 / glm-3 → chatglm）。
    // ⚠️ 不加这段的话，`/v1/models` 与实际可用性**对不上**：
    //    `model=glm-4` 能用（isModelAvailable 以登记表为准），列表里却没有它 ——
    //    OpenAI 兼容客户端会先拉列表再让用户挑，挑不到就等于没有这个功能。
    for (const model of modelRouter.getAllModels()) {
      if (seenIds.has(model)) continue;
      seenIds.add(model);
      modelList.push(makeModelInfo(model, modelRouter.platformOfModel(model) ?? 'unknown'));
    }

    return { object: 'list' as const, data: modelList };
  });

  /**
   * 健康检查。
   *
   * ⚠️ 这里会**逐个**调用 `checkLoginStatus()`（chatglm 的是整页 DOM 探测）。
   * 它内部有 120s 的「已登录」缓存，所以正常轮询不会每次都做整页导航。
   */
  app.get('/health', async () => {
    const modelRouter = getModelRouter();
    const providerStatus: Record<string, Record<string, string>> = {};

    for (const [name, provider] of modelRouter.getAllProviders()) {
      try {
        const isLoggedIn = await provider.checkLoginStatus();
        providerStatus[name] = { status: isLoggedIn ? 'connected' : 'disconnected' };
      } catch (error) {
        providerStatus[name] = { status: 'error', message: String(error) };
      }
    }

    return {
      status: 'ok',
      version: settings.appVersion,
      providers: providerStatus,
    };
  });

  /**
   * 系统状态。
   *
   * 「账号与辅助通道」这一段是把**多账号到底有没有生效**变成可验证的事实。
   * 实测踩坑：登录了两个账号但其实是同一个（浏览器里还是旧账号登录态），
   * 只看「账号数」看不出来，得看身份与角色。
   */
  app.get('/status', async () => {
    const requestPool = getRequestPool();
    const scheduler = getScheduler();
    const modelRouter = getModelRouter();

    let accountsSummary: Record<string, AccountSummary[]> = {};
    let auxChannel: AuxChannelInfo = { enabled: false };

    try {
      accountsSummary = modelRouter.getAccountsSummary() as unknown as Record<
        string,
        AccountSummary[]
      >;
      const aux = modelRouter.getAuxCandidates();
      const first = aux[0];
      if (first) {
        const [auxName, auxProvider] = first;
        const auxAccountId = auxProvider.getAccountId();
        auxChannel = {
          enabled: true,
          platform: auxName,
          account_id: auxAccountId,
          identity:
            accountsSummary[auxName]?.find((a) => a.account_id === auxAccountId)?.identity ?? '',
        };
      }
    } catch (error) {
      auxChannel = { enabled: false, error: String(error) };
    }

    return {
      request_pool: requestPool.getStatus(),
      scheduler: scheduler.getLoadStatus(),
      accounts: accountsSummary,
      aux_channel: auxChannel,
    };
  });
}

/**
 * 启动时的日志重置与历史库自检。
 *
 * ⚠️ 与原实现的差异：Python 是**覆盖写** `logs/api_requests.log` 并写入一行
 * `# API 请求日志 - <时间> 启动`；TS 侧由 `resetApiLog()` 清空（保持「原样记录、
 * 不加工」的契约 —— 头部注释会干扰对日志的 `grep`）。
 *
 * 历史库清理是**异步**的，日志里会带上统计数字。
 */
export async function runStartupTasks(): Promise<void> {
  logger.info(`启动 ${settings.appName} v${settings.appVersion}`);
  logger.info(`调试模式: ${String(settings.debug)}`);
  logger.info(`API 地址: http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}`);

  try {
    const historyDb = getHistoryDb();
    const deleted = await historyDb.cleanupOld();
    const stats = await historyDb.stats();
    logger.info(
      `历史数据库: ${stats.total_messages} 条消息, ` +
        `${stats.conversations} 个会话, TTL=${stats.ttl_days}天` +
        (deleted > 0 ? `（启动清理 ${deleted} 条过期）` : '') +
        (historyDb.available ? '' : '（⚠️ 已降级为无历史模式）'),
    );
  } catch (error) {
    logger.error(`启动清理历史消息失败: ${String(error)}`);
  }
}

/**
 * 后台定期清理历史消息（每 1 小时一次）。
 *
 * 返回一个可取消的句柄（关服时调用 `stop()`）。
 */
export function startPeriodicHistoryCleanup(intervalMs = 3600_000): { stop: () => void } {
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        const deleted = await getHistoryDb().cleanupOld();
        if (deleted > 0) logger.info(`定期清理历史消息: 清理 ${deleted} 条过期消息`);
      } catch (error) {
        logger.error(`定期清理历史消息失败: ${String(error)}`);
      }
    })();
  }, intervalMs);

  // 不要因为这个定时器而阻塞进程退出
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
