/**
 * Fastify 应用组装 —— `legacy-python/src/main.py` 的移植。
 *
 * ## ⚠️ 一处**有意修复**的偏差（必须知道）
 * Python 的 `verify_api_key` 是个 FastAPI **依赖**，但**从来没有被任何路由
 * `Depends()` 引用**（`grep -rn "Depends(" src` 只有它自己的签名）。
 * 也就是说：Python 版里 API Key 认证**从来没生效过** —— `main.py` 往管理器里塞了密钥、
 * 设了 `required`，但没有任何地方去查。
 *
 * TS 版把它**接上了**（`onRequest` 钩子），但保持完全相同的放行语义：
 * - `API_KEYS` 为空 → 强制为「不校验」（与 Python 的日志「API Key 认证已禁用」一致）；
 * - `API_KEY_REQUIRED=false`（默认）→ 不带密钥也放行，**现有用户零感知**；
 * - 只有显式 `API_KEY_REQUIRED=true` 时才真正拦 401。
 *
 * ## 其他差异
 * - CORS 用**手写钩子**而不是 `@fastify/cors`：少一个运行时依赖，
 *   且能正确实现「`allow_credentials` + 通配来源」这个 FastAPI 写法其实不合法、
 *   浏览器会拒绝的组合（这里回显请求方 Origin）。
 */
import { execFileSync } from 'node:child_process';

import Fastify, { type FastifyInstance } from 'fastify';

import { getApiKeys, settings } from '../config.js';
import { getHistoryDb } from '../controllers/history-db.js';
import { getModelRouter } from '../controllers/router.js';
import { resetApiLog } from '../log/api-logger.js';
import { removePidFileIfOwned, writePidFile } from './pidfile.js';
import { logger } from '../log/logger.js';
import { ensureFirefox } from '../browser/ensure-firefox.js';
import { disposeAllChannels, disposeSharedBrowser } from '../browser/manager.js';
import { registerChatRoutes } from '../routes/chat.js';
import { registerMetaRoutes, runStartupTasks, startPeriodicHistoryCleanup } from '../routes/meta.js';
import { waitForBackgroundTasks } from '../routes/compress.js';
import { errorMessage } from '../utils/errors.js';
import { getApiKeyManager, makeApiKeyHook, verifyApiKey } from './middleware/api-key.js';
import { makeRateLimitHook } from './middleware/rate-limit.js';
import { makeTimeoutHook } from './middleware/timeout.js';

/** 关服时挂起的清理句柄。 */
let periodicCleanup: { stop: () => void } | null = null;

/**
 * 初始化 API Key 管理器。
 *
 * 与 Python `main()` 的语义一致：**没有配置任何密钥时视为禁用认证**
 * （即使 `API_KEY_REQUIRED=true` 也不拦 —— 否则等于把自己锁在门外）。
 */
export function initApiKeys(): void {
  const manager = getApiKeyManager();
  const keys = getApiKeys();

  if (keys.size === 0) {
    manager.required = false;
    logger.info('API Key 认证已禁用（未配置密钥）');
    return;
  }

  for (const key of keys) manager.addKey(key);
  manager.required = settings.apiKeyRequired;
  logger.info(
    `API Key 认证已配置: ${keys.size} 个密钥` +
      `（${settings.apiKeyRequired ? '强制校验' : '仅记录，不拦截'}）`,
  );
}

/**
 * 创建 Fastify 应用（不监听端口）。
 *
 * 中间件顺序与原实现一致：CORS → 超时 → 限流 → 认证 → 路由。
 */
