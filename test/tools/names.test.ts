import { describe, expect, it } from 'vitest';

import { buildToolCall } from '../../src/tools/build.js';
import {
  createToolMaps,
  detectToolNames,
  filterUnknownToolCalls,
  normalizeToolArguments,
  normalizeToolName,
  resolveToolName,
} from '../../src/tools/names.js';
import type { ToolCallPayload, ToolDefinition } from '../../src/types/message.js';

/** CodeBuddy 风格的工具定义：filePath 是驼峰。 */
const CODEBUDDY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' }, content: { type: 'string' } },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Edit a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
        },
        required: ['filePath', 'old_str', 'new_str'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

/** Trae 风格：标准名 + 下划线参数。 */
const TRAE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'Write',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'SearchReplace',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_str: { type: 'string' },
          new_str: { type: 'string' },
        },
      },
    },
  },
];

describe('detectToolNames', () => {
  it('按参数特征识别 CodeBuddy 的写/改/读工具（filePath 驼峰也算 file_path）', () => {
    expect(detectToolNames(CODEBUDDY_TOOLS)).toEqual({
      write: 'write_to_file',
      edit: 'replace_in_file',
      read: 'read_file',
    });
  });

  it('识别 Trae 的标准名工具', () => {
    expect(detectToolNames(TRAE_TOOLS)).toEqual({ write: 'Write', edit: 'SearchReplace' });
  });

  it('只有 path 的工具不当作读取工具（path 可能是目录）', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'list_dir', parameters: { properties: { path: {} } } },
      },
    ];
    expect(detectToolNames(tools)).toEqual({});
  });

  it('带 content 的不当作读取工具', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'create_file',
          parameters: { properties: { file_path: {}, content: {} } },
        },
      },
    ];
    expect(detectToolNames(tools)).toEqual({ write: 'create_file' });
  });
});

describe('normalizeToolName / normalizeParamKey', () => {
  it('去掉非字母数字并小写', () => {
    expect(normalizeToolName('write_to_file')).toBe('writetofile');
    expect(normalizeToolName('SearchReplace')).toBe('searchreplace');
    expect(normalizeToolName('replace-in-file')).toBe('replaceinfile');
    expect(normalizeToolName(null)).toBe('');
  });
});

describe('createToolMaps', () => {
  it('建立 归一化参数名 → 客户端原始参数名 的映射', () => {
    const maps = createToolMaps(CODEBUDDY_TOOLS);
    expect(maps.name).toEqual({
      write: 'write_to_file',
      edit: 'replace_in_file',
      read: 'read_file',
    });
    // 归一化键只保留小写字母
    expect(maps.param['write_to_file']).toEqual({ filepath: 'filePath', content: 'content' });
  });

  it('没有工具时返回空映射', () => {
    expect(createToolMaps([])).toEqual({ name: {}, param: {} });
  });
});

describe('resolveToolName', () => {
  const allowed = ['write_to_file', 'replace_in_file', 'read_file', 'list_dir'];
  const maps = createToolMaps(CODEBUDDY_TOOLS);

  it('完全相同直接返回', () => {
    expect(resolveToolName('write_to_file', allowed, maps)).toBe('write_to_file');
  });

  it('归一化相同也能匹配', () => {
    expect(resolveToolName('WriteToFile', allowed, maps)).toBe('write_to_file');
    expect(resolveToolName('write-to-file', allowed, maps)).toBe('write_to_file');
  });

  it('⚠️ 近似名必须映射到客户端真实工具名，不能丢弃', () => {
    // 实测 AI 输出 write_file，客户端只有 write_to_file
    expect(resolveToolName('write_file', allowed, maps)).toBe('write_to_file');
    expect(resolveToolName('Write', allowed, maps)).toBe('write_to_file');
    expect(resolveToolName('create_file', allowed, maps)).toBe('write_to_file');
    expect(resolveToolName('edit', allowed, maps)).toBe('replace_in_file');
    expect(resolveToolName('SearchReplace', allowed, maps)).toBe('replace_in_file');
    expect(resolveToolName('str_replace', allowed, maps)).toBe('replace_in_file');
    expect(resolveToolName('Read', allowed, maps)).toBe('read_file');
  });

  it('没有 maps 时的兜底只在「客户端名含语义词」时生效', () => {
    expect(resolveToolName('read', ['read_file'])).toBe('read_file');

    // ⚠️ 已知局限（与 Python 版一致）：`replace_in_file` 里并不含 "edit"，
    // 所以没有 maps 时无法兜底匹配。这就是为什么路由层**必须**传
    // `createToolMaps(tools)` 的结果 —— 有 maps 时走 maps.name['edit'] 精确命中。
    expect(resolveToolName('edit', ['replace_in_file'])).toBe('');
    expect(resolveToolName('edit', ['replace_in_file'], maps)).toBe('replace_in_file');
  });

  it('无法解析时返回空字符串', () => {
    expect(resolveToolName('totally_unknown_tool', allowed, maps)).toBe('');
    expect(resolveToolName('', allowed, maps)).toBe('');
    expect(resolveToolName('write', [], maps)).toBe('');
  });
});

