#!/usr/bin/env node
/**
 * CLI 入口 —— 合并了 Python 版的 `apis.sh`（服务运维）与 `scripts/capture_auth.py`
 * （凭证捕获）。
 *
 * 用法：
 * ```
 * webapi start                     启动服务（前台阻塞）
 * webapi status                    查看运行状态（账号 / 辅助通道 / 请求池）
 * webapi accounts                  只看账号与角色
 * webapi health                    健康检查
 * webapi login chatglm [--account x]  交互式登录并捕获凭证
 * webapi logout chatglm [--account x] 删除某账号的凭证
 * webapi --help
 * ```
 *
 * ## 为什么用 CLI 而不是 shell 脚本
 * Python 版的 `apis.sh` 有个必须存在的理由：它在 shell 层把环境里的
 * `DEBUG=release` 归一化成 `DEBUG=false`，否则 pydantic 的 `Settings.debug: bool`
 * 会校验失败。TS 版的配置解析器（`toBool`）**自己就容错**，
 * 所以 shell 包装层不再需要，CLI 用 Node 直接跑。
 */
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { settings } from './config.js';
import { listAccounts, loadAuth } from './browser/credentials.js';
import { PLATFORM_IDS, PLATFORM_LIST } from './browser/platforms.js';
import { logger } from './log/logger.js';
import { padDisplay } from './utils/prompt.js';

/* ==================================================================== */
/* 参数解析                                                            */
/* ==================================================================== */

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** 极简参数解析（避免为一个 CLI 引入 commander/yargs）。 */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name.includes('=')) {
        const idx = name.indexOf('=');
        flags[name.slice(0, idx)] = name.slice(idx + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0] ?? 'help', positional: positional.slice(1), flags };
}

/** 取一个字符串型 flag（`--account=acc2` / `--account acc2` 两种写法都支持）。 */
function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 取一个布尔型 flag（`--yes`）。 */
function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

/* ==================================================================== */
/* 帮助                                                                */
/* ==================================================================== */

export function helpText(): string {
  // 平台清单由注册表生成（`platforms.ts`）——加平台不用改这里。
  // ⚠️ 必须用 padDisplay（按显示宽度）而不是 padEnd：中文/全角占两列，
  //    padEnd 会让第二列参差不齐。
  const platformLines = PLATFORM_LIST.map((spec) => {
    const tag = spec.providerImplemented ? '可对话' : '暂仅可捕获凭证';
    return `  ${padDisplay(spec.id, 10)} ${padDisplay(spec.displayName, 18)} ${tag}`;
  }).join('\n');

  return `
webapi —— 把国产 AI 聊天网页包装成 OpenAI 兼容接口

用法:
  webapi login [<platform>] [--account <id>]   登录并捕获凭证（可多账号，交互式选择）
  webapi logout [<platform>] [--account <id>]   删除某账号的凭证（交互式选择）
  webapi accounts                               账号与角色（多账号是否生效的权威视图）
  webapi status                                 运行状态（模型路由 / 辅助通道 / 请求池）
  webapi health                                 健康检查（各平台登录状态）
  webapi doctor                                 自检（Node / Firefox / 凭证 / 端口）
  webapi start                                  启动服务（前台运行，Ctrl-C 退出）
  webapi --help
  webapi --version

平台（login / logout 不给参数时会让你选）:
${platformLines}

首次使用（两步）:
  1. npx playwright install firefox    下载浏览器（约 80MB，只需一次）
  2. webapi login                         选平台 → 登录并捕获凭证（会打开可见浏览器）

多账号:
  同一平台登录第二个账号即可启用「辅助通道」—— 历史压缩与工具调用转换
  因此能与主对话并行（只有一个账号时这些任务与主对话串行，功能正常但更慢）。
  账号名会从登录身份自动派生（用户名 → uid），不用自己想。
  ⚠️ 两个账号必须是不同的人：抓到的身份与 Cookie 都会被校验，重复了会拦下来。

  非交互（脚本 / CI）: webapi login chatglm --account acc2 --yes

环境变量（可用 .env）:
  API_HOST / API_PORT      监听地址与端口（默认 ${settings.apiHost}:${settings.apiPort}）
  API_PREFIX               路由前缀（默认 ${settings.apiPrefix}）
  REQUEST_TIMEOUT          请求超时秒数（默认 ${settings.requestTimeout}）
  RATE_LIMIT_ENABLED       是否限流（默认 ${String(settings.rateLimitEnabled)}）
  RATE_LIMIT_PER_MINUTE    每客户端每分钟请求数（默认 ${settings.rateLimitPerMinute}）
  API_KEYS                 逗号分隔的密钥列表
  API_KEY_REQUIRED         是否强制校验（默认 ${String(settings.apiKeyRequired)}）
  DEBUG_LOGS               是否写调试日志（默认 ${String(settings.debugLogs)}）
  CHATGLM_MAIN_ACCOUNT     钉死主通道账号（默认启动时随机分配）
  NO_COLOR                 设了就不输出 ANSI 颜色

服务地址: http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}
`.trim();
}

