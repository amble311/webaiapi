import { describe, expect, it } from 'vitest';

import {
  PLATFORMS,
  PLATFORM_API_PATTERNS,
  PLATFORM_IDS,
  PLATFORM_LIST,
  PLATFORM_LOGIN_URLS,
  PLATFORM_NAMES,
  PLATFORMS_WITH_PROVIDER,
  extractAccountInfoSync,
  identityStrength,
  isKnownPlatform,
  parseDeepseekUserInfo,
  platformDisplayName,
} from '../../src/browser/platforms.js';
import {
  PLATFORM_MODEL_NAMES,
  PROVIDER_IMPLEMENTED_PLATFORMS,
} from '../../src/controllers/router.js';

/**
 * 平台注册表的**一致性**测试。
 *
 * 目的不是「测出某个平台的行为」，而是**挡住「加平台时漏改一处」**：
 * 漏改不会报错，只会让某个平台在菜单/日志里显示成原始 id、
 * 或者 `model=xxx` 报找不到模型 —— 这类问题只能靠测试提前发现。
 */

describe('注册表自洽性', () => {
  it('平台 id 唯一，且 PLATFORMS / PLATFORM_IDS 与 PLATFORM_LIST 一致', () => {
    const ids = PLATFORM_LIST.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PLATFORM_IDS).toEqual(ids);
    expect(Object.keys(PLATFORMS)).toEqual(ids);
  });

  it('每条都有 id / 显示名 / https 登录入口 / 身份提取函数', () => {
    for (const spec of PLATFORM_LIST) {
      expect(spec.id).toMatch(/^[a-z0-9-]+$/);
      expect(spec.displayName.trim()).not.toBe('');
      expect(spec.loginUrl).toMatch(/^https:\/\//);
      // 类型系统管不到「运行时是不是函数」（注册表可能被动态拼出来）
      expect(typeof spec.extractIdentity).toBe('function');
      expect(typeof spec.providerImplemented).toBe('boolean');
    }
  });

  it('平台 id 与显示名不相同（显示名要给人看）', () => {
    for (const spec of PLATFORM_LIST) {
      expect(spec.displayName).not.toBe(spec.id);
    }
  });

  it('⭐ providerImplemented=true 的平台**真的**有 Provider 工厂', () => {
    // PLATFORM_MODEL_NAMES 是从 providerImplemented 派生的，拿它比对是自说自话；
    // 必须对着 router 的工厂表比，才能挡住「注册表说能对话、实际没工厂」
    expect([...PLATFORMS_WITH_PROVIDER].sort()).toEqual(
      [...PROVIDER_IMPLEMENTED_PLATFORMS].sort(),
    );
    expect([...PLATFORM_MODEL_NAMES].sort()).toEqual([...PROVIDER_IMPLEMENTED_PLATFORMS].sort());
  });

  it('apiPattern 如果有，urlPattern 必须非空（否则请求匹配永远失败）', () => {
    for (const spec of PLATFORM_LIST) {
      if (!spec.apiPattern) continue;
      expect(spec.apiPattern.urlPattern.trim()).not.toBe('');
    }
  });
});

describe('向后兼容视图', () => {
  it('三张表都由 PLATFORM_LIST 派生', () => {
    for (const spec of PLATFORM_LIST) {
      expect(PLATFORM_LOGIN_URLS[spec.id]).toBe(spec.loginUrl);
      expect(PLATFORM_NAMES[spec.id]).toBe(spec.displayName);
    }
    expect(Object.keys(PLATFORM_NAMES)).toEqual(PLATFORM_IDS);
    expect(Object.keys(PLATFORM_LOGIN_URLS)).toEqual(PLATFORM_IDS);
  });

  it('PLATFORM_API_PATTERNS 只包含配了 apiPattern 的平台', () => {
    const expected = PLATFORM_LIST.filter((s) => s.apiPattern).map((s) => s.id);
    expect(Object.keys(PLATFORM_API_PATTERNS).sort()).toEqual([...expected].sort());
  });
});

describe('查询辅助', () => {
  it('platformDisplayName 取显示名，未登记平台原样返回 id', () => {
    expect(platformDisplayName('chatglm')).toBe(PLATFORMS['chatglm']?.displayName);
    expect(platformDisplayName('not-a-platform')).toBe('not-a-platform');
  });

  it('isKnownPlatform', () => {
    expect(isKnownPlatform('chatglm')).toBe(true);
    expect(isKnownPlatform('not-a-platform')).toBe(false);
  });
});

