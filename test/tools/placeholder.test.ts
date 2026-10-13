import { describe, expect, it } from 'vitest';

import {
  filterPlaceholderToolCalls,
  isPlaceholderToolCall,
} from '../../src/tools/placeholder.js';
import type { ToolCallPayload } from '../../src/types/message.js';

function call(name: string, args: Record<string, unknown> | string): ToolCallPayload {
  return {
    id: 'call_x',
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

describe('isPlaceholderToolCall — 工具名判定', () => {
  it('示例工具名（AI 照抄提示词格式）判定为占位符', () => {
    expect(isPlaceholderToolCall(call('工具名称', {}))).toBe(true);
    expect(isPlaceholderToolCall(call('工具名', {}))).toBe(true);
    expect(isPlaceholderToolCall(call('tool_name', {}))).toBe(true);
    expect(isPlaceholderToolCall(call('your_tool', {}))).toBe(true);
  });

  it('含未填充尖括号的工具名判定为占位符', () => {
    expect(isPlaceholderToolCall(call('<工具名>', {}))).toBe(true);
    expect(isPlaceholderToolCall(call('<tool_name>', {}))).toBe(true);
  });

  it('真实工具名不判定', () => {
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: '/a.txt', content: 'x' }))).toBe(
      false,
    );
  });
});

describe('isPlaceholderToolCall — 参数判定', () => {
  it('纯尖括号模板判定为占位符', () => {
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: '<file_path>' }))).toBe(true);
    expect(
      isPlaceholderToolCall(call('write_to_file', { file_path: '<此处填写真实文件路径>' })),
    ).toBe(true);
  });

  it('路径类字段的整值等于示例词 → 占位符', () => {
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: '真实文件路径' }))).toBe(true);
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: 'your_file_path' }))).toBe(true);
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: 'path/to/file' }))).toBe(true);
    expect(
      isPlaceholderToolCall(call('write_to_file', { file_path: 'example.com/path' })),
    ).toBe(true);
  });

  it('⚠️ 绝不做子串包含判断：真实内容里出现「新代码」「文件内容」不能误杀', () => {
    const tc = call('write_to_file', {
      file_path: '/home/amble/object/webapi/src/a.ts',
      // 真实内容里含这些词完全正常
      content: '// 下面写入新代码\nconst 文件内容 = 1;\n',
    });
    expect(isPlaceholderToolCall(tc)).toBe(false);
  });

  it('非路径类字段即使值是示例词也不判定（只查路径类字段）', () => {
    expect(
      isPlaceholderToolCall(call('write_to_file', { file_path: '/a.txt', content: '新代码' })),
    ).toBe(false);
  });

  it('arguments 无法解析时不判定（宁可放过）', () => {
    expect(isPlaceholderToolCall(call('write_to_file', '{broken json'))).toBe(false);
  });

  it('非字符串参数值不参与判定', () => {
    expect(isPlaceholderToolCall(call('write_to_file', { file_path: 123 }))).toBe(false);
  });
});

describe('filterPlaceholderToolCalls', () => {
  it('把占位符与真实调用分开', () => {
    const real = call('write_to_file', { file_path: '/a.txt', content: 'x' });
    const fake = call('工具名称', { 参数1: '值1' });

    const { valid, dropped } = filterPlaceholderToolCalls([real, fake]);
    expect(valid).toEqual([real]);
    expect(dropped).toEqual([fake]);
  });

  it('空输入安全', () => {
    expect(filterPlaceholderToolCalls([])).toEqual({ valid: [], dropped: [] });
    expect(filterPlaceholderToolCalls(null)).toEqual({ valid: [], dropped: [] });
  });

  it('被丢弃的调用不修改原数组', () => {
    const calls = [call('工具名称', {})];
    const { dropped } = filterPlaceholderToolCalls(calls);
    expect(dropped).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
