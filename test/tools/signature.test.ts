import { describe, expect, it } from 'vitest';

import type { ToolDefinition, ToolCallPayload } from '../../src/types/message.js';
import { repairToolCallBySignature } from '../../src/tools/names.js';

/**
 * 「按参数签名纠正选错的工具」。
 *
 * 背景：模型想创建文件却调 `edit_file` 并套用 `write_file` 的签名
 * （`edit_file(path, content)`）—— 客户端按签名校验直接拒收
 * 「收到未知参数 content」，白烧一轮工具往返。
 */

function tool(
  name: string,
  props: Record<string, boolean>, // key → 是否必填
  description = '',
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.keys(props).map((k) => [k, { type: 'string' }])),
        required: Object.entries(props)
          .filter(([, required]) => required)
          .map(([k]) => k),
      },
    },
  } as unknown as ToolDefinition;
}

function call(name: string, args: Record<string, unknown>): ToolCallPayload {
  return { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function argsOf(tc: ToolCallPayload): Record<string, unknown> {
  return JSON.parse(tc.function.arguments) as Record<string, unknown>;
}

/** xzh/CodeBuddy 一类的典型文件工具集。 */
const FILE_TOOLS = [
  tool('write_file', { path: true, content: true }, '创建/覆盖文件'),
  tool('edit_file', { path: true, search: true, replace: true, replace_all: false }, '搜索替换修改文件'),
  tool('read_file', { path: true }, '读取文件'),
  tool('list_dir', { dir_path: true }, '列出目录'),
];

describe('repairToolCallBySignature', () => {
  it('⭐ 真实案例：edit_file(path, content) → write_file（签名完全匹配的唯一候选）', () => {
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('edit_file', { path: '/tmp/a.md', content: '# 评审结论' })],
      FILE_TOOLS,
    );

    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.function.name).toBe('write_file');
    // 参数原样保留（不猜、不改值）
    expect(argsOf(repaired[0] as ToolCallPayload)).toEqual({
      path: '/tmp/a.md',
      content: '# 评审结论',
    });
    expect(reroutes).toEqual([
      { from: 'edit_file', to: 'write_file', unknownKeys: ['content'] },
    ]);
  });

  it('签名装得下 → 原样保留，不做任何改派', () => {
    const original = call('edit_file', {
      path: '/tmp/a.md',
      search: 'foo',
      replace: 'bar',
      replace_all: true,
    });
    const { repaired, reroutes } = repairToolCallBySignature([original], FILE_TOOLS);

    expect(repaired[0]?.function.name).toBe('edit_file');
    expect(repaired[0]?.function.arguments).toBe(original.function.arguments);
    expect(reroutes).toEqual([]);
  });

  it('没有候选工具装得下 → 原样保留（宁可用客户端拒绝，也不瞎猜）', () => {
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('edit_file', { path: '/tmp/a', content: 'x', mode: 'w' })],
      FILE_TOOLS,
    );
    expect(repaired[0]?.function.name).toBe('edit_file');
    expect(reroutes).toEqual([]);
  });

  it('⭐ 候选 ≥2 个（有歧义）→ 不改派', () => {
    const tools = [
      tool('edit_x', { path: true, search: true, replace: true }),
      tool('write_a', { path: true, content: true }),
      tool('write_b', { path: true, content: true }),
    ];
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('edit_x', { path: '/a', content: 'x' })],
      tools,
    );
    expect(repaired[0]?.function.name).toBe('edit_x');
    expect(reroutes).toEqual([]);
  });

  it('⭐ 候选的必填参数没被满足 → 不改派（改过去客户端还是会拒）', () => {
    const tools = [
      tool('edit_file', { path: true, search: true, replace: true }),
      // mode 必填，但模型没给 → 改派过去一样失败
      tool('write_file', { path: true, content: true, mode: true }),
    ];
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('edit_file', { path: '/a', content: 'x' })],
      tools,
    );
    expect(repaired[0]?.function.name).toBe('edit_file');
    expect(reroutes).toEqual([]);
  });

  it('工具名本身就不在声明列表里 → 不碰（那是 filterUnknownToolCalls 的职责）', () => {
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('delete_database', { path: '/a' })],
      FILE_TOOLS,
    );
    expect(repaired[0]?.function.name).toBe('delete_database');
    expect(reroutes).toEqual([]);
  });

  it('arguments 不是合法 JSON → 原样保留不抛异常', () => {
    const broken: ToolCallPayload = {
      id: 'c1',
      type: 'function',
      function: { name: 'edit_file', arguments: '{not json' },
    };
    const { repaired, reroutes } = repairToolCallBySignature([broken], FILE_TOOLS);
    expect(repaired[0]?.function.arguments).toBe('{not json');
    expect(reroutes).toEqual([]);
  });

  it('混合：只改派匹配的那个，其它原样', () => {
    const { repaired, reroutes } = repairToolCallBySignature(
      [
        call('read_file', { path: '/tmp/b' }),
        call('edit_file', { path: '/tmp/a.md', content: '# x' }),
      ],
      FILE_TOOLS,
    );
    expect(repaired[0]?.function.name).toBe('read_file');
    expect(repaired[1]?.function.name).toBe('write_file');
    expect(reroutes).toHaveLength(1);
  });

  it('声明了参数但为空对象的工具不参与判断（无法判断就不猜）', () => {
    const tools = [
      tool('edit_file', { path: true, search: true, replace: true }),
      tool('anything', {}), // 空参数面
    ];
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('edit_file', { path: '/a', content: 'x' })],
      tools,
    );
    expect(repaired[0]?.function.name).toBe('edit_file');
    expect(reroutes).toEqual([]);
  });

  it('反向混淆同样处理：write_file(path, search, replace) → edit_file', () => {
    const { repaired, reroutes } = repairToolCallBySignature(
      [call('write_file', { path: '/a', search: 'x', replace: 'y' })],
      FILE_TOOLS,
    );
    expect(repaired[0]?.function.name).toBe('edit_file');
    expect(reroutes[0]?.to).toBe('edit_file');
  });

  it('客户端没提供工具列表 → 全部放行', () => {
    const calls = [call('edit_file', { path: '/a', content: 'x' })];
    expect(repairToolCallBySignature(calls, null).repaired).toEqual(calls);
    expect(repairToolCallBySignature([], FILE_TOOLS).repaired).toEqual([]);
  });
});
