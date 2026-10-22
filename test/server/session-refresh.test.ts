/**
 * 会话保鲜的平台状态（2026-10-22 用户要求）。
 *
 * 语义：
 * 1. **启动时立刻跑一次**，之后每个平台各自 24h（不是全局 24h 闹钟）；
 * 2. **外部请求打到某平台** → 立即中止该平台正在进行的保鲜，并**重置它的 24h 计时**
 *    （刚被真实使用过，会话是热的；马上再刷会互相顶会话 ✗）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  isPlatformAborted,
  isPlatformRefreshDue,
  notifyPlatformUsed,
  resetRefreshState,
  SESSION_REFRESH_INTERVAL_MS,
  SESSION_REFRESH_INITIAL_DELAY_MS,
} from '../../src/server/session-refresh.js';

describe('会话保鲜：平台级状态', () => {
  beforeEach(() => {
    resetRefreshState();
  });

  it('⭐ 从未刷过 → 到点（启动首轮会刷它）', () => {
    expect(isPlatformRefreshDue('chatgpt', SESSION_REFRESH_INTERVAL_MS)).toBe(true);
  });

  it('⭐ 刚被外部请求用过 → 不再到点（24h 计时被重置）', () => {
    notifyPlatformUsed('chatgpt');
    expect(isPlatformRefreshDue('chatgpt', SESSION_REFRESH_INTERVAL_MS)).toBe(false);
  });

  it('⭐ 外部请求会让「正在进行的保鲜」被判定为应中止', () => {
    const batchStartedAt = Date.now() - 1000;
    // 批次开始之后收到外部请求 → 中止
    notifyPlatformUsed('deepseek');
    expect(isPlatformAborted('deepseek', batchStartedAt)).toBe(true);

    // 请求发生在批次开始**之前** → 不算（那是上一轮的请求）
    expect(isPlatformAborted('deepseek', Date.now() + 1000)).toBe(false);
  });

  it('不同平台互不影响（chatgpt 被用不影响 deepseek 的计时）', () => {
    notifyPlatformUsed('chatgpt');
    expect(isPlatformRefreshDue('chatgpt', SESSION_REFRESH_INTERVAL_MS)).toBe(false);
    expect(isPlatformRefreshDue('deepseek', SESSION_REFRESH_INTERVAL_MS)).toBe(true);
  });

  it('启动延迟很短（用户要求「刚启动就自动跑一次」）', () => {
    expect(SESSION_REFRESH_INITIAL_DELAY_MS).toBeLessThanOrEqual(5_000);
    expect(SESSION_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