describe('extractAccountInfoSync 对未登记平台也安全', () => {
  it('⭐ 未登记平台走通用兜底（bearer 前缀），而不是抛异常', () => {
    // 将来新平台先接登录、后写身份提取时就会走到这里
    const info = extractAccountInfoSync('future-platform', {
      bearer: 'abcdefghijklmnopqrstuvwxyz',
      cookies: [],
    });
    expect(info['identifier']).toBe('abcdefghijklmnop');
    expect(info['label']).toBe('token:abcdefgh...');
  });

  it('连 bearer 都没有时 identifier=unknown', () => {
    const info = extractAccountInfoSync('future-platform', { cookies: [] });
    expect(info['identifier']).toBe('unknown');
    expect(info['label']).toBe('unknown');
  });
});

/**
 * 身份可靠度 —— 「算不算登录成功」「能不能落盘」都由它决定。
 *
 * ⚠️ 2026-10-16 实测事故（本组用例钉住）：
 * deepseek 的**游客**也会拿到 `ds_session_id` cookie，而 `extractDeepseek` 优先拿它当身份
 * → `identifier` 非空 → 旧判据判定「登录成功」→ 不仅自动收尾，还**多出一个账号文件**
 * （`session-<hash>.json`）。real 对比：真实账号的凭证里有 64 字符 bearer（5 个 cookie）。
 */