export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // ⚠️ 不用 Fastify 内建 logger：项目统一走 pino 单例（`src/log/logger.ts`），
    //    避免同一条日志被两套格式化器各打一遍。
    logger: false,
    trustProxy: true, // 让 `request.ip` 取到反向代理后的真实 IP（限流按 IP 时很关键）
    bodyLimit: 64 * 1024 * 1024, // 上下文可能很大（几十万字符的历史）
  });

  initApiKeys();

  const prefix = settings.apiPrefix || '';

  /* ===== CORS（手写，见文件头说明）===== */
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers['origin'];
    if (typeof origin === 'string' && origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
    } else {
      reply.header('access-control-allow-origin', '*');
    }
    reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    reply.header(
      'access-control-allow-headers',
      (request.headers['access-control-request-headers'] as string) || '*',
    );
    // 预检直接结束，不进业务逻辑
    if (request.method === 'OPTIONS') {
      void reply.code(204).send();
    }
  });

  /* ===== 超时（必须在业务路由之前，才能把 deadline 传给下游）===== */
  const skipPaths = new Set([
    `${prefix}/health`,
    `${prefix}/status`,
    '/health',
    '/status',
    '/',
  ]);
  app.addHook(
    'onRequest',
    makeTimeoutHook({ timeoutSeconds: settings.requestTimeout, skipPaths }),
  );

  /* ===== 限流 ===== */
  app.addHook(
    'onRequest',
    makeRateLimitHook({
      requestsPerMinute: settings.rateLimitPerMinute,
      enabled: settings.rateLimitEnabled,
      skipPaths,
    }),
  );

  /* ===== API Key 认证 =====
   * 只在「配了密钥**且**要求强制」时才真的校验（见文件头说明）。 */
  const apiKeyManager = getApiKeyManager();
  if (apiKeyManager.required) {
    app.addHook('onRequest', makeApiKeyHook(skipPaths));
  } else {
    // 未强制时也解析一次密钥：便于限流按 key 分组（但不拦截）
    app.addHook('onRequest', async (request) => {
      verifyApiKey(request);
    });
  }

  /* ===== 路由 ===== */
  await app.register(
    async (instance: FastifyInstance) => {
      registerMetaRoutes(instance);
      registerChatRoutes(instance);
    },
    prefix ? { prefix } : {},
  );

  // 根路径（便于确认服务活着）
  app.get('/', async () => ({
    name: settings.appName,
    version: settings.appVersion,
    docs: `${prefix}/models`,
  }));

  /* ===== 404 ===== */
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: {
        message: `Not Found: ${request.method} ${request.url}`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    });
  });

  /* ===== 全局异常处理 ===== */
  app.setErrorHandler((error: unknown, _request, reply) => {
    // Fastify 的 body 解析错误（JSON 语法错等）自带 4xx 状态码
    const err = error as { statusCode?: number; message?: string; code?: string };
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const message = err.message ?? '内部服务器错误';
    if (statusCode >= 500) {
      logger.error(`未处理的异常: ${message}`);
    }
    const payload =
      statusCode >= 500
        ? { message: '内部服务器错误', type: 'server_error', code: 'internal_error' }
        : { message, type: 'invalid_request_error', code: err.code ?? null };
    void reply.code(statusCode >= 500 ? 500 : statusCode).send({ error: payload });
  });

  return app;
}

/**
 * 启动服务（含启动任务与优雅关闭）。
 *
 * 返回的 Promise 在服务关闭后 resolve（与 `uvicorn.run` 的阻塞语义一致）。
 */
/* ==================================================================== */
/* 端口占用诊断                                                        */
/* ==================================================================== */

/** 判断错误是不是「端口被占用」。 */
function isAddrInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.['code'];
  if (typeof code === 'string' && code === 'EADDRINUSE') return true;
  return String(error).includes('EADDRINUSE');
}

/**
 * 尽力找出占用指定端口的进程 PID（找不到返回 `null`）。
 *
 * ⚠️ 这里的输出**只用于给用户一句提示**，所以任何失败都必须静默放弃 ——
 * 绝不能因为「`ss`/`lsof` 不存在、输出格式变了、没权限看别人的进程」
 * 而把启动流程搞挂。同用户的进程才能看到 pid，而我们提示的恰恰是
 * 「另一个同用户实例」这种最常见的情况，所以够用。
 */
function pidListeningOn(port: number): number | null {
  const tryRead = (cmd: string, args: string[], pattern: RegExp): number | null => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 3000 });
      const match = pattern.exec(out);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  };

  // `ss -ltnp`：LISTEN 0 511 0.0.0.0:8631 ... users:(("MainThread",pid=78002,fd=24))
  const bySs = tryRead('ss', ['-ltnp'], new RegExp(`:${port}\\b.*pid=(\\d+)`));
  if (bySs !== null) return bySs;

  // `lsof -ti :PORT`：每行一个 pid
  return tryRead('lsof', ['-ti', `:${port}`], /^(\d+)$/m);
}

/**
 * 启动服务并阻塞直到进程收到退出信号。
 *
 * @returns 进程退出码：`0` 正常 / `1` 启动失败（如端口被占用）。
 *   ⚠️ 返回退出码而不是在函数里设 `process.exitCode` —— CLI 侧的
 *   `process.exitCode = await runCli()` 会覆盖它（实测踩过：报错信息是对的，
 *   退出码却是 0，脚本会误判成功）。
 */
