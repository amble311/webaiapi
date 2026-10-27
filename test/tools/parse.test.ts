import { describe, expect, it } from 'vitest';

import { createToolMaps } from '../../src/tools/names.js';
import { parseToolCallsFromText, rawDecodeJson } from '../../src/tools/parse.js';
import type { ToolDefinition } from '../../src/types/message.js';

const CODEBUDDY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: { properties: { filePath: {} } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      parameters: { properties: { filePath: {}, content: {} } },
    },
  },
];
const MAPS = createToolMaps(CODEBUDDY_TOOLS);

function argsOf(tc: { function: { arguments: string } }): Record<string, unknown> {
  return JSON.parse(tc.function.arguments) as Record<string, unknown>;
}

describe('rawDecodeJson', () => {
  it('解析从 0 开始的第一个完整 JSON 对象并给出结束位置', () => {
    const text = '{"a":1} 后面还有内容';
    const out = rawDecodeJson(text);
    expect(out?.value).toEqual({ a: 1 });
    expect(out?.end).toBe(7);
  });

  it('正确跨越字符串里的 } 与转义引号', () => {
    const text = '{"a":"} not end \\" still inside"}tail';
    const out = rawDecodeJson(text);
    expect(out?.value).toEqual({ a: '} not end " still inside' });
    expect(text.slice(out?.end)).toBe('tail');
  });

  it('处理嵌套对象', () => {
    const text = '{"a":{"b":{"c":1}}}x';
    const out = rawDecodeJson(text);
    expect(out?.value).toEqual({ a: { b: { c: 1 } } });
    expect(text.slice(out?.end)).toBe('x');
  });

  it('括号不闭合时返回 undefined', () => {
    expect(rawDecodeJson('{"a":1')).toBeUndefined();
  });

  it('不是对象/数组时返回 undefined', () => {
    expect(rawDecodeJson('hello')).toBeUndefined();
    expect(rawDecodeJson('')).toBeUndefined();
  });

  it('跳过前导空白', () => {
    expect(rawDecodeJson('   {"a":1}')?.end).toBe(10);
  });
});

describe('parseToolCallsFromText — Pattern 1（标准格式）', () => {
  it('提取调用并把块从正文里移除', () => {
    const text =
      '我先读文件\n<tool_call>\n{"name":"Read","arguments":{"file_path":"/a.ts"}}\n</tool_call>\n完成';
    const out = parseToolCallsFromText(text);

    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('Read');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ file_path: '/a.ts' });
    expect(out.text).toBe('我先读文件\n\n完成');
  });

  it('传入 maps 时映射到客户端真实工具名与参数名', () => {
    const text = '<tool_call>{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call>';
    const out = parseToolCallsFromText(text, MAPS);

    expect(out.toolCalls[0]?.function.name).toBe('read_file');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ filePath: '/a.ts' });
  });

  it('多个块全部提取', () => {
    const text =
      '<tool_call>{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call>' +
      '中间文字' +
      '<tool_call>{"name":"Read","arguments":{"file_path":"/b.ts"}}</tool_call>';
    const out = parseToolCallsFromText(text);

    expect(out.toolCalls).toHaveLength(2);
    expect(out.text).toBe('中间文字');
  });

  it('空块被忽略并清理掉标签', () => {
    const out = parseToolCallsFromText('正文<tool_call>\n\n</tool_call>');
    expect(out.toolCalls).toHaveLength(0);
    expect(out.text).toBe('正文');
  });

  it('没有工具调用时正文原样返回', () => {
    const out = parseToolCallsFromText('就是一段普通回答');
    expect(out.toolCalls).toHaveLength(0);
    expect(out.text).toBe('就是一段普通回答');
  });
});