describe('identityStrength', () => {
  const cookie = (name: string, value: string): { name: string; value: string; domain: string; path: string } => ({
    name,
    value,
    domain: '.deepseek.com',
    path: '/',
  });

  it('⭐ deepseek 游客（只有 ds_session_id、没有 bearer）→ session（不算登录）', () => {
    const guest = {
      cookies: [cookie('ds_session_id', '9f694f1700cc4689bae6f020bf2d3428'), cookie('a', '1'), cookie('b', '2')],
    } as unknown as Parameters<typeof identityStrength>[1];
    expect(identityStrength('deepseek', guest)).toBe('session');
  });

  it('⭐ deepseek 真实账号（有 bearer）→ user', () => {
    const real = {
      bearer: 'x'.repeat(64),
      cookies: [cookie('ds_session_id', 'abc'), cookie('c', '1')],
    } as unknown as Parameters<typeof identityStrength>[1];
    expect(identityStrength('deepseek', real)).toBe('user');
  });

  it('chatglm 游客 JWT（is_guest=true）→ session；真实账号 JWT → user', () => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (payload: Record<string, unknown>): string =>
      `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;

    const guest = { bearer: jwt({ sub: '2d114a0b74564173af6b35e448298e2f', is_guest: true }) } as unknown as Parameters<typeof identityStrength>[1];
    const real = { bearer: jwt({ sub: '洛小北', uid: '6a683998b020eb21d4825166' }) } as unknown as Parameters<typeof identityStrength>[1];
    expect(identityStrength('chatglm', guest)).toBe('session');
    expect(identityStrength('chatglm', real)).toBe('user');
  });

  it('通用兜底：身份标签是 `session:<id>` → session（豆包/千问等 cookie 扫描）', () => {
    const scanned = {
      cookies: [cookie('doubao_session', 'c138f45d57d64976aa813e6f32ce67ec')],
    } as unknown as Parameters<typeof identityStrength>[1];
    expect(identityStrength('doubao', scanned)).toBe('session');
  });

  it('什么都没有 → unknown；未知平台有 bearer → token（允许但需用户核对）', () => {
    const empty = {} as unknown as Parameters<typeof identityStrength>[1];
    expect(identityStrength('deepseek', empty)).toBe('unknown');
    expect(identityStrength('unknown-platform', { bearer: 'abc123' } as unknown as Parameters<typeof identityStrength>[1])).toBe('token');
  });
});

/**
 * DeepSeek 账号身份（2026-10-16 用户反馈「登录成功了，但是没拿到用户名」）。
 *
 * 实测响应（用真实凭证打出来的）：
 * `{code:0,data:{biz_code:0,biz_data:{id:"c4aacdd2-…",email:"71*****23@qq.com",
 *   mobile_number:"136******18",id_profile:{provider,id,name:"徐崇夏",...}}}}`
 *
 * ⚠️ 关键：身份必须用 `biz_data.id`（**跨登录稳定**），不能用 `ds_session_id` cookie ——
 * 后者每次登录都换，会让「同一个人」被当成两个账号（去重、辅助通道、`/v1/status` 全看它）。
 */
describe('parseDeepseekUserInfo', () => {
  const REAL = {
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        id: 'c4aacdd2-414c-4d45-bd55-f19028d8627c',
        token: 'ySwV+flSof+S0q0Seyk3gh7xjgItJqTLaso+BlRV/kRN27fIwQHDl46us2DUpSD2',
        email: '71*****23@qq.com',
        mobile_number: '136******18',
        status: 0,
        id_profile: {
          provider: 'email',
          id: 'c4aacdd2-414c-4d45-bd55-f19028d8627c',
          name: '徐崇夏',
          picture: '',
          locale: 'zh_CN',
          email: '71*****23@qq.com',
        },
      },
    },
  };

  it('⭐ 真实响应：user id 当稳定身份、name 当标签', () => {
    const info = parseDeepseekUserInfo(REAL);
    expect(info['identifier']).toBe('c4aacdd2-414c-4d45-bd55-f19028d8627c');
    expect(info['user_id']).toBe('c4aacdd2-414c-4d45-bd55-f19028d8627c');
    expect(info['label']).toBe('徐崇夏');
    expect(info['name']).toBe('徐崇夏');
    expect(info['email']).toBe('71*****23@qq.com');
    expect(info['phone']).toBe('136******18');
  });

  it('没有 name → 标签退回 email / phone', () => {
    const noName = JSON.parse(JSON.stringify(REAL));
    delete noName.data.biz_data.id_profile.name;
    expect(parseDeepseekUserInfo(noName)['label']).toBe('71*****23@qq.com');

    const noNameNoEmail = JSON.parse(JSON.stringify(REAL));
    delete noNameNoEmail.data.biz_data.id_profile.name;
    delete noNameNoEmail.data.biz_data.email;
    expect(parseDeepseekUserInfo(noNameNoEmail)['label']).toBe('136******18');
  });

  it('形状不对 / 空值 → 空对象（永不抛）', () => {
    expect(parseDeepseekUserInfo(null)).toEqual({});
    expect(parseDeepseekUserInfo({})).toEqual({});
    expect(parseDeepseekUserInfo({ data: {} })).toEqual({});
    expect(parseDeepseekUserInfo({ data: { biz_data: {} } })).toEqual({});
    // 游客/未登录：code 非 0、biz_data 为 null
    expect(parseDeepseekUserInfo({ code: 40002, msg: 'Missing Token', data: null })).toEqual({});
  });
});

describe('extractAccountInfoSync(deepseek) 身份优先级', () => {
  const cookie = (name: string, value: string) => ({ name, value, domain: '.deepseek.com', path: '/' });

  it('⭐ 已落盘的 API 身份优先于 ds_session_id（session 每次都变）', () => {
    const auth = {
      bearer: 'x'.repeat(64),
      cookies: [cookie('ds_session_id', '048e20a34ff9')],
      account_info: {
        identifier: 'c4aacdd2-414c-4d45-bd55-f19028d8627c',
        user_id: 'c4aacdd2-414c-4d45-bd55-f19028d8627c',
        label: '徐崇夏',
        name: '徐崇夏',
      },
    } as unknown as Parameters<typeof extractAccountInfoSync>[1];

    const info = extractAccountInfoSync('deepseek', auth);
    expect(info['identifier']).toBe('c4aacdd2-414c-4d45-bd55-f19028d8627c');
    expect(info['label']).toBe('徐崇夏');
  });

  it('旧文件里落盘的就是 session:xxx（未采信）→ 退回 cookie 逻辑', () => {
    const auth = {
      cookies: [cookie('ds_session_id', '251bd0bf6bb8')],
      account_info: { identifier: 'session:251bd0bf6bb8', label: 'session:251bd0bf6bb8' },
    } as unknown as Parameters<typeof extractAccountInfoSync>[1];

    const info = extractAccountInfoSync('deepseek', auth);
    expect(info['label']).toBe('session:251bd0bf6bb8');
  });

  it('游客（无 bearer、无落盘身份）→ session: 标签（identityStrength 判为 session）', () => {
    const auth = { cookies: [cookie('ds_session_id', 'abc123456789')] } as unknown as Parameters<
      typeof extractAccountInfoSync
    >[1];
    const info = extractAccountInfoSync('deepseek', auth);
    expect(info['label']).toBe('session:abc123456789');
    expect(identityStrength('deepseek', auth)).toBe('session');
  });
});
