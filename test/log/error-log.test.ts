/**
 * 异常记录（`logs/errors.log`）—— 2026-10-22 用户要求「增加报错系统，记录异常及现场信息」。
 *
 * 关键约束：**绝不写凭证**（bearer/cookie/token/… 一律 redacted），长文本截断，写日志不抛错。
 */
import { describe, expect, it } from 'vitest';

import {
  buildErrorRecord,
  describeError,
  sanitizeValue,
  resolveErrorsLogPath,
} from '../../src/log/error-log.js';

describe('sanitizeValue', () => {
  it('⭐ 凭证类字段一律 redacted（嵌套也要）', () => {
    const out = sanitizeValue({
      bearer: 'eyJhbGciOi…',
      cookie: 'ds_session_id=abc',
      auth: { token: 'secret-token', ok: 1 },
      list: [{ session: 'x' }, { password: 'y' }],
    }) as Record<string, unknown>;

    expect(out['bearer']).toBe('[redacted]');
    expect(out['cookie']).toBe('[redacted]');
    expect((out['auth'] as Record<string, unknown>)['token']).toBe('[redacted]');
    expect((out['auth'] as Record<string, unknown>)['ok']).toBe(1);
    expect((out['list'] as Array<Record<string, unknown>>)[0]?.['session']).toBe('[redacted]');
    expect((out['list'] as Array<Record<string, unknown>>)[1]?.['password']).toBe('[redacted]');
  });

  it('长字符串截断（提示词可能有几十万字符）', () => {
    const long = 'A'.repeat(2000);
    const out = sanitizeValue({ text: long }) as Record<string, unknown>;
    expect(String(out['text']).length).toBeLessThan(900);
    expect(String(out['text'])).toContain('截断');
  });

  it('数组/对象深度限制（防止巨型对象**）', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const out = JSON.stringify(sanitizeValue(deep));
    expect(out).toContain('深度过深已折叠');
  });

  it('基础类型原样返回', () => {
    expect(sanitizeValue(1)).toBe(1);
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(null)).toBe(null);
  });
});

describe('describeError / buildErrorRecord', () => {
  it('从 Error 里取 name/message/stack（stack 最多 20 行）', () => {
    const err = new Error('boom');
    const d = describeError(err);
    expect(d.name).toBe('Error');
    expect(d.message).toBe('boom');
    expect(d.stack.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('非 Error（字符串/对象）也能描述', () => {
    expect(describeError('单纯字符串').message).toBe('单纯字符串');
    expect(describeError({ a: 1 }).message).toContain('object');
  });

  it('⭐ 记录里带 id/时间/请求上下文，且现场信息已脱敏', () => {
    const record = buildErrorRecord(
      {
        requestId: 'chatcmpl-1',
        model: 'chatgpt',
        platform: 'chatgpt',
        accountId: 'acc1',
        phase: 'stream',
        extra: { url: 'https://chatgpt.com/', bearer: 'SECRET' },
      },
      new Error('没有抓到对话流'),
      { id: 'abcd1234', now: () => new Date('2026-10-22T00:00:00Z') },
    );

    expect(record['id']).toBe('abcd1234');
    expect(record['ts']).toBe('2026-10-22T00:00:00.000Z');
    expect(record['requestId']).toBe('chatcmpl-1');
    expect(record['phase']).toBe('stream');
    expect((record['extra'] as Record<string, unknown>)['bearer']).toBe('[redacted]');
    expect((record['extra'] as Record<string, unknown>)['url']).toBe('https://chatgpt.com/');
    expect((record['error'] as Record<string, unknown>)['message']).toBe('没有抓到对话流');
  });

  it('resolveErrorsLogPath：相对目录按项目根解析', () => {
    expect(resolveErrorsLogPath('/abs/logs')).toBe('/abs/logs/errors.log');
    expect(resolveErrorsLogPath('logs')).toMatch(/\/logs\/errors\.log$/);
  });
});