describe('parseToolCallsFromText — 宽容格式', () => {
  it('Pattern 2：name 写成 XML 属性', () => {
    const text = '<tool_call name="Read">{"path":"/a.ts"}</tool_call';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls[0]?.function.name).toBe('Read');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ file_path: '/a.ts' });
  });

  it('Pattern 3：JSON 在前、闭合标签残缺', () => {
    const text = '{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.text).toBe('');
  });

  it('Pattern 4：少了开头的 <', () => {
    const text = 'tool_call>{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call>';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
  });

  it('Pattern 5：完全没有闭合标签（靠 raw_decode 定界）', () => {
    const text =
      'tool_call>\n{"name":"Write","arguments":{"file_path":"/a.ts","content":"x"}}\n后面还有文字';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.text).toBe('后面还有文字');
  });

  it('破碎标签 <ttool_call> 会被归一化后解析', () => {
    const text = '<ttool_call>\n{"name":"Read","arguments":{"file_path":"/a.ts"}}\n</ttool_call>';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.text).toBe('');
  });

  it('Pattern 6：标签全碎时从正文里扫独立 JSON', () => {
    const text = 'tool_call 标签碎了\n{"name":"Read","arguments":{"file_path":"/a.ts"}}';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(argsOf(out.toolCalls[0]!)).toEqual({ file_path: '/a.ts' });
  });

  it('没有破碎标签迹象时不启用 Pattern 6（避免误吃正常 JSON 代码示例）', () => {
    const text = '这是配置示例：\n{"name":"Read","arguments":{"file_path":"/a.ts"}}';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(0);
    expect(out.text).toBe(text);
  });
});

describe('parseToolCallsFromText — Pattern 7（DOM 损坏修复）', () => {
  it('预览 key 损坏的 JSON 会被修复并提取', () => {
    const text =
      '<tool_call>\n{"file_path"file_path": "/opt/proj/src/index.ts", "nam"name": "Read"}\n</tool_call>';
    const out = parseToolCallsFromText(text);

    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('Read');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ file_path: '/opt/proj/src/index.ts' });
    expect(out.text).toBe('');
  });

  it('修复后仍走 maps 映射到客户端真实工具名', () => {
    const text =
      '<tool_call>\n{"file_path"file_path": "/opt/proj/index.ts", "nam"name": "Read"}\n</tool_call>';
    const out = parseToolCallsFromText(text, MAPS);
    expect(out.toolCalls[0]?.function.name).toBe('read_file');
  });
});

describe('parseToolCallsFromText — 边界', () => {
  it('空字符串安全', () => {
    expect(parseToolCallsFromText('')).toEqual({ text: '', toolCalls: [] });
  });

  it('顶层不是 name/arguments 的 JSON 不会被当成工具调用', () => {
    const text = 'tool_call>\n{"foo":"bar"}';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(0);
  });

  it('工具名缺失但能按参数推断时，Pattern 7 会补成 Read（与 Python 版一致）', () => {
    // Pattern 7 的兜底：有 path 类参数但完全没有 name → 默认 Read（最常见的只读操作）
    const text = '<tool_call>{"arguments":{"file_path":"/a.ts"}}</tool_call>';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('Read');
  });

  it('工具名与参数都无法推断时不产生调用', () => {
    const text = 'tool_call>\n{"arguments":{"foo":"bar"}}';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(0);
  });

  it('同一段文本不会重复提取（span 去重）', () => {
    // Pattern 1 命中后，Pattern 4 的同区间应被跳过
    const text = '<tool_call>{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call>';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
  });

  it('正文里的工具调用标签残留会被清干净', () => {
    const text =
      '开始\n<tool_call>{"name":"Read","arguments":{"file_path":"/a.ts"}}</tool_call>\n结束';
    const out = parseToolCallsFromText(text);
    expect(out.text).not.toContain('tool_call');
    expect(out.text).toBe('开始\n\n结束');
  });
});

/**
 * ⭐ 2026-10-16 真实事故（用户截图 + 日志原文）：deepseek 网页端模型**没有**用我们注入的
 * `<tool_call>{…}</tool_call>` 文本协议，而是直接吐它训练里的**原生 DSML 格式**
 * （特殊 token 用全角竖线 `｜` U+FF5C）：
 *
 * ```
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="list_dir">
 * <｜｜DSML｜｜ parameter name="target_directory" string="true">/home/amble/object/btc</｜｜DSML｜｜ parameter>
 * <｜｜DSML｜｜ parameter name="ignore_globs" string="true">（忽略 glob 的 JSON 数组）</｜｜DSML｜｜ parameter>
 * </｜｜DSML｜｜ invoke>
 * </｜｜DSML｜｜ calls>
 * ```
 *
 * 不识别它时：340 字符的回复**整段原样透传给客户端**（用户看到一堆 `｜｜DSML｜｜`），
 * 一个工具调用都解析不出来。夹具是**事故当场的原文**（照抄，别改写）。
 */
