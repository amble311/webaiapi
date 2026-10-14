import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthCapture } from '../../src/browser/auth-capture.js';

/**
 * 只测 `AuthCapture` 的**落盘那一半**（`saveAs` / 文件名校验）。
 *
 * 构造函数不会启动浏览器（只在 `capture()` 里才启动），所以可以安全实例化
 * —— 真正需要联网 + 人工登录的 `capture()` 不在这里测。
 */

describe('AuthCapture.saveAs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webapi-capture-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeCapture(accountId = '__pending__'): AuthCapture {
    return new AuthCapture('chatglm', { authDir: dir, accountId, saveOnCapture: false });
  }

  it('把凭证写到 {authDir}/{platform}/{account}.json', () => {
    const capture = makeCapture();
    const file = capture.saveAs('alice');

    expect(file).toBe(join(dir, 'chatglm', 'alice.json'));
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    expect(capture.accountId).toBe('alice');
  });

  it('⚠️ 路径穿越与非法字符被拒绝', () => {
    const capture = makeCapture();
    expect(() => capture.saveAs('../evil')).toThrow(/非法账号 ID/);
    expect(() => capture.saveAs('a/b')).toThrow(/非法账号 ID/);
    expect(() => capture.saveAs('a\\b')).toThrow(/非法账号 ID/);
    expect(() => capture.saveAs('')).toThrow(/非法账号 ID/);
    expect(() => capture.saveAs('.')).toThrow(/非法账号 ID/);
    expect(() => capture.saveAs('..')).toThrow(/非法账号 ID/);
  });

  it('⭐ 允许更新**已存在**的非 ASCII 账号名（历史遗留不能变成删号重登）', () => {
    // 真实凭证目录里就出现过 `用户_bFa15b`（早期手工登录留下的）。
    // 严格字符集会把「重新登录这个账号」直接判成非法。
    mkdirSync(join(dir, 'chatglm'), { recursive: true });
    const existing = join(dir, 'chatglm', '用户_x.json');
    writeFileSync(existing, '{"cookies":[]}', 'utf8');

    const capture = makeCapture('用户_x');
    expect(() => capture.saveAs('用户_x')).not.toThrow();
  });

  it('⚠️ 但**不存在**的非 ASCII 名字仍然被拒绝', () => {
    const capture = makeCapture();
    expect(() => capture.saveAs('用户_y')).toThrow(/非法账号 ID/);
  });

  it('覆盖已有账号时留一份 .bak', () => {
    const first = makeCapture();
    first.saveAs('bob');

    const second = makeCapture();
    second.saveAs('bob');

    expect(existsSync(join(dir, 'chatglm', 'bob.json.bak'))).toBe(true);
  });
});
