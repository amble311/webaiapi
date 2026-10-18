/**
 * 「进展 / 重复」判断（替代 24 轮硬上限，2026-10-18 用户要求）。
 *
 * 目标：**庞大项目的正常探索不被拦**，只拦「原地重复读取」。
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeRequest,
  assessCalls,
  callFingerprint,
  callTarget,
  emptyHistory,
  hasWriteCall,
  stableJson,
  REPEAT_TARGET_READ_LIMIT,
  type CallLike,
} from '../../src/routes/progress.js';

const call = (name: string, args: Record<string, unknown>): CallLike => ({
  function: { name, arguments: JSON.stringify(args) },
});

const msgRound = (calls: CallLike[]): { role: string; tool_calls: CallLike[] } => ({
  role: 'assistant',
  tool_calls: calls,
});

describe('stableJson / callFingerprint', () => {
  it('⭐ 键顺序不同算同一个调用（JSON.stringify 不排序，会漏判重复）', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    const a = call('read_file', { filePath: '/x', limit: 20 });
    const b: CallLike = { function: { name: 'read_file', arguments: '{"limit":20,"filePath":"/x"}' } };
    expect(callFingerprint(a)).toBe(callFingerprint(b));
  });

  it('参数不同 → 指纹不同', () => {
    expect(callFingerprint(call('read_file', { filePath: '/x' }))).not.toBe(
      callFingerprint(call('read_file', { filePath: '/y' })),
    );
  });

  it('callTarget 认 filePath / path / target_directory / pattern', () => {
    expect(callTarget(call('read_file', { filePath: '/a' }))).toBe('/a');
    expect(callTarget(call('read_file', { path: '/b' }))).toBe('/b');
    expect(callTarget(call('list_dir', { target_directory: '/c' }))).toBe('/c');
    expect(callTarget(call('search_content', { pattern: 'foo' }))).toBe('foo');
    expect(callTarget(call('bash', { command: 'ls' }))).toBeNull();
  });
});

describe('assessCalls', () => {
  it('⭐ 首轮都放行，且算「有进展」', () => {
    const out = assessCalls([call('read_file', { filePath: '/a' })], emptyHistory());
    expect(out.keep).toHaveLength(1);
    expect(out.suppressed).toHaveLength(0);
    expect(out.isProgress).toBe(true);
  });

  it('⭐ 同一调用第二次 → 抑制（并给出原因）', () => {
    const history = emptyHistory();
    history.fingerprints.set(callFingerprint(call('read_file', { filePath: '/a' })), 1);
    const out = assessCalls([call('read_file', { filePath: '/a' })], history);
    expect(out.keep).toHaveLength(0);
    expect(out.suppressed[0]?.reason).toContain('已执行过');
  });

  it(`⭐ 同一目标读第 ${REPEAT_TARGET_READ_LIMIT + 1} 次（换 limit 也算）→ 抑制`, () => {
    const history = emptyHistory();
    history.targetReads.set('/a', REPEAT_TARGET_READ_LIMIT);
    const out = assessCalls([call('read_file', { filePath: '/a', limit: 999 })], history);
    expect(out.keep).toHaveLength(0);
    expect(out.suppressed[0]?.reason).toContain('/a');
  });

  it('⭐ 目标**被改过**后允许重读（验证修改）', () => {
    const history = emptyHistory();
    history.targetReads.set('/a', REPEAT_TARGET_READ_LIMIT);
    history.writtenTargets.add('/a');
    const out = assessCalls([call('read_file', { filePath: '/a', limit: 999 })], history);
    expect(out.keep).toHaveLength(1);
  });

  it('写操作不受「目标读太多次」影响（改多少次都不按读算）', () => {
    const history = emptyHistory();
    history.targetReads.set('/a', 99);
    const out = assessCalls([call('replace_in_file', { path: '/a', search: 'x', replace: 'y' })], history);
    expect(out.keep).toHaveLength(1);
    expect(out.isProgress).toBe(true);
  });

  it('读到**新目标**才算进展；只有重复 → 不算', () => {
    const history = emptyHistory();
    history.targetReads.set('/a', 1);

    const fresh = assessCalls([call('read_file', { filePath: '/new' })], history);
    expect(fresh.isProgress).toBe(true);

    const dup = assessCalls([call('read_file', { filePath: '/a' })], history);
    expect(dup.keep).toHaveLength(1); // 只是重复一次，还没到目标级上限
    expect(dup.isProgress).toBe(false); // 但不是新目标
  });
});

describe('analyzeRequest（僵局检测）', () => {
  const readA = call('read_file', { filePath: '/a' });

  it('⭐ 连续 3 轮完全重复 → stallStreak = 3（这才是该截停的时候）', () => {
    const messages = [
      { role: 'user' },
      msgRound([readA]),
      msgRound([readA]),
      msgRound([readA]),
      msgRound([readA]),
    ];
    // fromIdx = 0（最后一条 user 在第 0 位）→ 之后 4 轮；第一轮算「新」，后 3 轮是重复
    const history = analyzeRequest(messages, 0);
    expect(history.rounds).toBe(4);
    expect(history.stallStreak).toBe(3);
  });

  it('⭐ 每轮都读**新文件**（大项目正常探索）→ stallStreak 一直是 0', () => {
    const messages = [
      { role: 'user' },
      ...['/a', '/b', '/c', '/d', '/e'].map((p) => msgRound([call('read_file', { filePath: p })])),
    ];
    const history = analyzeRequest(messages, 0);
    expect(history.rounds).toBe(5);
    expect(history.stallStreak).toBe(0);
  });

  it('中间有写操作 → 不累计僵局', () => {
    const messages = [
      { role: 'user' },
      msgRound([readA]),
      msgRound([readA]),
      msgRound([call('replace_in_file', { path: '/a', search: 'x', replace: 'y' })]),
      msgRound([readA]),
    ];
    const history = analyzeRequest(messages, 0);
    expect(history.stallStreak).toBeLessThan(3);
  });

  it('只统计「最后一条 user 消息之后」（用户回「继续」= 重新计数）', () => {
    const messages = [
      { role: 'user' },
      msgRound([readA]),
      msgRound([readA]),
      msgRound([readA]),
      { role: 'user' }, // ← 用户说「继续」
      msgRound([readA]),
    ];
    const history = analyzeRequest(messages, 4);
    expect(history.rounds).toBe(1);
    expect(history.stallStreak).toBe(0);
  });

  it('hasWriteCall：非只读工具即算写（bash / replace_in_file）', () => {
    expect(hasWriteCall([call('replace_in_file', { path: '/a' })])).toBe(true);
    expect(hasWriteCall([call('bash', { command: 'ls' })])).toBe(true);
    expect(hasWriteCall([call('read_file', { filePath: '/a' })])).toBe(false);
  });
});
