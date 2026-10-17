/**
 * PID 文件（`webaiapi stop` 的基础）—— 2026-10-16 用户要求「增加子命令 stop 用于停止后台启动的服务」。
 *
 * ⚠️ 这里刻意只测**纯文件/进程原语**：不碰网络、不碰浏览器、不依赖真实服务。
 * 关键判据：陈旧 pid（进程已死）必须能被识别并清理，脏内容必须当「没有」。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isProcessAlive,
  removePidFileIfOwned,
  looksLikeOurService,
  pidFilePath,
  readPidFile,
  removePidFile,
  writePidFile,
} from '../../src/server/pidfile.js';

describe('pidfile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webaiapi-pid-'));
  const file = join(dir, 'test.pid');

  afterEach(() => {
    removePidFile(file);
  });

  it('写 → 读 → 删', () => {
    writePidFile(process.pid, file);
    expect(readPidFile(file)).toBe(process.pid);

    removePidFile(file);
    expect(readPidFile(file)).toBeNull();
    // 再删一次不报错（幂等）
    expect(() => removePidFile(file)).not.toThrow();
  });

  it('文件不存在 / 内容脏 → null（当成「没有 pid 文件」）', () => {
    expect(readPidFile(file)).toBeNull();

    for (const dirty of ['abc', '', '  ', '-1', '0', '12abc', '3.5']) {
      writeFileSync(file, dirty, 'utf8');
      expect(readPidFile(file)).toBeNull();
    }
  });

  it('⭐ 只删「自己的」pid 文件（避免多实例互删）', () => {
    writePidFile(4242, file);
    // 别人的 pid → 不删
    removePidFileIfOwned(process.pid, file);
    expect(readPidFile(file)).toBe(4242);
    // 自己的 pid → 删
    removePidFileIfOwned(4242, file);
    expect(readPidFile(file)).toBeNull();
  });

  it('isProcessAlive：自己活着；已退出的子进程为 false', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);

    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const childPid = child.pid;
    expect(typeof childPid).toBe('number');
    await once(child, 'exit');
    expect(isProcessAlive(childPid as number)).toBe(false);
  }, 15_000);

  it('looksLikeOurService：只认我们的服务命令行', () => {
    expect(looksLikeOurService('node /usr/lib/node_modules/webaiapi/dist/cli.js start')).toBe(true);
    expect(looksLikeOurService('node --import tsx src/cli.ts start')).toBe(true);
    expect(looksLikeOurService('/usr/bin/bash')).toBe(false);
    expect(looksLikeOurService('node /tmp/other-script.js')).toBe(false);
    expect(looksLikeOurService('')).toBe(false);
  });

  it('默认路径在 ~/.ai-api 下，且支持显式覆盖', () => {
    expect(pidFilePath()).toContain('.ai-api');
    expect(pidFilePath()).toContain('webaiapi.pid');
    expect(pidFilePath('/tmp/custom.pid')).toBe('/tmp/custom.pid');
  });
});