export async function startServer(): Promise<number> {
  const app = await createApp();

  // ===== 启动任务 =====
  resetApiLog();
  logger.info('API 请求日志已重置');
  await runStartupTasks();
  periodicCleanup = startPeriodicHistoryCleanup();

  // 预热模型路由器（会打印账号分配与辅助通道状态，是排查「多账号有没有生效」的第一现场）
  getModelRouter();

  /* ===== 浏览器二进制预检 + **缺了自动补装**（非致命）=====
   * Playwright 不随包分发浏览器（Firefox 约 80MB），这是 npm 安装后最常见的
   * 「装好了但跑不起来」。安装期的 `postinstall` 会下载，但 **npm 11+ 默认拦截
   * 生命周期脚本** → 很多人根本没跑过它。所以在启动时查一次：缺了就**自动下载**，
   * 失败才警告（**不阻断启动** —— 健康检查、/v1/models 等不需要浏览器）。 */
  try {
    const result = ensureFirefox({ log: (message: string) => logger.info(message) });
    if (!result.installed) {
      logger.warn('⚠️ Firefox 二进制不可用，真实对话会失败（健康检查 / /v1/models 不受影响）');
    }
  } catch (error) {
    logger.warn(`浏览器预检失败: ${errorMessage(error)}`);
  }

  const url = `http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}`;
  try {
    await app.listen({ host: settings.apiHost, port: settings.apiPort });
  } catch (error) {
    // ⚠️ 必须拦下来翻译成人话：`listen` 失败时 Node 抛的是一整段堆栈
    //    （`UVExceptionWithHostPort ... code: 'EADDRINUSE'`），用户看不出
    //    「其实是有另一个实例在跑」—— 实测就有这样的困惑。
    //    而且此时启动已经做了不少事（注册 Provider、启用辅助通道、
    //    打开浏览器），堆栈会把真正的原因淹没在里面。
    if (isAddrInUse(error)) {
      const pid = pidListeningOn(settings.apiPort);
      logger.error(
        `端口 ${settings.apiPort} 已被占用（${pid ? `进程 ${pid}` : '可能有另一个实例在跑'}）。` +
          '\n  处理方式任选：' +
          '\n  1. 直接用已在跑的那个实例（`webaiapi status` 可查看）；' +
          `\n  2. 停掉它再启动：kill ${pid ?? '<pid>'}；` +
          `\n  3. 换个端口：API_PORT=${settings.apiPort + 1} webaiapi start`,
      );
      // ⚠️ 返回退出码而不是设 `process.exitCode`：CLI 侧会执行
      //    `process.exitCode = await runCli()`，把这里设的值**覆盖回 0**
      //    （实测确实发生了：报错信息对了，退出码却是 0，脚本会误判成功）。
      return 1;
    }
    throw error;
  }
  logger.info(`服务已启动: ${url}`);
  /* 写 pid 文件：后台/`nohup` 启动时也能用 `webaiapi stop` 停掉（2026-10-16 用户要求）。
   * 前台跑照样写 —— 只是 Ctrl-C 时就把它删掉了。 */
  writePidFile(process.pid);
  logger.debug(`PID 文件已写入: ${process.pid}`);

  // ===== 优雅关闭 =====
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在关闭...`);
    try {
      await app.close();
    } catch (error) {
      logger.warn(`关闭 HTTP 服务失败: ${errorMessage(error)}`);
    }
    periodicCleanup?.stop();
    await waitForBackgroundTasks();
    try {
      await disposeAllChannels();
      await disposeSharedBrowser();
      logger.info('浏览器资源已清理');
    } catch (error) {
      logger.warn(`清理浏览器失败: ${errorMessage(error)}`);
    }
    try {
      getHistoryDb().close();
    } catch {
      // 忽略
    }
    removePidFileIfOwned();
    logger.info('应用已关闭');
  };

  // 兜底：无论怎么退出都别留下陈旧 pid 文件（否则 `stop` 会对着死 pid 报错）
  process.once('exit', () => removePidFileIfOwned());

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(() => process.exit(0));
    });
  }

  await new Promise<void>((resolve) => {
    app.server.once('close', () => resolve());
  });
  return 0;
}