/* ==================================================================== */
/* 子命令                                                              */
/* ==================================================================== */

/**
 * 请求本地服务的 JSON 接口（失败返回 null）。
 *
 * ⚠️ 超时必须**按端点区分**：
 * - `/status`、`/models` 很快（只读文件），几秒足够；
 * - `/health` 会**真的启动浏览器并整页探测登录态**，首次要 6~20s ——
 *   用统一的 8s 超时会得到「明明服务在跑却说没在跑」的误导结论。
 */
async function fetchJson(path: string, timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  const url = `http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}${path}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return null;
      return (await resp.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** `status` / `accounts`：格式化账号与辅助通道视图。 */
function renderAccounts(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const accounts = (payload['accounts'] ?? {}) as Record<
    string,
    Array<{
      account_id: string;
      identity: string;
      cookies: number;
      roles: string[];
      cooldown_seconds: number;
      busy: boolean;
    }>
  >;

  const platforms = Object.keys(accounts);
  if (platforms.length === 0) {
    lines.push('（未发现任何凭证：请先运行 `webapi login chatglm`）');
    return lines;
  }

  for (const platform of platforms) {
    lines.push(`【${platform}】`);
    for (const acc of accounts[platform] ?? []) {
      const parts = [
        `  ${acc.account_id}`,
        `身份=${acc.identity || '(未知)'}`,
        `Cookie=${acc.cookies}`,
        `角色=${acc.roles.join('+')}`,
      ];
      if (acc.cooldown_seconds > 0) parts.push(`冷却中(${acc.cooldown_seconds}s)`);
      if (acc.busy) parts.push('使用中');
      lines.push(parts.join('  '));
    }
  }

  const aux = (payload['aux_channel'] ?? {}) as Record<string, unknown>;
  lines.push('');
  lines.push(
    aux['enabled']
      ? `辅助通道: 已启用（${String(aux['platform'])}/${String(aux['account_id'])}，` +
          `身份 ${String(aux['identity'] || '未知')}）→ 压缩/转换可与主对话并行`
      : '辅助通道: 未启用（同平台只有一个账号）→ 辅助任务与主对话串行',
  );

  return lines;
}

/** `status` 子命令。 */
async function cmdStatus(): Promise<number> {
  const payload = await fetchJson('/status');
  if (!payload) {
    console.error(
      `无法连接服务（http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}）。` +
        '请先运行 `webapi start`。',
    );
    return 1;
  }

  console.log(renderAccounts(payload).join('\n'));

  const pool = payload['request_pool'] as Record<string, unknown> | undefined;
  if (pool) {
    console.log('');
    console.log(
      `请求池: 总 ${String(pool['total_requests'])}（队列 ${String(pool['queue_size'])}）` +
        `  ${JSON.stringify(pool['status_counts'])}`,
    );
  }
  return 0;
}

/** `accounts` 子命令。 */
async function cmdAccounts(): Promise<number> {
  const payload = await fetchJson('/status');
  if (!payload) {
    console.error('无法连接服务，请先运行 `webapi start`。');
    return 1;
  }
  console.log(renderAccounts(payload).join('\n'));
  return 0;
}

/** `health` 子命令。 */
async function cmdHealth(): Promise<number> {
  // ⚠️ /health 会启动浏览器探测登录态，首次可能要 20s+，不能用短超时
  console.log('正在检查各平台登录状态（首次会启动浏览器，请稍候）...');
  const payload = await fetchJson('/health', 120_000);
  if (!payload) {
    console.error('服务不可用（健康检查失败或超时）。');
    return 1;
  }
  console.log(`状态: ${String(payload['status'])}  版本: ${String(payload['version'])}`);
  const providers = (payload['providers'] ?? {}) as Record<string, Record<string, string>>;
  for (const [name, info] of Object.entries(providers)) {
    console.log(`  ${name}: ${info['status']}${info['message'] ? ` (${info['message']})` : ''}`);
  }
  return payload['status'] === 'ok' ? 0 : 1;
}

/* `logout` 已迁到 `browser/login-flow.ts` 的 `runLogout()`：
 * 它需要交互式选账号，而且**不能**再默认删 `default`（旧实现在这里就会静默删错）。 */

/**
 * `doctor` 子命令：自检。
 *
 * 为什么需要：这个包**装完之后最常见的失败**有两个，而且都不是代码问题 ——
 * ① 没下 Firefox 二进制（Playwright 不随包分发浏览器，约 80MB）；
 * ② 没捕获凭证（等于没登录，平台会一直回「请求过于频繁」）。
 * 两者都会表现为「装好了但跑不起来」，`doctor` 把它们变成一句可执行的提示。
 */
async function cmdDoctor(): Promise<number> {
  let problems = 0;
  const ok = (msg: string): void => console.log(`  ✅ ${msg}`);
  const bad = (msg: string, fix?: string): void => {
    problems += 1;
    console.log(`  ❌ ${msg}`);
    if (fix) console.log(`     → ${fix}`);
  };
  const warn = (msg: string, fix?: string): void => {
    console.log(`  ⚠️  ${msg}`);
    if (fix) console.log(`     → ${fix}`);
  };

  console.log('\n【运行时】');
  const major = Number(process.versions.node.split('.')[0] ?? 0);
  const minor = Number(process.versions.node.split('.')[1] ?? 0);
  const nodeOk = major > 20 || (major === 20 && minor >= 11);
  if (nodeOk) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} 过旧（需要 >= 20.11）`);

  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    require('node:sqlite');
    ok('node:sqlite 可用（跨平台历史注入正常）');
  } catch {
    warn(
      'node:sqlite 不可用（需要 Node >= 22.5）',
      '历史消息功能会退化为「不注入历史」，对话本身不受影响',
    );
  }

  console.log('\n【浏览器】');
  try {
    const { firefox } = await import('playwright');
    const exe = firefox.executablePath();
    if (existsSync(exe)) {
      ok(`Firefox 二进制已就绪: ${exe}`);
    } else {
      bad(
        'Firefox 二进制缺失（Playwright 不随包分发浏览器）',
        'npx playwright install firefox',
      );
    }
  } catch (error) {
    bad(`无法加载 playwright: ${String(error)}`, 'npm i playwright');
  }

  console.log('\n【凭证】');
  let totalAccounts = 0;
  for (const platform of PLATFORM_IDS) {
    let accounts: string[] = [];
    try {
      accounts = listAccounts(platform);
    } catch {
      accounts = [];
    }
    if (accounts.length === 0) continue;
    totalAccounts += accounts.length;
    const detail = accounts
      .map((acc) => {
        const auth = loadAuth(platform, { accountId: acc });
        const label = auth?.account_info?.label ?? auth?.account_info?.identifier ?? '未知';
        const cookies = auth?.cookies?.length ?? 0;
        return `${acc}(${label}, ${cookies} cookie)`;
      })
      .join('  ');
    ok(`${platform}: ${detail}`);
  }
  if (totalAccounts === 0) {
    bad('没有任何凭证（等于没登录，平台会一直回「请求过于频繁」）', 'webapi login chatglm');
  } else if (totalAccounts === 1) {
    warn(
      '只有 1 个账号 → 辅助通道不会启用，压缩/转换与主对话串行（功能正常，只是慢一些）',
      '再加一个账号：webapi login chatglm --account acc2',
    );
  }

  console.log('\n【服务】');
  // ⚠️ 用 `/status` 判「在不在跑」：它只读凭证文件，毫秒级返回。
  //    不能用 `/health` —— 那个会启动浏览器整页探测，8s 超时下会把
  //    「正在跑但探测很慢」误报成「没在跑」。
  const alive = await fetchJson('/status', 6000);
  if (!alive) {
    console.log('  ℹ️  服务未在运行（正常，如果你还没 webapi start）');
  } else {
    ok(`服务在跑: http://${settings.apiHost}:${settings.apiPort}${settings.apiPrefix}`);
    console.log('  正在检查登录状态（会启动浏览器，请稍候）...');
    const health = await fetchJson('/health', 120_000);
    const providers = (health?.['providers'] ?? {}) as Record<string, Record<string, string>>;
    for (const [name, info] of Object.entries(providers)) {
      if (info['status'] === 'connected') ok(`${name}: connected`);
      else warn(`${name}: ${info['status']}`, 'webapi login chatglm');
    }
    if (!health) warn('登录状态查询超时（服务本身正常）', 'webapi health 可单独重试');
  }

  console.log('');
  if (problems === 0) {
    console.log('自检通过 ✅  下一步: webapi start\n');
    return 0;
  }
  console.log(`发现 ${problems} 个必须解决的问题（见上方 ❌）\n`);
  return 1;
}

