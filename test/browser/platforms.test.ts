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
  isKnownPlatform,
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
