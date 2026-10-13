import { beforeEach, describe, expect, it } from 'vitest';

import {
  accountCooldownRemaining,
  accountKey,
  clearAccountRole,
  enterAccount,
  exitAccount,
  getAccountRole,
  isAccountBusy,
  isAccountCooling,
  markAccountCooldown,
  resetAccountState,
  setAccountRole,
  transferAccountBusy,
} from '../../src/browser/manager.js';

beforeEach(() => {
  resetAccountState();
});

describe('accountKey', () => {
  it('约定 {platform}:{accountId}', () => {
    expect(accountKey('chatglm', 'acc2')).toBe('chatglm:acc2');
  });
});

describe('角色登记', () => {
  it('登记 / 查询 / 释放', () => {
    setAccountRole('chatglm', 'acc1', 'main');
    expect(getAccountRole('chatglm', 'acc1')).toBe('main');

    clearAccountRole('chatglm', 'acc1');
    expect(getAccountRole('chatglm', 'acc1')).toBeUndefined();
  });

  it('传 role 时只在匹配时释放', () => {
    setAccountRole('chatglm', 'acc1', 'main');
    clearAccountRole('chatglm', 'acc1', 'aux');
    expect(getAccountRole('chatglm', 'acc1')).toBe('main');

    clearAccountRole('chatglm', 'acc1', 'main');
    expect(getAccountRole('chatglm', 'acc1')).toBeUndefined();
  });

  it('平台/账号/角色任一为空时不登记', () => {
    setAccountRole('', 'acc1', 'main');
    setAccountRole('chatglm', '', 'main');
    setAccountRole('chatglm', 'acc1', '');
    expect(getAccountRole('chatglm', 'acc1')).toBeUndefined();
  });
});

describe('busy 重入计数', () => {
  it('enter / exit 成对', () => {
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
    enterAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(true);
    exitAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
  });

  it('是重入计数：嵌套两次要退出两次', () => {
    enterAccount('chatglm', 'acc1');
    enterAccount('chatglm', 'acc1');
    exitAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(true);
    exitAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
  });

  it('多余的 exit 不会把计数弄成负数', () => {
    exitAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
    enterAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(true);
  });

  it('不同账号互不影响', () => {
    enterAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc2')).toBe(false);
  });
});

describe('⚠️ transferAccountBusy（换号必须转移，否则旧账号 busy 永不归零）', () => {
  it('旧账号释放、新账号占用', () => {
    enterAccount('chatglm', 'acc1');
    transferAccountBusy('chatglm', 'acc1', 'acc2');

    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
    expect(isAccountBusy('chatglm', 'acc2')).toBe(true);
  });

  it('转移后旧账号的 finally exit 不会影响新账号', () => {
    enterAccount('chatglm', 'acc1');
    transferAccountBusy('chatglm', 'acc1', 'acc2');

    // chatStream 的 finally 只会 exit 当前账号（换号后已是 acc2）
    exitAccount('chatglm', 'acc2');
    expect(isAccountBusy('chatglm', 'acc2')).toBe(false);
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
  });

  it('同号转移是空操作（不能多记一次 busy）', () => {
    enterAccount('chatglm', 'acc1');
    transferAccountBusy('chatglm', 'acc1', 'acc1');

    expect(isAccountBusy('chatglm', 'acc1')).toBe(true);
    exitAccount('chatglm', 'acc1');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(false);
  });

  it('空账号参数不动作', () => {
    enterAccount('chatglm', 'acc1');
    transferAccountBusy('chatglm', '', 'acc2');
    transferAccountBusy('chatglm', 'acc1', '');
    expect(isAccountBusy('chatglm', 'acc1')).toBe(true);
    expect(isAccountBusy('chatglm', 'acc2')).toBe(false);
  });
});

describe('冷却', () => {
  it('标记后进入冷却，到期自动解除', () => {
    let now = 1_000_000;
    markAccountCooldown('chatglm', 'acc1', 120, () => now);

    expect(isAccountCooling('chatglm', 'acc1', () => now)).toBe(true);
    expect(accountCooldownRemaining('chatglm', 'acc1', () => now)).toBeCloseTo(120, 3);

    now += 60_000;
    expect(accountCooldownRemaining('chatglm', 'acc1', () => now)).toBeCloseTo(60, 3);

    now += 60_001;
    expect(isAccountCooling('chatglm', 'acc1', () => now)).toBe(false);
    expect(accountCooldownRemaining('chatglm', 'acc1', () => now)).toBe(0);
  });

  it('负秒数按 0 处理（立即过期）', () => {
    const now = 1_000_000;
    markAccountCooldown('chatglm', 'acc1', -10, () => now);
    expect(isAccountCooling('chatglm', 'acc1', () => now)).toBe(false);
  });

  it('未标记过返回 0', () => {
    expect(accountCooldownRemaining('chatglm', 'never', () => Date.now())).toBe(0);
  });

  it('不同账号的冷却互不影响', () => {
    const now = 1_000_000;
    markAccountCooldown('chatglm', 'acc1', 120, () => now);
    expect(isAccountCooling('chatglm', 'acc2', () => now)).toBe(false);
  });
});
