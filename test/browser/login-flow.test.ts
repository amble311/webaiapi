import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cookieFingerprint } from '../../src/browser/credentials.js';
import {
  type ExistingAccount,
  buildLoginActionChoices,
  deriveAccountId,
  detectDuplicate,
  readExistingAccounts,
  slugAccountId,
  toSlug,
} from '../../src/browser/login-flow.js';

/* ==================================================================== */
/* 账号名派生                                                           */
/* ==================================================================== */

describe('toSlug', () => {
  it('小写化，非法字符折成 -', () => {
    expect(toSlug('Alice Wang')).toBe('alice-wang');
    expect(toSlug('a@b.com')).toBe('a-b.com');
  });

  it('合并连续分隔符，去掉首尾分隔符', () => {
    expect(toSlug('--a  --  b--')).toBe('a-b');
    expect(toSlug('._a_.')).toBe('a');
  });

  it('⭐ 中文用户名洗不出东西 → 返回空串（而不是兜底成某个词）', () => {
    // 这个语义很关键：调用方要靠「空串」知道该换下一个候选（如 uid）
    expect(toSlug('张三')).toBe('');
    expect(toSlug('')).toBe('');
  });

  it('⭐ 路径穿越字符被吃掉（账号 ID 会被当文件名拼接）', () => {
    expect(toSlug('../../etc/passwd')).not.toContain('/');
    expect(toSlug('..\\..\\win')).not.toContain('\\');
    expect(toSlug('a/b')).toBe('a-b');
  });

  it('截断到 32 字符且不留下尾部分隔符', () => {
    const long = toSlug(`${'x'.repeat(40)} tail`);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).not.toMatch(/[-._]$/);
  });
});

describe('slugAccountId', () => {
  it('不与已有名冲突时原样返回', () => {
    expect(slugAccountId('alice', ['bob'])).toBe('alice');
  });

  it('⭐ 冲突时追加序号（否则会把已有账号的文件原地覆盖）', () => {
    expect(slugAccountId('alice', ['alice'])).toBe('alice-2');
    expect(slugAccountId('alice', ['alice', 'alice-2'])).toBe('alice-3');
  });

  it('洗不出东西时退化为 account（仍要保证唯一）', () => {
    expect(slugAccountId('张三')).toBe('account');
    expect(slugAccountId('张三', ['account'])).toBe('account-2');
  });

  it('⭐ 结果绝不是 . / .. （不能把文件写到父目录）', () => {
    expect(slugAccountId('.')).toBe('account');
    expect(slugAccountId('..')).toBe('account');
    expect(slugAccountId('...')).toBe('account');
  });
});

describe('deriveAccountId', () => {
  it('优先用身份标签（用户名）', () => {
    expect(deriveAccountId(['alice', '12345'], [])).toBe('alice');
  });

  it('⭐ 中文标签洗不出来时退到下一个候选（uid），而不是落到 account', () => {
    expect(deriveAccountId(['张三', '12345'], [])).toBe('12345');
  });

  it('全部候选都洗不出来才落到 account', () => {
    expect(deriveAccountId(['张三', undefined], [])).toBe('account');
  });

  it('派生结果同样要避开已有账号', () => {
    expect(deriveAccountId(['alice'], ['alice'])).toBe('alice-2');
  });
});

/* ==================================================================== */
/* 重复身份检测（这是「两个账号文件其实是同一个人」的防线）              */
/* ==================================================================== */

function account(over: Partial<ExistingAccount> = {}): ExistingAccount {
  return {
    id: 'acc1',
    identity: 'uid-1',
    label: 'Alice',
    fingerprint: 'fp-1',
    cookies: 10,
    capturedAt: 0,
    ...over,
  };
}

describe('detectDuplicate', () => {
  const captured = { identity: 'uid-2', label: 'Bob', fingerprint: 'fp-2', cookies: 8 };

  it('全都不一样 → fresh', () => {
    expect(detectDuplicate(captured, [account()])).toEqual({ kind: 'fresh' });
  });

  it('没有已有账号 → fresh', () => {
    expect(detectDuplicate(captured, [])).toEqual({ kind: 'fresh' });
  });

  it('⭐ Cookie 指纹一致 → same-session（比身份更硬）', () => {
    const verdict = detectDuplicate({ ...captured, fingerprint: 'fp-1' }, [account()]);
    expect(verdict).toEqual({ kind: 'same-session', accountId: 'acc1' });
  });

  it('⭐ 指纹一致时优先报 same-session，即使身份标识也变了', () => {
    // 平台改了身份提取逻辑（identity 从 uid 变成邮箱）时，这条能兜住
    const verdict = detectDuplicate(
      { ...captured, identity: 'someone@example.com', fingerprint: 'fp-1' },
      [account()],
    );
    expect(verdict.kind).toBe('same-session');
  });

  it('身份一致但指纹不同 → same-identity（同一个人重新登录）', () => {
    const verdict = detectDuplicate({ ...captured, identity: 'uid-1' }, [account()]);
    expect(verdict).toEqual({ kind: 'same-identity', accountId: 'acc1' });
  });

  it('⭐ identity=unknown 不算同一个人（兜底值会撞车）', () => {
    // 所有「提取失败」的平台都会得到 unknown，拿它比对会把毫不相干的两个账号
    // 判成同一个人 —— 反而制造出它本该防止的「并行打同一个账号」
    const verdict = detectDuplicate(
      { ...captured, identity: 'unknown' },
      [account({ identity: 'unknown' })],
    );
    expect(verdict).toEqual({ kind: 'fresh' });
  });

  it('⭐ 空 Cookie 列表的指纹不算匹配（空集指纹是个常量）', () => {
    const verdict = detectDuplicate(
      { ...captured, fingerprint: 'fp-1', cookies: 0 },
      [account()],
    );
    expect(verdict).toEqual({ kind: 'fresh' });
  });

  it('已有账号没有 cookie 时也不参与指纹比对', () => {
    const verdict = detectDuplicate({ ...captured, fingerprint: 'fp-1' }, [
      account({ cookies: 0 }),
    ]);
    expect(verdict).toEqual({ kind: 'fresh' });
  });

  it('多个已有账号时，命中哪个就报哪个', () => {
    const verdict = detectDuplicate({ ...captured, identity: 'uid-9' }, [
      account(),
      account({ id: 'acc2', identity: 'uid-9' }),
    ]);
    expect(verdict).toEqual({ kind: 'same-identity', accountId: 'acc2' });
  });
});

