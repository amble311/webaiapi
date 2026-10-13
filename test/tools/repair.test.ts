import { describe, expect, it } from 'vitest';

import { cleanDomHtml, normalizeToolCallTags, stripLeftoverToolTags } from '../../src/tools/clean.js';
import {
  DOM_CORRUPTION_INDICATOR,
  DOM_PREVIEW_KEY_INDICATOR,
  extractComplexFieldFromCorrupted,
  extractPathFromCorrupted,
  extractToolCallByRegex,
  hasSmartQuotes,
  repairDomCorruptedJson,
  repairJson,
  tryParseJson,
} from '../../src/tools/repair.js';

describe('cleanDomHtml', () => {
  it('移除 ChatGLM 的 span / div 渲染工件', () => {
    const input =
      '<span data-allow-html data-gradient="true" style="opacity: 0.6">n</span><div>a</div>';
    expect(cleanDomHtml(input)).toBe('na');
  });

  it('<br> 变成 \\n，NBSP 变普通空格', () => {
    expect(cleanDomHtml('a<br>b<br/>c\u00a0d')).toBe('a\\nb\\nc d');
  });

  it('不动看起来像用户代码内容的标签', () => {
    const input = '<script>const a = 1;</script><style>.a{}</style>';
    expect(cleanDomHtml(input)).toBe(input);
  });
});

describe('normalizeToolCallTags', () => {
  it('修复多余 t 的标签', () => {
    expect(normalizeToolCallTags('<ttool_call>{"a":1}</ttool_call>')).toBe(
      '<tool_call>{"a":1}</tool_call>',
    );
  });

  it('修复跨行截断的标签', () => {
    expect(normalizeToolCallTags('<t \n ool_call>{"a":1}</tool_call>')).toBe(
      '<tool_call>{"a":1}</tool_call>',
    );
    expect(normalizeToolCallTags('<tool \n _call>{"a":1}</tool_call>')).toBe(
      '<tool_call>{"a":1}</tool_call>',
    );
  });

  it('移除 ChatGLM 插入的 arg_key / arg_value 标签', () => {
    expect(normalizeToolCallTags('<arg_key>path</arg_key><arg_value>/a</arg_value>')).toBe('path/a');
  });
});

describe('stripLeftoverToolTags', () => {
  it('清掉成对的空标签块', () => {
    expect(stripLeftoverToolTags('正文\n<tool_call>\n\n</tool_call>\n结束')).toBe('正文\n\n结束');
  });

  it('清掉粘连写法（缺尖括号）', () => {
    expect(stripLeftoverToolTags('a tool_call> b')).toBe('a  b');
  });

  it('空输入返回空串', () => {
    expect(stripLeftoverToolTags('')).toBe('');
  });
});