/* ==================================================================== */
/* 入口                                                                */
/* ==================================================================== */

export async function runCli(argv: ReadonlyArray<string> = process.argv): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  /* `webapi --version` / `-v`：发布后校验要用它（见 release 技能第 8 步）。
   * ⚠️ `parseArgs` 会把 `--xxx` 收进 `flags`（`--help` 也因此变成 command='help'），
   *    所以这里必须在 switch **之前**判 flags。 */
  if (flags['version'] || flags['v']) {
    const { settings } = await import('./config.js');
    console.log(settings.appVersion);
    return 0;
  }

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText());
      return 0;

    case 'version': {
      const { settings } = await import('./config.js');
      console.log(settings.appVersion);
      return 0;
    }

    case 'start': {
      const { startServer } = await import('./server/app.js');
      // startServer 返回退出码（0 正常 / 1 启动失败，如端口被占用）——
      // 不能忽略它，否则失败时 CLI 仍以 0 退出，脚本会误判成功
      return await startServer();
    }

    case 'status':
      return cmdStatus();

    case 'accounts':
      return cmdAccounts();

    case 'health':
      return cmdHealth();

    case 'doctor':
      return cmdDoctor();

    case 'login': {
      const { runLogin } = await import('./browser/login-flow.js');
      return runLogin({
        platform: strFlag(flags, 'platform') ?? positional[0],
        account: strFlag(flags, 'account'),
        yes: boolFlag(flags, 'yes') || boolFlag(flags, 'y'),
        noInput: boolFlag(flags, 'no-input'),
      });
    }

    case 'logout': {
      const { runLogout } = await import('./browser/login-flow.js');
      return runLogout({
        platform: strFlag(flags, 'platform') ?? positional[0],
        account: strFlag(flags, 'account'),
        yes: boolFlag(flags, 'yes') || boolFlag(flags, 'y'),
        noInput: boolFlag(flags, 'no-input'),
      });
    }

    default:
      console.error(`未知命令: ${command}\n`);
      console.log(helpText());
      return 1;
  }
}

/* `describeExistingAccounts` 已删除：它是死代码（全仓库只有定义、没有调用），
 * 而且职责与 `login-flow.ts` 的 `readExistingAccounts()` 重复。
 * 需要「列出账号及其身份」请用那个。 */

/**
 * 本模块是否被**直接执行**（而不是被 import）。
 *
 * ⚠️ 不能用 `argv[1].endsWith('cli.js')` 这种写法：npm 安装后 bin 是**符号链接**
 * （`node_modules/.bin/webapi` → `../webaiapi/dist/cli.js`），而 Node 的
 * `process.argv[1]` 是**未经 realpath 解析**的路径 —— 名字对不上，
 * CLI 会静默什么都不做（最难查的一类"装好了但没反应"）。
 * 这里对两边都做 realpath 再比。
 */
function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// 直接执行时才跑（被 import 时不跑）
if (isDirectExecution()) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      logger.error(`CLI 异常: ${String(error)}`);
      process.exitCode = 1;
    });
}
