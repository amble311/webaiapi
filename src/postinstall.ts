#!/usr/bin/env node
/**
 * 安装后钩子：尽力把 Playwright 的 **Firefox** 二进制装好。
 *
 * ## 为什么需要我们自己写这个
 * 实测（playwright 1.64.0）：`playwright` 与 `playwright-core` 的 `package.json`
 * **都没有 `scripts` 字段**，也就是**没有任何安装期脚本** —— `npm i playwright`
 * 只装 JS 包，**不会下载浏览器**（浏览器缓存目录里 `firefox-1555` 的时间戳可以证明：
 * 它出现在我们手动执行 `npx playwright install firefox` 的那一刻，而不是 install 时）。
 *
 * 而 Playwright 官方对**库作者**的建议是「让用户自己装浏览器」，因为一个库不该
 * 偷偷下几百 MB。但本包是个**给最终用户用的 CLI**：用户 `npm i -g webaiapi`
 * 之后期望的是「马上能用」，而不是先撞一次「Executable doesn't exist」再回来翻文档。
 *
 * ## 三条设计原则
 * 1. **只装 firefox**（本项目硬约束：禁止 Chrome/Chromium）。默认的 `install`
 *    会把 chromium / webkit 一起拖下来（~400MB 浪费）。
 * 2. **失败绝不阻断安装**：一律 `exit 0` 并打印可复制的修复命令。
 *    安装脚本因为网络问题让整个 `npm i` 失败，是最不可接受的失败方式。
 * 3. **尊重标准开关**：`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`（Playwright 自己的约定）
 *    与 `WEBAIAPI_SKIP_BROWSER_INSTALL`（本包的逃生口，CI 里常用）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** 打印一行提示（安装期没有 pino，直接用 console）。 */
function say(message: string): void {
  console.log(`[webaiapi] ${message}`);
}

/** 是否被显式要求跳过。 */
function shouldSkip(): string | null {
  if (process.env['WEBAIAPI_SKIP_BROWSER_INSTALL']) return 'WEBAIAPI_SKIP_BROWSER_INSTALL 已设置';
  if (process.env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']) {
    return 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 已设置';
  }
  return null;
}

async function main(): Promise<void> {
  const skipReason = shouldSkip();
  if (skipReason) {
    say(`跳过浏览器安装（${skipReason}）。需要时手动运行: npx playwright install firefox`);
    return;
  }

  let firefox: typeof import('playwright').firefox;
  try {
    ({ firefox } = await import('playwright'));
  } catch (error) {
    say(`无法加载 playwright（${String(error)}），跳过浏览器安装`);
    return;
  }

  // 已经装好 → 什么都不做（大多数重复安装/本地 `npm i` 走这条快路径）
  try {
    const exe = firefox.executablePath();
    if (existsSync(exe)) return;
  } catch {
    // 拿不到路径就继续尝试安装
  }

  say('首次安装：正在下载 Playwright Firefox（约 80MB，只需一次）...');

  try {
    // ⚠️ 不能用 `npx playwright`：全局安装时 node_modules/.bin 不在 PATH 上。
    //    直接解析包内 CLI 的绝对路径最稳（`./package.json` 在 exports 白名单里）。
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve('playwright/package.json');
    const cli = join(dirname(pkgJson), 'cli.js');

    execFileSync(process.execPath, [cli, 'install', 'firefox'], {
      stdio: 'inherit',
      env: process.env,
    });
    say('Firefox 安装完成。运行 `webaiapi doctor` 可自检。');
  } catch (error) {
    // 绝不因为下载失败而让 `npm i` 失败 —— 提示用户手动补装即可
    say(`自动下载 Firefox 失败：${String(error)}`);
    say('安装本身已成功。需要对话时请手动运行: npx playwright install firefox');
  }
}

void main()
  .catch((error: unknown) => {
    say(`postinstall 异常（已忽略）：${String(error)}`);
  })
  .finally(() => {
    // 显式 0：安装脚本的任何失败都不该让 npm install 失败
    process.exit(0);
  });
