/**
 * 配置管理 —— `src/utils/config.py` 的 TypeScript 移植。
 *
 * 与原实现的差异（都是有意为之，已在 `.codebuddy/memory` 记录）：
 *
 * 1. **零依赖**：不再用 pydantic-settings，`.env` 与进程环境变量由本模块自己读
 *    （自带极简 dotenv 解析，约 30 行）。
 * 2. **`DEBUG` 兼容非布尔字符串**：实测某些系统预置 `DEBUG=release`，pydantic 会
 *    直接校验失败导致服务起不来。Python 侧只能靠 `apis.sh` 在 shell 层兜底，
 *    这里在**代码层**兜底并告警 —— 换任何启动方式都不会再踩。
 * 3. **砍掉从未生效的配置**（用 `grep settings\\.<name>` 逐个核对过使用点）：
 *    - `redis_url` / `max_instances` / `max_requests_per_instance` /
 *      `health_check_interval` / `request_queue_max_size`：**0 处引用**
 *    - `browser_pool.*` / `user_data_dir`：只被 `browser/pool.py` 引用（该模块
 *      只在 `shutdown_event` 里调一次 `clear_all()`，池从未被填充，重写时丢弃）
 *    - `accounts` / `platforms`：只被 `load_config(config_file)` 的 YAML 分支引用，
 *      而该函数始终以无参调用 → YAML 分支从未执行
 */

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

import { logger } from './log/logger.js';

/** 浏览器池配置在 Python 版存在，但只被已废弃的 pool.py 使用，故不移植。 */
export interface Settings {
  appName: string;
  appVersion: string;
  debug: boolean;

  apiHost: string;
  apiPort: number;
  apiPrefix: string;

  browserHeadless: boolean;
  browserTimeout: number;

  requestTimeout: number;

  logLevel: string;
  logDir: string;
  debugLogs: boolean;

  availableModels: string;
  apiKeys: string;
  apiKeyRequired: boolean;
  rateLimitPerMinute: number;
  rateLimitEnabled: boolean;

  defaultWorkspacePaths: string;

  /** 凭证目录（`~/.ai-api/auth`）。保留原始 `~`，取用时过 {@link expandHome}。 */
  authDir: string;
}

/** 环境变量名 → 字段名。键名与 pydantic-settings 的推导结果保持一致。 */
const ENV_KEYS: Record<string, keyof Settings> = {
  APP_NAME: 'appName',
  APP_VERSION: 'appVersion',
  DEBUG: 'debug',
  API_HOST: 'apiHost',
  API_PORT: 'apiPort',
  API_PREFIX: 'apiPrefix',
  BROWSER_HEADLESS: 'browserHeadless',
  BROWSER_TIMEOUT: 'browserTimeout',
  REQUEST_TIMEOUT: 'requestTimeout',
  LOG_LEVEL: 'logLevel',
  LOG_DIR: 'logDir',
  DEBUG_LOGS: 'debugLogs',
  AVAILABLE_MODELS: 'availableModels',
  API_KEYS: 'apiKeys',
  API_KEY_REQUIRED: 'apiKeyRequired',
  RATE_LIMIT_PER_MINUTE: 'rateLimitPerMinute',
  RATE_LIMIT_ENABLED: 'rateLimitEnabled',
  DEFAULT_WORKSPACE_PATHS: 'defaultWorkspacePaths',
  AUTH_DIR: 'authDir',
};

/**
 * 从 `package.json` 读版本号。
 *
 * 为什么不写死：写死会出现「npm 上发的是 0.1.0、`/v1/health` 却报 0.2.0」这种
 * 前后不一致（实测就踩到过：代码默认 0.2.0 / package.json 0.1.0 / .env 又写 0.1.0）。
 * `package.json` 随包发布，作为唯一事实来源最可靠。
 * ⚠️ 仍然允许用 `APP_VERSION` 环境变量覆盖。
 */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const DEFAULTS: Settings = {
  appName: 'webaiapi',
  appVersion: readPackageVersion(),
  debug: false,

  apiHost: '0.0.0.0',
  apiPort: 8631,
  apiPrefix: '/v1',

  browserHeadless: true,
  browserTimeout: 60,

  requestTimeout: 300,

  logLevel: 'INFO',
  logDir: 'logs',
  debugLogs: false,

  availableModels: 'mix',
  apiKeys: '',
  apiKeyRequired: false,
  rateLimitPerMinute: 60,
  rateLimitEnabled: false,

  defaultWorkspacePaths: '',

  authDir: '~/.ai-api/auth',
};

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

/**
 * 宽松布尔解析。
 *
 * Python 版的 `Settings.debug: bool` 遇到 `DEBUG=release` 会直接抛
 * `ValidationError`，导致服务完全起不来（`apis.sh` 里那段 shell 兜底就是为此）。
 * 这里改为：能识别的按值解析，识别不了的回退默认值并告警。
 *
 * @param raw 原始字符串；`undefined` 表示未设置
 * @param key 用于告警的键名
 * @param fallback 无法识别时的回退值
 */