describe('repairJson', () => {
  it('把字符串里的真实换行转义', () => {
    expect(repairJson('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
  });

  it('把非法转义（\\d \\w \\s）变成合法转义', () => {
    // 正则字面量被 AI 直接塞进 JSON 字符串里是常见问题
    const out = repairJson('{"pattern":"\\d+\\w"}');
    expect(out).toBe('{"pattern":"\\\\d+\\\\w"}');
    expect(JSON.parse(out)).toEqual({ pattern: '\\d+\\w' });
  });

  it('删除尾部逗号', () => {
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
    expect(repairJson('{"a":[1,2,]}')).toBe('{"a":[1,2]}');
  });

  it('被截断在反斜杠处时保留该反斜杠（不会被静默丢掉）', () => {
    const input = '{"a":"x\\'; // 以一个反斜杠结尾
    expect(repairJson(input)).toBe(input);
  });

  it('保留合法转义', () => {
    const out = repairJson('{"a":"x\\ny\\"z"}');
    expect(JSON.parse(out)).toEqual({ a: 'x\ny"z' });
  });
});

describe('tryParseJson', () => {
  it('直接解析正常 JSON', () => {
    expect(tryParseJson('{"name":"Read","arguments":{}}')).toEqual({
      name: 'Read',
      arguments: {},
    });
  });

  it('剥掉 markdown 代码围栏后解析', () => {
    expect(tryParseJson('```json\n{"name":"Read"}\n```')).toEqual({ name: 'Read' });
  });

  it('⛔ DOM 损坏特征存在时不走正则兜底（返回 undefined，交给 Pattern 7）', () => {
    // 形如 "pat"path": 的预览损坏
    const corrupted = '{"file_path"file_path": "/a/b.ts", "nam"name": "Read"}';
    expect(DOM_PREVIEW_KEY_INDICATOR.test(corrupted)).toBe(true);
    expect(tryParseJson(corrupted)).toBeUndefined();
  });

  it('智能引号存在时同样交给 Pattern 7', () => {
    const corrupted = '{\u201cname\u201d: \u201cRead\u201d}';
    expect(hasSmartQuotes(corrupted)).toBe(true);
    expect(tryParseJson(corrupted)).toBeUndefined();
  });

  it('⚠️ SearchReplace 正则兜底缺 old_str/new_str 时返回 undefined（不返回残缺结果）', () => {
    const broken = '{"name": "SearchReplace", "arguments": {"file_path": "/a/b.ts", "old_str": "x"';
    expect(tryParseJson(broken)).toBeUndefined();
  });

  it('完全无法解析时返回 undefined 而不是抛异常', () => {
    expect(tryParseJson('完全不是 JSON')).toBeUndefined();
  });
});

describe('extractToolCallByRegex', () => {
  it('从损坏 JSON 里抠出工具名与参数', () => {
    const text = '{"name": "SearchReplace", "arguments": {"file_path": "/a/b.ts", "old_str": "old", "new_str": "new"';
    expect(extractToolCallByRegex(text)).toEqual({
      name: 'SearchReplace',
      arguments: { file_path: '/a/b.ts', old_str: 'old', new_str: 'new' },
    });
  });

  it('处理值里的转义引号（写文件类工具才提取 content）', () => {
    const text =
      '{"name": "write_file", "arguments": {"file_path": "/a.ts", "content": "const a = \\"x\\";"}}';
    const out = extractToolCallByRegex(text);
    expect(out?.['arguments']).toEqual({ file_path: '/a.ts', content: 'const a = "x";' });
  });

  it('标准名 Write 不在 write_file 别名表内 → 只提取 file_path（与 Python 版一致）', () => {
    const text = '{"name": "Write", "arguments": {"file_path": "/a.ts", "content": "x"}}';
    const out = extractToolCallByRegex(text);
    expect(out?.['arguments']).toEqual({ file_path: '/a.ts' });
  });

  it('没有 name 字段时返回 undefined', () => {
    expect(extractToolCallByRegex('{"arguments":{}}')).toBeUndefined();
  });

  it('提取不到任何已知字段时返回 undefined', () => {
    const text = '{"name": "Read", "arguments": {"unknown_key": "v"}}';
    expect(extractToolCallByRegex(text)).toBeUndefined();
  });

  it('值里含智能引号时返回 undefined（视为 DOM 损坏）', () => {
    const text = '{"name": "Read", "arguments": {"file_path": "/a\u201cb.ts"}}';
    expect(extractToolCallByRegex(text)).toBeUndefined();
  });
});

describe('DOM 损坏指示器', () => {
  it('识别转义引号包围 key 的形态', () => {
    expect(DOM_CORRUPTION_INDICATOR.test('{"\\"name\\": "Read"}')).toBe(true);
  });

  it('识别「预览前缀 + 完整值」的形态', () => {
    expect(DOM_CORRUPTION_INDICATOR.test('{"name": "Re\\"Read"}')).toBe(true);
  });

  it('正常 JSON 不误报', () => {
    expect(DOM_CORRUPTION_INDICATOR.test('{"name": "Read"}')).toBe(false);
    expect(DOM_PREVIEW_KEY_INDICATOR.test('{"name": "Read"}')).toBe(false);
  });
});

describe('extractComplexFieldFromCorrupted', () => {
  it('模式 C：正常 JSON 直接取值', () => {
    expect(extractComplexFieldFromCorrupted('{"content": "hello"}', 'content')).toBe('hello');
  });

  it('模式 A：key 重复（预览 + 完整值）时取完整值', () => {
    const text = '{"old_str": "pre"old_str": "完整内容"}';
    expect(extractComplexFieldFromCorrupted(text, 'old_str')).toBe('完整内容');
  });

  it('模式 B：值提前闭合时以「下一个已知 key」为边界', () => {
    const text = '{"old_str": "  const a = 1;", "new_str": "  const a = 2;"}';
    expect(extractComplexFieldFromCorrupted(text, 'old_str')).toBe('  const a = 1;');
  });

  it('把智能引号归一化成直引号', () => {
    expect(extractComplexFieldFromCorrupted('{\u201ccontent\u201d: \u201cabc\u201d}', 'content')).toBe(
      'abc',
    );
  });

  it('字段不存在返回 undefined', () => {
    expect(extractComplexFieldFromCorrupted('{"a":1}', 'content')).toBeUndefined();
  });
});

describe('extractPathFromCorrupted', () => {
  it('取最长的那条路径（DOM 会留下多个短前缀）', () => {
    const text = '"/ho "/home/amble/proj/index.h"/home/amble/proj/index.html"';
    expect(extractPathFromCorrupted(text)).toBe('/home/amble/proj/index.html');
  });

  it('支持 Windows 路径', () => {
    expect(extractPathFromCorrupted('C:/Users/me/app.ts')).toBe('C:/Users/me/app.ts');
  });

  it('没有路径时返回 undefined', () => {
    expect(extractPathFromCorrupted('没有路径')).toBeUndefined();
  });
});

describe('repairDomCorruptedJson', () => {
  it('重建「预览 key 损坏」的 JSON，保留最长路径与工具名', () => {
    const corrupted = '<tool_call>{"file_path"file_path": "/opt/proj/src/index.ts", "nam"name": "Read"}</tool_call>';
    const repaired = repairDomCorruptedJson(corrupted);

    expect(repaired).not.toBe(corrupted);
    const json = /\{.*\}/s.exec(repaired)?.[0] as string;
    expect(JSON.parse(json)).toEqual({
      name: 'Read',
      arguments: { file_path: '/opt/proj/src/index.ts' },
    });
  });

  it('先清 HTML 再取 token（span 属性里的引号会打乱 token 推断）', () => {
    const corrupted =
      '<span data-allow-html style="opacity: 0.6">{"file_path"file_path": "/opt/proj/app_1.ts", "nam"name": "Read"}</span>';
    const repaired = repairDomCorruptedJson(corrupted);
    const json = /\{.*\}/s.exec(repaired)?.[0] as string;
    expect(JSON.parse(json)['name']).toBe('Read');
  });

  it('工具名被完全消费时按参数推断（有 path 无 content → Read）', () => {
    const corrupted = '{"file_path"file_path": "/opt/proj/app_1.ts"}';
    const repaired = repairDomCorruptedJson(corrupted);
    const json = /\{.*\}/s.exec(repaired)?.[0] as string;
    expect(JSON.parse(json)).toEqual({
      name: 'Read',
      arguments: { file_path: '/opt/proj/app_1.ts' },
    });
  });

  it('复杂多行字段用正则重取完整值（不用 token 的短前缀）', () => {
    const corrupted = '{"name": "Write", "content"content": "第一行\\n第二行\\n第三行"}';
    const repaired = repairDomCorruptedJson(corrupted);
    const json = /\{.*\}/s.exec(repaired)?.[0] as string;
    const parsed = JSON.parse(json) as { name: string; arguments: Record<string, string> };
    expect(parsed.name).toBe('Write');
    expect(parsed.arguments['content']).toBe('第一行\n第二行\n第三行');
  });

  it('完全无法推断时原样返回（不破坏输入）', () => {
    const input = '{"something": "else"}';
    expect(repairDomCorruptedJson(input)).toBe(input);
  });

  it('没有 { 时原样返回', () => {
    expect(repairDomCorruptedJson('没有 JSON')).toBe('没有 JSON');
  });
});
