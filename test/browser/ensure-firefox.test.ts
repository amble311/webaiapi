import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ensureFirefox,
  playwrightCliPath,
  skipBrowserInstallReason,
} from '../../src/browser/ensure-firefox.js';

/**
 * 浏览器二进制的「运行时自动补装」。
 *
 * 背景（2026-10-15）：`postinstall` 会自动下载 Firefox，但 **npm 11+ 默认拦截
 * 生命周期脚本** → 用户装完仍然撞「Executable doesn't exist」。所以
 * `webapi start` / `login` / `doctor` 都要在真用浏览器之前再补一次。
 */
describe('skipBrowserInstallReason', () => {
  it('两个开关都认（本包逃生口 + Playwright 约定）', () => {
    expect(skipBrowserInstallReason({ WEBAIAPI_SKIP_BROWSER_INSTALL: '1' })).toContain(
      'WEBAIAPI_SKIP_BROWSER_INSTALL',
    );
    expect(skipBrowserInstallReason({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' })).toContain(
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
    );
  });

  it('没设开关 → null（默认就要自动装）', () => {
    expect(skipBrowserInstallReason({})).toBeNull();
  });
});

describe('ensureFirefox', () => {
  it('⭐ 已就绪 → 不做任何安装（快路径）', () => {
    const logs: string[] = [];
    let installCalls = 0;

    const r = ensureFirefox({
      isInstalled: () => true,
      runInstall: () => {
        installCalls += 1;
        return { ok: true };
      },
      log: (m) => logs.push(m),
    });

    expect(r).toEqual({ installed: true, attempted: false });
    expect(installCalls).toBe(0);
    expect(logs).toEqual([]);
  });

  it('⭐ 缺失 → 自动下载并复检成功', () => {
    const logs: string[] = [];
    let installed = false;
    let installCalls = 0;

    const r = ensureFirefox({
      isInstalled: () => installed,
      runInstall: () => {
        installCalls += 1;
        installed = true; // 模拟下载完成
        return { ok: true };
      },
      log: (m) => logs.push(m),
    });

    expect(r).toEqual({ installed: true, attempted: true });
    expect(installCalls).toBe(1);
    expect(logs.join('\n')).toContain('正在自动下载');
    expect(logs.join('\n')).toContain('已就绪');
  });

  it('⚠️ 下载失败 → 只警告 + 给手动兜底命令，绝不抛', () => {
    const logs: string[] = [];

    const r = ensureFirefox({
      isInstalled: () => false,
      runInstall: () => ({ ok: false, error: 'ENOTFOUND registry' }),
      log: (m) => logs.push(m),
    });

    expect(r.installed).toBe(false);
    expect(r.attempted).toBe(true);
    expect(r.error).toBe('ENOTFOUND registry');
    expect(logs.join('\n')).toContain('自动下载 Firefox 失败');
    expect(logs.join('\n')).toContain('npx playwright install firefox');
  });

  it('⚠️ 安装命令成功但二进制仍不可用 → 也算失败（不谎报就绪）', () => {
    const r = ensureFirefox({
      isInstalled: () => false,
      runInstall: () => ({ ok: true }),
      log: () => {},
    });

    expect(r.installed).toBe(false);
    expect(r.attempted).toBe(true);
    expect(r.error).toContain('二进制仍不可用');
  });

  it('检测函数自己抛异常 → 当作未就绪继续安装，不崩', () => {
    let calls = 0;
    const r = ensureFirefox({
      isInstalled: () => {
        calls += 1;
        throw new Error('boom');
      },
      runInstall: () => ({ ok: true }),
      log: () => {},
    });

    expect(calls).toBeGreaterThan(0);
    expect(r.installed).toBe(false);
    expect(r.attempted).toBe(true);
  });

  it('安装执行器抛异常 → 被捕获并计入 error', () => {
    const r = ensureFirefox({
      isInstalled: () => false,
      runInstall: () => {
        throw new Error('spawn failed');
      },
      log: () => {},
    });

    expect(r.installed).toBe(false);
    expect(r.error).toContain('spawn failed');
  });

  it('显式 skip / 环境开关 → 不尝试安装，并打印手动命令', () => {
    const logs: string[] = [];
    const install = () => {
      throw new Error('不该被调用');
    };

    const byOption = ensureFirefox({ isInstalled: () => false, runInstall: install, skip: true, log: (m) => logs.push(m) });
    expect(byOption.attempted).toBe(false);
    expect(byOption.skippedReason).toBe('显式跳过');

    const byEnv = ensureFirefox({
      isInstalled: () => false,
      runInstall: install,
      env: { WEBAIAPI_SKIP_BROWSER_INSTALL: '1' },
      log: (m) => logs.push(m),
    });
    expect(byEnv.attempted).toBe(false);
    expect(byEnv.skippedReason).toContain('WEBAIAPI_SKIP_BROWSER_INSTALL');

    expect(logs.join('\n')).toContain('npx playwright install firefox');
  });
});

describe('playwrightCliPath（真实环境冒烟）', () => {
  it('能解析到包内 CLI 的绝对路径（不能用 require.resolve("playwright/cli.js")）', () => {
    const cli = playwrightCliPath();
    expect(cli).toBeTruthy();
    expect(cli?.endsWith('cli.js')).toBe(true);
    expect(existsSync(cli as string)).toBe(true);
  });
});
