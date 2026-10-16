#!/usr/bin/env node
/**
 * `webaiapi` 的可执行入口（`bin` 指向这里）。
 *
 * ## 为什么不让 `bin` 直接指向 `dist/cli.js`
 * `dist/` 是**构建产物且被 .gitignore 忽略**。全新 clone 之后、或通过
 * `npm i github:<user>/<repo>` 安装时，`dist/` 可能根本不存在。此时若 bin 直接
 * 指向它，用户看到的是 shell 的原始报错：
 *
 * ```
 * /bin/bash: 行 1: /usr/local/bin/webaiapi: 没有那个文件或目录
 * ```
 *
 * —— 既没说"没构建"，也没说该怎么办。（实测确认过。）
 *
 * 所以这里放一个**提交进版本库**的薄入口：它永远存在，`dist/` 缺失时给出
 * 可执行的提示。`bin/` 也是大家约定俗成会去找入口的位置。
 *
 * ## ⚠️ 为什么要显式调用 `runCli()`，而不是只 import
 * `dist/cli.js` 里有一个「是否被直接执行」的守卫（比较 `process.argv[1]` 与
 * `import.meta.url` 的 realpath）。经本文件 import 时，`argv[1]` 是
 * `.../bin/webaiapi.mjs` 而 `import.meta.url` 是 `.../dist/cli.js` —— **两者不等**，
 * 守卫会判定"不是直接执行"从而**什么都不做**（静默失效，最难查的一类 bug）。
 * 因此这里必须显式调用导出的 `runCli()`。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');

if (!existsSync(cliPath)) {
  console.error(
    '[webaiapi] 还没有构建，找不到 dist/cli.js。\n' +
      '       请先运行：  npm run build\n' +
      '       （若你是 clone 下来做开发的：npm install 会自动构建，\n' +
      '        该步骤由 package.json 的 `prepare` 脚本触发。）',
  );
  process.exit(1);
}

// 显式调用，不依赖 cli.js 内部的「直接执行」守卫（原因见文件头注释）
const { runCli } = await import(pathToFileURL(cliPath).href);
process.exitCode = await runCli();
