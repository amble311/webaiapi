import { describe, expect, it } from 'vitest';

import { sanitizeMessage, topLevelJsonFields } from '../../src/utils/text.js';

describe('topLevelJsonFields', () => {
  it('取顶层字段名（侦察平台请求体用）', () => {
    expect(topLevelJsonFields('{"prompt":"hi","conversation_id":"c1","is_networking":true}')).toEqual([
      'prompt',
      'conversation_id',
      'is_networking',
    ]);
  });

  it('非 JSON / 被截断 / 非对象 → 空数组，绝不抛异常', () => {
    expect(topLevelJsonFields('')).toEqual([]);
    expect(topLevelJsonFields(null)).toEqual([]);
    expect(topLevelJsonFields('{"prompt":"hi"')).toEqual([]); // 截断
    expect(topLevelJsonFields('[1,2]')).toEqual([]);
    expect(topLevelJsonFields('"plain"')).toEqual([]);
  });
});

describe('sanitizeMessage', () => {
  it('去空白 / 零宽字符 / 替换字符', () => {
    expect(sanitizeMessage('  a\u200bb\ufffdc  ')).toBe('abc');
    expect(sanitizeMessage(undefined)).toBe('');
  });
});
