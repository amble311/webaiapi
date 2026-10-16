/**
 * 保证 Playwright 的 **Firefox 二进制**就绪 —— 缺了就**自动下载**。
 *
 * ## 为什么需要“运行时自动补装”（2026-10-15）
 * 安装期已经有一层 `postinstall`（见 `src/postinstall.ts`）会下载 Firefox，但
 * **npm 11+ 默认拦截生命周期脚本**（安装时只提示 `npm install-scripts approve`，不执行），
 * 于是用户 `npm i -g webaiapi` 之后仍然会撞上 Playwright 的
 * 「Executable doesn't exist at …/firefox-1555/firefox/firefox」。
 *
 * 结论：**不能只依赖 postinstall**。这里提供一个同步、幂等、绝不抛异常的入口，
 * 在真正要用浏览器之前（`webaiapi start` / `webaiapi login` / `webaiapi doctor`）调一次：
 * - 已就绪 → 一次 `existsSync`，零开销直接返回；
 * - 缺失 → 打印进度并自动执行 `node <playwright>/cli.js install firefox`
 *   （⚠️ **不能用 `npx playwright`**：全局安装时 `node_modules/.bin` 不在 PATH 上，
 *   而且 npx 可能去联网解析包；直接跑包内 CLI 的绝对路径最稳）。
 *
 * 失败**只警告不阻断**：健康检查、`/v1/models` 等不需要浏览器。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** 自动安装失败时给用户的手动兜底命令。 */
export const MANUAL_INSTALL_HINT = 'npx playwright install firefox';

/** 自动下载的超时（毫秒）——防止网络卡死把启动卡住。 */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

export interface EnsureFirefoxOptions {
  /** 检测是否已就绪；默认走 Playwright 的 `firefox.executablePath()`（测试可注入）。 */
  isInstalled?: () => boolean;
  /** 执行安装；默认 `node <playwright>/cli.js install firefox`（测试可注入）。 */
  runInstall?: () => { ok: boolean; error?: string };
  /** 进度输出；默认 `console.log`（CLI/安装期没有 pino）。 */
  log?: (message: string) => void;
  /** 显式跳过（等价于设 `WEBAIAPI_SKIP_BROWSER_INSTALL`）。 */
  skip?: boolean;
  /** 环境变量来源（测试可注入）。 */
  env?: Record<string, string | undefined>;
}

export interface EnsureFirefoxResult {
  /** 调用结束时 Firefox 是否就绪。 */
  installed: boolean;
  /** 本次是否真的执行了安装。 */
  attempted: boolean;
  /** 被跳过时的原因（`attempted=false` 时才有值）。 */
  skippedReason?: string;
  /** 安装失败时的原因摘要。 */
  error?: string;
}

/**
 * 是否被显式要求跳过浏览器安装。
 *
 * 两个开关都认：`WEBAIAPI_SKIP_BROWSER_INSTALL`（本包的逃生口）与
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`（Playwright 自己的约定，CI 里常见）。
 */
export function skipBrowserInstallReason(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env['WEBAIAPI_SKIP_BROWSER_INSTALL']) return 'WEBAIAPI_SKIP_BROWSER_INSTALL 已设置';
  if (env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']) return 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 已设置';
  return null;
}

/** Playwright Firefox 二进制的绝对路径（解析/取值失败返回 null，绝不抛）。 */
export function firefoxExecutablePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const playwright = require('playwright') as {
      firefox?: { executablePath?: () => string };
    };
    const exe = playwright.firefox?.executablePath?.();
    return exe ? String(exe) : null;
  } catch {
    return null;
  }
}

/** Firefox 二进制是否已就绪（同步、零副作用）。 */
export function isFirefoxInstalled(): boolean {
  const exe = firefoxExecutablePath();
  if (!exe) return false;
  try {
    return existsSync(exe);
  } catch {
    return false;
  }
}

/** 包内 Playwright CLI 的绝对路径（`playwright/package.json` 在 exports 白名单里）。 */
export function playwrightCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // ⚠️ 不能 `require.resolve('playwright/cli.js')`：exports 里没有这个子路径，
    //    会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。走 package.json 再拼目录名。
    const pkgJson = require.resolve('playwright/package.json');
    return join(dirname(pkgJson), 'cli.js');
  } catch {
    return null;
  }
}

/** 默认安装执行器：直接跑包内 CLI（不经 npx / 不依赖 PATH）。 */
function defaultRunInstall(log: (message: string) => void): { ok: boolean; error?: string } {
  const cli = playwrightCliPath();
  if (!cli) return { ok: false, error: '找不到 playwright 包（请先 npm i playwright）' };

  try {
    log(`[webaiapi] 执行: node ${cli} install firefox`);
    execFileSync(process.execPath, [cli, 'install', 'firefox'], {
      stdio: 'inherit',
      env: process.env,
      timeout: INSTALL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * 保证浏览器就绪（幂等；已在就零开销返回）。
 *
 * @returns 结果对象（含是否尝试过安装、失败原因），**永不抛异常**。
 */
export function ensureFirefox(options: EnsureFirefoxOptions = {}): EnsureFirefoxResult {
  const isInstalled = options.isInstalled ?? isFirefoxInstalled;
  const log = options.log ?? ((message: string) => console.log(message));

  // 快路径：大多数情况下浏览器早就装好了
  try {
    if (isInstalled()) return { installed: true, attempted: false };
  } catch {
    // 检测本身出错 → 当作「未就绪」继续走安装
  }

  const skippedReason = options.skip ? '显式跳过' : skipBrowserInstallReason(options.env);
  if (skippedReason) {
    log(`[webaiapi] 跳过浏览器自动安装（${skippedReason}）。需要时手动运行: ${MANUAL_INSTALL_HINT}`);
    return { installed: false, attempted: false, skippedReason };
  }

  log('[webaiapi] 首次运行需要 Playwright Firefox（约 80MB，只需一次），正在自动下载...');

  let result: { ok: boolean; error?: string };
  try {
    result = (options.runInstall ?? (() => defaultRunInstall(log)))();
  } catch (error) {
    result = { ok: false, error: String(error) };
  }

  let installed = false;
  try {
    installed = isInstalled();
  } catch {
    installed = false;
  }

  if (result.ok && installed) {
    log('[webaiapi] Firefox 已就绪。');
    return { installed: true, attempted: true };
  }

  const error = result.error ?? (result.ok ? '安装命令成功但二进制仍不可用' : '未知错误');
  log(`[webaiapi] ⚠️ 自动下载 Firefox 失败：${error}`);
  log(`[webaiapi] 对话功能暂不可用（健康检查与 /v1/models 不受影响）。手动补装: ${MANUAL_INSTALL_HINT}`);
  return { installed: false, attempted: true, error };
}