describe('parseToolCallsFromText — DeepSeek 原生 DSML 格式', () => {
  const DSML = [
    '我先了解项目结构和相关脚本文件。',
    '',
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="list_dir">',
    '<｜｜DSML｜｜ parameter name="target_directory" string="true">/home/amble/object/btc</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="ignore_globs" string="true">["**/.git/**", "**/node_modules/**", "**/__pycache__/**"]</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');

  it('⭐ 解析出调用、参数正确，且原文不再透传给用户', () => {
    const out = parseToolCallsFromText(DSML);

    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('list_dir');
    const args = JSON.parse(String(out.toolCalls[0]?.function.arguments ?? '{}'));
    expect(args['target_directory']).toBe('/home/amble/object/btc');
    // `string="true"` 里塞了 JSON 数组（模型常见错误）→ 按结构化值处理
    expect(args['ignore_globs']).toEqual(['**/.git/**', '**/node_modules/**', '**/__pycache__/**']);

    // ⚠️ 关键：原始 XML 绝不能留在正文里（这正是用户看到的那一幕）
    expect(out.text).not.toContain('DSML');
    expect(out.text).toContain('我先了解项目结构和相关脚本文件');
  });

  it('一次多个 invoke（并行调用）', () => {
    const two = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="list_dir">',
      '<｜｜DSML｜｜ parameter name="target_directory" string="true">/home/amble/object/btc</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="filePath" string="true">/home/amble/object/btc/a.py</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n');

    const out = parseToolCallsFromText(two);
    expect(out.toolCalls.map((tc) => tc.function.name)).toEqual(['list_dir', 'read_file']);
  });

  it('非字符串参数会被解析成数字/布尔（不带 string="true"）', () => {
    const text = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_file">',
      '<｜｜DSML｜｜ parameter name="limit">50</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="flag">true</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n');
    const args = JSON.parse(
      String(parseToolCallsFromText(text).toolCalls[0]?.function.arguments ?? '{}'),
    );
    expect(args['limit']).toBe(50);
    expect(args['flag']).toBe(true);
  });

  it('半角竖线与无空格变体也能识别（容错）', () => {
    const text =
      '<||DSML|| calls><||DSML|| invoke name="list_dir"><||DSML|| parameter name="target_directory" string="true">/tmp</||DSML|| parameter></||DSML|| invoke></||DSML|| calls>';
    const out = parseToolCallsFromText(text);
    expect(out.toolCalls[0]?.function.name).toBe('list_dir');
    expect(out.text).not.toContain('DSML');
  });

  it('普通回答里出现 DSML 字样不会误伤（没有 calls 块就什么都不做）', () => {
    const out = parseToolCallsFromText('这段文字提到了 DSML 这个词，但没有调用块。');
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toContain('DSML');
  });
});

/**
 * ⭐ 2026-10-17 实测事故（用户「好像又突然停止了」）：模型又吐了 DSML，但这版**闭合标签没有名字**：
 *
 * ```
 * <｜｜DSML｜｜ calls>
 * <｜｜DSML｜｜ invoke name="bash">
 * <｜｜DSML｜｜ parameter name="command" string="true">cd /… && python -c "
 * import ccxt
 * "
 * </｜｜DSML｜｜ parameter>
 * <｜｜DSML｜｜ parameter name="timeout" string="false">180000</｜｜DSML｜｜ parameter>
 * </｜｜DSML｜｜>            ← invoke 的闭合没有名字（早期版本靠成对标签 → 匹配不上）
 * </｜｜DSML｜｜ calls>
 * ```
 *
 * 旧实现的结果：**0 个工具调用**、正文只剩前言 → 客户端收到纯文本就结束回合（「突然停止」）。
 */