export function toBool(raw: string | undefined, key: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;

  const norm = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(norm)) return true;
  if (FALSE_VALUES.has(norm)) return false;

  console.warn(
    `[config] 环境变量 ${key}='${raw}' 不是合法布尔值，已回退为 ${fallback}` +
      `（Python 版会因此启动失败，这里做了兼容）`,
  );
  return fallback;
}

/** 整数解析；非法值回退默认并告警。 */
export function toInt(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] 环境变量 ${key}='${raw}' 不是合法整数，已回退为 ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * 极简 `.env` 解析（不覆盖已存在的进程环境变量）。
 *
 * 支持：`KEY=value`、`export KEY=value`、`#` 注释、单/双引号、值内含 `=`。
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    out[key] = value;
  }

  return out;
}

/** 展开开头的 `~` 为用户主目录（Python 侧的 `os.path.expanduser`）。 */
export function expandHome(path: string): string {
  if (path === '~') return process.env['HOME'] ?? path;
  if (path.startsWith('~/')) {
    const home = process.env['HOME'] ?? '';
    return home ? `${home}${path.slice(1)}` : path;
  }
  return path;
}

export interface LoadSettingsOptions {
  /** 显式给出的环境变量；缺省用 `process.env`。 */
  env?: Record<string, string | undefined>;
  /** `.env` 文件路径；传 `null` 表示不读文件，传 `undefined` 表示读 `.env`。 */
  dotEnvPath?: string | null;
  /** 读 `.env` 文件（注入依赖，便于测试）。 */
  readFile?: (path: string) => string;
}

/**
 * 组装配置。
 *
 * 优先级：`.env` 文件 < 进程环境变量 < 默认值（即环境变量覆盖 `.env`）。
 */
export function loadSettings(options: LoadSettingsOptions = {}): Settings {
  const {
    env = process.env as Record<string, string | undefined>,
    dotEnvPath = '.env',
    readFile = defaultReadFile,
  } = options;

  let fileVars: Record<string, string> = {};
  if (dotEnvPath !== null) {
    try {
      fileVars = parseDotEnv(readFile(dotEnvPath));
    } catch {
      // .env 不存在是正常情况（生产环境可以只用进程环境变量）
      fileVars = {};
    }
  }

  const pick = (key: string): string | undefined => env[key] ?? fileVars[key];

  /* ===== 无效键告警（**只查 `.env` 文件**，不看进程环境变量）=====
   * 为什么需要：Python 版留下的 `.env` 里有 REDIS_URL / MAX_INSTANCES /
   * USER_DATA_DIR 等一堆键，TS 版**根本不读**。它们不会报错、不会警告，
   * 用户改了却发现"没生效" —— 这类静默无效正是最难查的失败模式。
   *
   * 只检查 `.env` 文件里的键（那是**本项目的配置**，写进去就是有意图的）；
   * 不检查 `process.env`（那里混着 PATH/HOME/CI 等无关变量，会满屏误报）。
   */
  const unknownKeys = Object.keys(fileVars).filter((k) => !(k in ENV_KEYS));
  if (unknownKeys.length > 0) {
    logger.warn(
      `.env 里有 ${unknownKeys.length} 个配置项不会被读取（拼写错误或已废弃）：` +
        `${unknownKeys.join(', ')}。当前生效的键见 .env.example。`,
    );
  }

  const out: Settings = { ...DEFAULTS };

  for (const [envKey, field] of Object.entries(ENV_KEYS)) {
    const raw = pick(envKey);
    if (raw === undefined) continue;

    const fallback = DEFAULTS[field];
    if (typeof fallback === 'boolean') {
      out[field] = toBool(raw, envKey, fallback) as never;
    } else if (typeof fallback === 'number') {
      out[field] = toInt(raw, envKey, fallback) as never;
    } else {
      out[field] = raw as never;
    }
  }

  return out;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 全局配置单例（等价于 Python 的 `settings = load_config()`）。 */
export const settings: Settings = loadSettings();

/** 对外展示的模型列表（逗号分隔 → 数组），等价于 `get_available_models_list()`。 */
export function getAvailableModelsList(source: Settings = settings): string[] {
  if (!source.availableModels) return [];
  return source.availableModels
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/** API Key 集合，等价于 `get_api_keys()`。 */
export function getApiKeys(source: Settings = settings): Set<string> {
  if (!source.apiKeys) return new Set();
  return new Set(
    source.apiKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/**
 * 默认工作目录列表，等价于 `get_default_workspace_paths()`。
 *
 * 只保留**实际存在**的目录；未配置时回退当前工作目录。
 */
export function getDefaultWorkspacePaths(
  source: Settings = settings,
  exists: (path: string) => boolean = defaultIsDirectory,
): string[] {
  if (source.defaultWorkspacePaths) {
    return source.defaultWorkspacePaths
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '' && exists(p));
  }

  const cwd = process.cwd();
  return exists(cwd) ? [cwd] : [];
}

function defaultIsDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}