/* ==================================================================== */
/* 登录动作菜单的导航项                                                  */
/* ==================================================================== */

const SAMPLE_ACCOUNTS: ExistingAccount[] = [
  { id: 'alice', identity: 'u-1', label: 'Alice', fingerprint: 'f1', cookies: 3, capturedAt: 1 },
  { id: 'bob', identity: 'u-2', label: 'Bob', fingerprint: 'f2', cookies: 5, capturedAt: 2 },
];

describe('buildLoginActionChoices（返回 / 取消的可见性）', () => {
  it('第一项永远是「添加新账号」', () => {
    const choices = buildLoginActionChoices(SAMPLE_ACCOUNTS, { canGoBack: true });
    expect(choices[0]?.label).toContain('添加新账号');
  });

  it('已有账号逐个列出「重新登录」，并带身份与 cookie 数', () => {
    const choices = buildLoginActionChoices(SAMPLE_ACCOUNTS, { canGoBack: true });
    expect(choices[1]?.label).toBe('♻️  重新登录 alice');
    expect(choices[1]?.hint).toContain('Alice · 3 个 cookie');
    expect(choices[2]?.label).toBe('♻️  重新登录 bob');
  });

  it('⭐ canGoBack=true → 最后一项是「返回上一步」', () => {
    const choices = buildLoginActionChoices(SAMPLE_ACCOUNTS, { canGoBack: true });
    const last = choices[choices.length - 1];
    expect(last?.label).toContain('返回上一步');
  });

  it('⭐ canGoBack=false（平台来自命令行）→ 最后一项是「取消」，不是返回', () => {
    // 命令行明确指定了平台，没有「上一步」可回 —— 给「返回」会误导用户
    const choices = buildLoginActionChoices(SAMPLE_ACCOUNTS, { canGoBack: false });
    const last = choices[choices.length - 1];
    expect(last?.label).toBe('✗ 取消');
    expect(last?.label).not.toContain('返回');
  });

  it('⭐ 导航项的值是 symbol，**绝不可能**与真实账号 ID 撞车', () => {
    // 选项值里混着真实账号 ID；若导航项用 '__back__' 这类字符串，
    // 总有一天会有个账号叫这个名字，行为变得莫名其妙且不报错
    for (const canGoBack of [true, false]) {
      const choices = buildLoginActionChoices(SAMPLE_ACCOUNTS, { canGoBack });
      const last = choices[choices.length - 1];
      expect(typeof last?.value).toBe('symbol');
      for (const choice of choices.slice(0, -1)) {
        expect(typeof choice.value).toBe('string');
      }
    }
  });

  it('0 个账号时只有两项（添加新账号 + 导航），hint 提示首次登录', () => {
    const choices = buildLoginActionChoices([], { canGoBack: true });
    expect(choices).toHaveLength(2);
    expect(choices[0]?.hint).toContain('首次登录');
  });
});

/* ==================================================================== */
/* 磁盘读取（用临时 authDir，不碰真实 ~/.ai-api）                        */
/* ==================================================================== */

describe('readExistingAccounts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webapi-login-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAuth(accountId: string, cookies: Array<{ name: string; value: string }>): void {
    mkdirSync(join(dir, 'chatglm'), { recursive: true });
    writeFileSync(
      join(dir, 'chatglm', `${accountId}.json`),
      JSON.stringify({ cookies, captured_at: 123 }),
      'utf8',
    );
  }

  it('读出账号的身份与指纹', () => {
    writeAuth('alice', [{ name: 'chatglm_user_id', value: 'u-1' }]);
    const accounts = readExistingAccounts('chatglm', dir);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe('alice');
    expect(accounts[0]?.identity).toBe('u-1');
    expect(accounts[0]?.cookies).toBe(1);
    expect(accounts[0]?.capturedAt).toBe(123);
    expect(accounts[0]?.fingerprint).toBe(
      cookieFingerprint([{ name: 'chatglm_user_id', value: 'u-1' }]),
    );
  });

  it('⭐ 跳过没有 cookie / JSON 损坏的文件（它们不该参与「是不是同一个人」的判断）', () => {
    writeAuth('good', [{ name: 'a', value: '1' }]);
    writeAuth('nocookie', []);
    mkdirSync(join(dir, 'chatglm'), { recursive: true });
    writeFileSync(join(dir, 'chatglm', 'broken.json'), '{ not json', 'utf8');

    const accounts = readExistingAccounts('chatglm', dir);
    expect(accounts.map((a) => a.id)).toEqual(['good']);
  });

  it('目录不存在时返回空数组', () => {
    expect(readExistingAccounts('chatglm', join(dir, 'nope'))).toEqual([]);
  });
});