describe('filterUnknownToolCalls', () => {
  const maps = createToolMaps(CODEBUDDY_TOOLS);

  const call = (name: string, args = '{}'): ToolCallPayload => ({
    id: 'call_x',
    type: 'function',
    function: { name, arguments: args },
  });

  it('已知工具名直接保留', () => {
    const { valid, dropped } = filterUnknownToolCalls([call('list_dir')], CODEBUDDY_TOOLS, maps);
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('⚠️ 近似名映射后保留（不能整条丢弃）', () => {
    const { valid, dropped } = filterUnknownToolCalls(
      [call('write_file'), call('SearchReplace')],
      CODEBUDDY_TOOLS,
      maps,
    );
    expect(valid.map((c) => c.function.name)).toEqual(['write_to_file', 'replace_in_file']);
    expect(dropped).toHaveLength(0);
  });

  it('真正未知的工具名被丢弃', () => {
    const { valid, dropped } = filterUnknownToolCalls(
      [call('totally_made_up'), call('list_dir')],
      CODEBUDDY_TOOLS,
      maps,
    );
    expect(valid.map((c) => c.function.name)).toEqual(['list_dir']);
    expect(dropped.map((c) => c.function.name)).toEqual(['totally_made_up']);
  });

  it('平台自带工具（search 等）会被丢弃', () => {
    const { valid, dropped } = filterUnknownToolCalls([call('search')], CODEBUDDY_TOOLS, maps);
    expect(valid).toHaveLength(0);
    expect(dropped.map((c) => c.function.name)).toEqual(['search']);
  });

  it('客户端未提供工具列表时全部放行', () => {
    const { valid, dropped } = filterUnknownToolCalls([call('anything')], [], maps);
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('空输入返回空结果', () => {
    expect(filterUnknownToolCalls([], CODEBUDDY_TOOLS, maps)).toEqual({ valid: [], dropped: [] });
    expect(filterUnknownToolCalls(null, CODEBUDDY_TOOLS, maps)).toEqual({
      valid: [],
      dropped: [],
    });
  });
});

describe('normalizeToolArguments', () => {
  it('把 SearchReplace 的各种别名归一到 old_str/new_str', () => {
    const out = normalizeToolArguments('SearchReplace', {
      path: '/a/b.txt',
      search: 'old',
      replace: 'new',
    });
    expect(out).toEqual({ file_path: '/a/b.txt', old_str: 'old', new_str: 'new' });
  });

  it('path → file_path 仅对需要 file_path 的工具生效', () => {
    expect(normalizeToolArguments('Read', { path: '/a.txt' })).toEqual({ file_path: '/a.txt' });
    // LS 用 path 表示目录，不能映射
    expect(normalizeToolArguments('LS', { path: '/a' })).toEqual({ path: '/a' });
  });

  it('标准参数名的值优先于别名（冲突时不覆盖）', () => {
    const out = normalizeToolArguments('SearchReplace', {
      old_str: 'standard',
      oldText: 'alias',
    });
    expect(out['old_str']).toBe('standard');
  });

  it('write_file 的内容别名归一到 content', () => {
    expect(normalizeToolArguments('write_file', { file_text: 'x', text: 'y' })).toEqual({
      file_text: 'x',
      content: 'y',
    });
    expect(normalizeToolArguments('write_file', { text: 'y' })).toEqual({ content: 'y' });
  });

  it('空参数原样返回', () => {
    expect(normalizeToolArguments('Read', {})).toEqual({});
  });
});

describe('buildToolCall', () => {
  const maps = createToolMaps(CODEBUDDY_TOOLS);

  function argsOf(tc: ToolCallPayload | null): Record<string, unknown> {
    return JSON.parse(tc?.function.arguments ?? '{}') as Record<string, unknown>;
  }

  it('标准名映射到客户端真实工具名 + 参数名还原为驼峰', () => {
    const tc = buildToolCall('Write', { file_path: '/a/b.txt', content: 'hi' }, maps);
    expect(tc?.function.name).toBe('write_to_file');
    expect(argsOf(tc)).toEqual({ filePath: '/a/b.txt', content: 'hi' });
    expect(tc?.type).toBe('function');
    expect(tc?.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it('别名链 edit_file → SearchReplace → 客户端编辑工具，参数全部归一化', () => {
    const tc = buildToolCall(
      'edit_file',
      { path: '/a/b.txt', search: 'old', replace: 'new' },
      maps,
    );
    expect(tc?.function.name).toBe('replace_in_file');
    expect(argsOf(tc)).toEqual({ filePath: '/a/b.txt', old_str: 'old', new_str: 'new' });
  });

  it('Trae 场景下保留标准名与下划线参数', () => {
    const traeMaps = createToolMaps(TRAE_TOOLS);
    const tc = buildToolCall('write_file', { file_path: '/a/b.txt', content: 'x' }, traeMaps);
    expect(tc?.function.name).toBe('Write');
    expect(argsOf(tc)).toEqual({ file_path: '/a/b.txt', content: 'x' });
  });

  it('IDE 内部工具返回带 error 的调用（避免 AI 无限等结果）', () => {
    const tc = buildToolCall('get_goal', {}, maps);
    expect(tc?.function.name).toBe('get_goal');
    const args = argsOf(tc);
    expect(String(args['error'])).toContain('仅在 Trae IDE 环境中可用');
  });

  it('arguments 是 JSON 字符串时先解析', () => {
    const tc = buildToolCall('read_file', '{"file_path":"/a.txt"}', maps);
    expect(tc?.function.name).toBe('read_file');
    expect(argsOf(tc)).toEqual({ filePath: '/a.txt' });
  });

  it('arguments 无法解析时放进 _raw，不抛异常', () => {
    const tc = buildToolCall('read_file', '{broken', maps);
    expect(argsOf(tc)).toEqual({ _raw: '{broken' });
  });

  it('清理参数值里的 DOM HTML 残留（span / br / NBSP）', () => {
    const tc = buildToolCall(
      'Write',
      { file_path: '/a.txt', content: '<span data-allow-html style="opacity:0.6">x</span><br>y\u00a0z' },
      maps,
    );
    expect(argsOf(tc)['content']).toBe('x\\ny z');
  });

  it('name 为空返回 null', () => {
    expect(buildToolCall('', {})).toBeNull();
    expect(buildToolCall(null, {})).toBeNull();
  });

  it('同一个请求内的映射完全由传入的 maps 决定（无全局串扰）', () => {
    const mapsA = createToolMaps(CODEBUDDY_TOOLS);
    const mapsB = createToolMaps(TRAE_TOOLS);

    const a = buildToolCall('Write', { file_path: '/a', content: 'x' }, mapsA);
    const b = buildToolCall('Write', { file_path: '/a', content: 'x' }, mapsB);

    expect(a?.function.name).toBe('write_to_file');
    expect(b?.function.name).toBe('Write');
  });
});