describe('parseToolCallsFromText — DSML 无名闭合 + 多行参数', () => {
  const REAL = [
    'settings.proxy 实际是正确的。真正的问题是 exchange.py:65 把代理放进了错误的地方。',
    '',
    '    <｜｜DSML｜｜ calls>',
    '    <｜｜DSML｜｜ invoke name="bash">',
    '    <｜｜DSML｜｜ parameter name="command" string="true">cd /home/amble/object/btc && venv/bin/python -c "',
    'import ccxt',
    'for label, opts in [',
    '    ("proxies", {"proxies": {"http": "http://127.0.0.1:10808"}}),',
    ']:',
    '    print(label)',
    '" 2>&1 | tail -10</｜｜DSML｜｜ parameter>',
    '    <｜｜DSML｜｜ parameter name="timeout" string="false">180000</｜｜DSML｜｜ parameter>',
    '    </｜｜DSML｜｜>',
    '    </｜｜DSML｜｜ calls>',
  ].join('\n');

  it('⭐ 能解析出调用（修复前是 0 个）', () => {
    const out = parseToolCallsFromText(REAL);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('bash');
  });

  it('多行脚本参数完整，且尾巴不粘闭合标记', () => {
    const out = parseToolCallsFromText(REAL);
    const args = JSON.parse(String(out.toolCalls[0]?.function.arguments ?? '{}')) as Record<string, unknown>;

    expect(args['command']).toContain('import ccxt');
    expect(args['command']).toContain('http://127.0.0.1:10808');
    expect(String(args['command'])).not.toContain('DSML');
    // string="false" → 解析成数字
    expect(args['timeout']).toBe(180000);
  });

  it('正文只留前言，原始标记不外泄', () => {
    const out = parseToolCallsFromText(REAL);
    expect(out.text).toContain('exchange.py:65');
    expect(out.text).not.toContain('DSML');
  });
});

/**
 * ⭐ 2026-10-17 用户实测（回复里又出现 `<｜｜DSML｜｜ calls>`）：这次是**未闭合**的 DSML ——
 * 模型只写了一个孤零零的开标记（没有闭合、没有 invoke），整块正则匹配不上 →
 * 原始标记原样透给用户。修法：① 从开标记起**尽力解析** invoke；② 标记与参数值一律剥掉。
 */
describe('parseToolCallsFromText — 未闭合的 DSML（模型只写了个开头）', () => {
  it('⭐ 只有开标记（用户报的原文）→ 标记不许透出，正文保留', () => {
    const REAL = [
      'docs 目录下的 06-data/ 只有 storage.md，缺少代理和币安接入的文档；',
      'README 里写的默认端口 8666 也与实际使用的 1661 不一致。我接下来会补充并修正这些文档。',
      '',
      '<｜｜DSML｜｜ calls>',
    ].join('\n');

    const out = parseToolCallsFromText(REAL);
    expect(out.toolCalls).toEqual([]);
    expect(out.text).not.toContain('DSML');
    expect(out.text).toContain('修正这些文档');
  });

  it('未闭合但已有 invoke/parameter → 调用照常解析，且标记与参数值都剥掉', () => {
    const REAL = [
      '我先看看目录',
      '',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="list_dir">',
      '<｜｜DSML｜｜ parameter name="target_directory" string="true">/a</｜｜DSML｜｜ parameter>',
    ].join('\n');

    const out = parseToolCallsFromText(REAL);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('list_dir');
    expect(JSON.parse(String(out.toolCalls[0]?.function.arguments))).toEqual({
      target_directory: '/a',
    });
    expect(out.text).toBe('我先看看目录');
  });
});

/**
 * ⭐ 2026-10-27 用户实测（与原生模型对比）：agent 调用我们包装的模型时，
 * 输出里出现了孤零零的 `<call></call>`（空容器）✗ —— 解析器的 7 层 Pattern 只认
 * `<tool_call>`，所以它被当成正文漏给了客户端。
 */
describe('parseToolCallsFromText — `<call>` 别名与空调用', () => {
  it('⭐ `<call>{...}</call>` 当作工具调用解析（别再漏成正文）', () => {
    const r = parseToolCallsFromText('<call>{"name":"read_file","arguments":{"path":"/a"}}</call>');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.function.name).toBe('read_file');
    expect(r.text).not.toContain('<call>');
  });

  it('⭐ 空的 `<call></call>` 要从正文里清掉（否则用户会看到它）', () => {
    const r = parseToolCallsFromText('好的\n<call>\n\n</call>\n继续');
    expect(r.toolCalls).toHaveLength(0);
    expect(r.text).not.toContain('call');
    expect(r.text).toContain('好的');
  });

  it('空的 `<tool_call></tool_call>` 同样清掉', () => {
    const r = parseToolCallsFromText('前文<tool_call></tool_call>后文');
    expect(r.toolCalls).toHaveLength(0);
    expect(r.text).not.toContain('tool_call');
  });
});
