#!/usr/bin/env node
/**
 * npm `postinstall`：尽力把 Playwright 的 **Firefox** 二进制装好。
 *
 * ## 为什么需要我们自己写
 * 实测（playwright 1.64.x）：`playwright` / `playwright-core` 的 `package.json`
 * **都没有 `scripts` 字段**，也就是**没有任何安装期脚本** —— `npm i playwright`
 * 只装 JS 包，**不下载浏览器**。而本包是给最终用户用的 CLI：
 * 用户 `npm i -g webaiapi` 之后期望「马上能用」，而不是先撞一次
 * 「Executable doesn't exist」再回来翻文档。
 *
 * ## ⚠️ 这层**不可靠**（2026-10-15）
 * **npm 11+ 默认拦截生命周期脚本**（安装时只提示 `npm install-scripts approve`，
 * 不执行），所以 postinstall 常常压根没跑。真正的保障是**运行时自动补装**：
 * `webaiapi start` / `webaiapi login` / `webaiapi doctor` 都会调
 * `ensureFirefox()` 再检查一次并自动下载。这里只是「提前做完」的优化。
 *
 * ## 三条原则
 * 1. **只装 firefox**（本项目硬约束：禁止 Chrome/Chromium）。默认的 `install`
 *    会把 chromium / webkit 一起拖下来（~400MB 浪费）。
 * 2. **失败绝不阻断安装**：一律 `exit 0`。安装脚本因为网络问题让整个 `npm i`
 *    失败，是最不可接受的失败方式。
 * 3. **尊重标准开关**：`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` 与
 *    `WEBAIAPI_SKIP_BROWSER_INSTALL`（本包的逃生口，CI 里常用）。
 *
 * ⚠️ 真正的逻辑在 `src/browser/ensure-firefox.ts`（有类型检查与单测）；
 *    本文件只是一层薄壳，保证 `dist/` 缺失时也不会让 `npm i` 失败
 *    （那层守卫在根目录的 `postinstall.mjs`）。
 */
import { ensureFirefox } from './browser/ensure-firefox.js';

void (async () => {
  try {
    // 跳过 / 已就绪 / 下载失败 三种情况都由 ensureFirefox 自己打日志（含手动兜底命令）
    ensureFirefox({ log: (message: string) => console.log(message) });
  } catch (error) {
    // 任何异常都不该让 npm install 失败
    console.log(`[webaiapi] postinstall 异常（已忽略）：${String(error)}`);
  }
})().finally(() => {
  // 显式 0：安装脚本的任何失败都不该让 npm install 失败
  process.exit(0);
});
