import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AuthRecord,
  type CapturedCookie,
  cookieFingerprint,
  decodeJwt,
  getCookieValue,
  isAuthAvailable,
  listAccounts,
  loadAuth,
  normalizeCookies,
} from '../../src/browser/credentials.js';
import { extractAccountInfoSync } from '../../src/browser/platforms.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-webapi-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAuth(platform: string, accountId: string, payload: unknown): void {
  const platformDir = join(dir, platform);
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, `${accountId}.json`), JSON.stringify(payload), 'utf8');
}

/** 构造一个「像真的」的 JWT（不验签，只要求 payload 可解）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

const SAMPLE_COOKIES: CapturedCookie[] = [
  { name: 'chatglm_user_id', value: 'u_123', domain: '.chatglm.cn', path: '/' },
  { name: 'other', value: 'x', domain: '.chatglm.cn', path: '/' },
];

describe('decodeJwt', () => {
  it('解出 payload（含 Bearer 前缀也能解）', () => {
    const token = makeJwt({ sub: '用户_bFa15b', uid: '699925cd' });
    expect(decodeJwt(token)).toMatchObject({ sub: '用户_bFa15b', uid: '699925cd' });
    expect(decodeJwt(`Bearer ${token}`)).toMatchObject({ sub: '用户_bFa15b' });
  });

  it('补齐 base64 padding（长度不是 4 的倍数也能解）', () => {
    // padding 由 decodeJwt 内部补，这里只要能被解出来即可
    const token = makeJwt({ uid: 'a' });
    expect(decodeJwt(token)['uid']).toBe('a');
  });

  it('非法输入返回空对象而不抛异常', () => {
    expect(decodeJwt('')).toEqual({});
    expect(decodeJwt('not-a-jwt')).toEqual({});
    expect(decodeJwt('a.b')).toEqual({});
    expect(decodeJwt('a.b.c')).toEqual({});
    expect(decodeJwt(null)).toEqual({});
    expect(decodeJwt(undefined)).toEqual({});
  });
});

describe('getCookieValue', () => {
  it('按名字取值；找不到返回 undefined', () => {
    expect(getCookieValue(SAMPLE_COOKIES, 'chatglm_user_id')).toBe('u_123');
    expect(getCookieValue(SAMPLE_COOKIES, 'nope')).toBeUndefined();
    expect(getCookieValue([], 'x')).toBeUndefined();
    expect(getCookieValue(undefined, 'x')).toBeUndefined();
  });
});

describe('extractAccountInfoSync', () => {
  it('chatglm：优先用 JWT 的 sub/uid', () => {
    const auth: AuthRecord = {
      bearer: makeJwt({ sub: '用户_bFa15b', uid: '699925cd' }),
      cookies: SAMPLE_COOKIES,
    };
    expect(extractAccountInfoSync('chatglm', auth)).toMatchObject({
      label: '用户_bFa15b',
      identifier: '699925cd',
      token_type: 'jwt',
    });
  });

  it('chatglm：JWT 解不出时退回 chatglm_user_id cookie', () => {
    const auth: AuthRecord = { bearer: 'not-a-jwt', cookies: SAMPLE_COOKIES };
    expect(extractAccountInfoSync('chatglm', auth)['identifier']).toBe('u_123');
  });

  it('deepseek：用 ds_session_id', () => {
    const auth: AuthRecord = {
      cookies: [{ name: 'ds_session_id', value: 'abcdef1234567890' }],
      bearer: 'randomish',
    };
    const info = extractAccountInfoSync('deepseek', auth);
    expect(info['identifier']).toBe('abcdef1234567890');
    expect(info['label']).toBe('session:abcdef123456');
  });

  it('deepseek：没有 session cookie 时用 bearer 前缀', () => {
    const auth: AuthRecord = { cookies: [{ name: 'x', value: 'y' }], bearer: 'abcdefghijklmnopq' };
    expect(extractAccountInfoSync('deepseek', auth)['identifier']).toBe('abcdefghijklmnop');
  });

  it('kimi：从 kimi-auth cookie 里的 JWT 取 ssid', () => {
    const auth: AuthRecord = {
      cookies: [{ name: 'kimi-auth', value: makeJwt({ ssid: 'ssid-1234567890xyz' }) }],
    };
    const info = extractAccountInfoSync('kimi', auth);
    expect(info['identifier']).toBe('ssid-1234567890xyz');
    // label 取 identifier 前 12 位
    expect(info['label']).toBe('ssid:ssid-1234567');
  });

  it('qianwen / doubao：从含 user/uid/session 的 cookie 里找', () => {
    const auth: AuthRecord = {
      cookies: [
        { name: 'UNRELATED', value: 'zzz' },
        { name: 'user_id', value: 'qwen_user_1' },
      ],
    };
    expect(extractAccountInfoSync('qianwen', auth)['identifier']).toBe('qwen_user_1');
    expect(extractAccountInfoSync('doubao', auth)['identifier']).toBe('qwen_user_1');
  });

  it('zhipu：JWT 用 id / email（非标准 sub）', () => {
    const auth: AuthRecord = {
      bearer: makeJwt({ id: 'z-1', email: 'me@example.com', name: '张三' }),
    };
    const info = extractAccountInfoSync('zhipu', auth);
    expect(info['identifier']).toBe('z-1');
    expect(info['label']).toBe('张三');
  });

  it('兜底：什么都提取不到时 identifier=unknown，label 取前 12 位', () => {
    const info = extractAccountInfoSync('unknown_platform', { cookies: [] });
    expect(info['identifier']).toBe('unknown');
    expect(info['label']).toBe('unknown');
  });

  it('⭐ 两份内容相同的凭证必然得到相同 identifier（多账号校验的依据）', () => {
    const a: AuthRecord = { bearer: makeJwt({ uid: 'same' }), cookies: SAMPLE_COOKIES };
    const b: AuthRecord = { bearer: makeJwt({ uid: 'same' }), cookies: SAMPLE_COOKIES };
    expect(extractAccountInfoSync('chatglm', a)['identifier']).toBe(
      extractAccountInfoSync('chatglm', b)['identifier'],
    );
  });
});

describe('loadAuth', () => {
  it('读出新格式凭证并注入 _account_id', () => {
    writeAuth('chatglm', 'acc2', { cookies: SAMPLE_COOKIES, bearer: 'tok' });
    const auth = loadAuth('chatglm', { accountId: 'acc2', authDir: dir });
    expect(auth?._account_id).toBe('acc2');
    expect(auth?.cookies).toHaveLength(2);
  });

  it('⭐ 没有 cookies 的凭证视为不可用（这个校验曾经丢失过，导致登录检查永远误报）', () => {
    writeAuth('chatglm', 'acc1', { cookies: [], bearer: 'tok' });
    expect(loadAuth('chatglm', { accountId: 'acc1', authDir: dir })).toBeNull();

    writeAuth('deepseek', 'acc1', { bearer: 'tok' });
    expect(loadAuth('deepseek', { accountId: 'acc1', authDir: dir })).toBeNull();
  });

  it('文件不存在返回 null', () => {
    expect(loadAuth('chatglm', { accountId: 'nope', authDir: dir })).toBeNull();
  });

  it('JSON 损坏返回 null 而不抛异常', () => {
    mkdirSync(join(dir, 'chatglm'), { recursive: true });
    writeFileSync(join(dir, 'chatglm', 'bad.json'), '{broken', 'utf8');
    expect(loadAuth('chatglm', { accountId: 'bad', authDir: dir })).toBeNull();
  });

  it('兼容旧格式单文件（仅 default 账号）', () => {
    writeFileSync(join(dir, 'chatglm.json'), JSON.stringify({ cookies: SAMPLE_COOKIES }), 'utf8');
    expect(loadAuth('chatglm', { accountId: 'default', authDir: dir })?._account_id).toBe('default');
    // 非 default 账号不走旧格式
    expect(loadAuth('chatglm', { accountId: 'acc2', authDir: dir })).toBeNull();
  });

  it('目录不存在时不抛异常', () => {
    expect(loadAuth('chatglm', { accountId: 'x', authDir: join(dir, 'nowhere') })).toBeNull();
  });
});

describe('listAccounts', () => {
  it('列出所有账号并排序', () => {
    writeAuth('chatglm', 'b2', { cookies: SAMPLE_COOKIES });
    writeAuth('chatglm', 'a1', { cookies: SAMPLE_COOKIES });
    expect(listAccounts('chatglm', dir)).toEqual(['a1', 'b2']);
  });

  it('⭐ 跳过捕获过程中的临时文件（崩溃残留不是真实账号）', () => {
    writeAuth('chatglm', 'real', { cookies: SAMPLE_COOKIES });
    writeAuth('chatglm', '__tmp__1234567890', { cookies: SAMPLE_COOKIES });
    writeAuth('chatglm', '__new__abc', { cookies: SAMPLE_COOKIES });
    expect(listAccounts('chatglm', dir)).toEqual(['real']);
  });

  it('忽略非 json 文件', () => {
    writeAuth('chatglm', 'real', { cookies: SAMPLE_COOKIES });
    writeFileSync(join(dir, 'chatglm', 'readme.txt'), 'x', 'utf8');
    expect(listAccounts('chatglm', dir)).toEqual(['real']);
  });

  it('没有账号目录时退回旧格式单文件 → [default]', () => {
    writeFileSync(join(dir, 'kimi.json'), '{}', 'utf8');
    expect(listAccounts('kimi', dir)).toEqual(['default']);
  });

  it('平台目录不存在返回空数组', () => {
    expect(listAccounts('nothing', dir)).toEqual([]);
  });
});

describe('isAuthAvailable', () => {
  it('反映 loadAuth 的结果', () => {
    writeAuth('chatglm', 'acc1', { cookies: SAMPLE_COOKIES });
    expect(isAuthAvailable('chatglm', { accountId: 'acc1', authDir: dir })).toBe(true);
    expect(isAuthAvailable('chatglm', { accountId: 'acc2', authDir: dir })).toBe(false);
  });
});

describe('cookieFingerprint', () => {
  it('⭐ 内容相同的两份凭证指纹相同（识别「复制凭证文件冒充第二个账号」）', () => {
    const a: CapturedCookie[] = [
      { name: 'b', value: '2' },
      { name: 'a', value: '1' },
    ];
    const b: CapturedCookie[] = [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ];
    expect(cookieFingerprint(a)).toBe(cookieFingerprint(b));
  });

  it('任何一个 cookie 的值不同 → 指纹不同', () => {
    const a: CapturedCookie[] = [{ name: 'token', value: 'AAA' }];
    const b: CapturedCookie[] = [{ name: 'token', value: 'BBB' }];
    expect(cookieFingerprint(a)).not.toBe(cookieFingerprint(b));
  });

  it('多一个 cookie 也会改变指纹', () => {
    const a: CapturedCookie[] = [{ name: 'token', value: 'AAA' }];
    const b: CapturedCookie[] = [
      { name: 'token', value: 'AAA' },
      { name: 'extra', value: 'x' },
    ];
    expect(cookieFingerprint(a)).not.toBe(cookieFingerprint(b));
  });

  it('空/undefined 安全', () => {
    expect(cookieFingerprint([])).toBe(cookieFingerprint(undefined));
    expect(cookieFingerprint([]).length).toBe(32);
  });
});

describe('normalizeCookies', () => {
  it('⭐ sameSite 归一化（no_restriction → None；unspecified 丢弃该字段）', () => {
    const out = normalizeCookies([
      { name: 'a', value: '1', sameSite: 'no_restriction' },
      { name: 'b', value: '2', sameSite: 'lax' },
      { name: 'c', value: '3', sameSite: 'STRICT' },
      { name: 'd', value: '4', sameSite: 'unspecified' },
    ]);
    expect(out[0]?.sameSite).toBe('None');
    expect(out[1]?.sameSite).toBe('Lax');
    expect(out[2]?.sameSite).toBe('Strict');
    expect('sameSite' in (out[3] as object)).toBe(false);
  });

  it('丢弃缺少 name/value 的项', () => {
    const out = normalizeCookies([
      { name: 'ok', value: 'v' },
      { value: 'no-name' } as unknown as CapturedCookie,
      { name: 'no-value' } as unknown as CapturedCookie,
      null as unknown as CapturedCookie,
    ]);
    expect(out).toEqual([{ name: 'ok', value: 'v' }]);
  });

  it('保留 domain/path/expires/httpOnly/secure', () => {
    const out = normalizeCookies([
      {
        name: 'a',
        value: '1',
        domain: '.chatglm.cn',
        path: '/',
        expires: 1893456000,
        httpOnly: true,
        secure: true,
      },
    ]);
    expect(out[0]).toEqual({
      name: 'a',
      value: '1',
      domain: '.chatglm.cn',
      path: '/',
      expires: 1893456000,
      httpOnly: true,
      secure: true,
    });
  });

  it('非数值的 expires 丢弃（Playwright 会校验类型）', () => {
    const out = normalizeCookies([
      { name: 'a', value: '1', expires: 'soon' as unknown as number },
    ]);
    expect('expires' in (out[0] as object)).toBe(false);
  });

  it('空输入返回空数组', () => {
    expect(normalizeCookies(undefined)).toEqual([]);
    expect(normalizeCookies([])).toEqual([]);
  });
});
