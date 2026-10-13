#!/usr/bin/env node
/**
 * npm `postinstall` 的入口守卫。
 *
 * 真正的逻辑在 `dist/postinstall.js`（TypeScript 写的，有类型检查与审阅价值）。
 * 这一层只做一件事：**保证 dist 不存在时不把 `npm i` 弄失败**。
 *
 * 为什么必需：`npm i` 会在**全新 clone** 的仓库里跑 postinstall，
 * 而那时 `dist/` 还没构建 —— 若 postinstall 写成 `node dist/postinstall.js`，
 * 会以 `MODULE_NOT_FOUND` 退出非 0，**让整个 npm install 失败**。
 * （用户安装发布包时 dist 是随包发布的，不存在这个问题；本地开发才会撞上。）
 *
 * 本文件不放进 dist，而是作为根文件随包发布（见 package.json 的 `files`）。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, 'dist', 'postinstall.js');

try {
  if (!existsSync(target)) {
    console.log('[webaiapi] 跳过 postinstall（dist/ 尚未构建，本地开发时正常）');
  } else {
    await import(pathToFileURL(target).href);
  }
} catch (error) {
  // 任何异常都不该让 npm install 失败
  console.log(`[webaiapi] postinstall 异常（已忽略）：${String(error)}`);
  console.log('[webaiapi] 需要时手动运行: npx playwright install firefox');
}

process.exit(0);
