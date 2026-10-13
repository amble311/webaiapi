import { describe, expect, it } from 'vitest';

import {
  buildWriteArgs,
  collectFilePathsInText,
  convertTextToToolCalls,
  directConvertToToolCalls,
  inferFilename,
  looksLikeFileContent,
  looksLikeFilepath,
} from '../../src/tools/convert.js';
import type { ToolCallPayload, ToolDefinition } from '../../src/types/message.js';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      parameters: { properties: { filePath: {}, content: {} } },
    },
  },
];

function argsOf(tc: ToolCallPayload): Record<string, unknown> {
  return JSON.parse(tc.function.arguments) as Record<string, unknown>;
}

describe('looksLikeFilepath', () => {
  it('含路径分隔符 → 是路径', () => {
    expect(looksLikeFilepath('src/main.py')).toBe(true);
    expect(looksLikeFilepath('/abs/path')).toBe(true);
    expect(looksLikeFilepath('a\\b')).toBe(true);
  });

  it('排除 URL', () => {
    expect(looksLikeFilepath('https://example.com/a.py')).toBe(false);
    expect(looksLikeFilepath('http://x/y')).toBe(false);
  });

  it('常见源码扩展名 → 是路径', () => {
    expect(looksLikeFilepath('main.py')).toBe(true);
    expect(looksLikeFilepath('A.TS')).toBe(true);
  });

  it('过长的字符串不是路径', () => {
    expect(looksLikeFilepath(`a${'b'.repeat(300)}.py`)).toBe(false);
  });

  it('点开头的短名（如 .bashrc）是路径；但 .. 开头不是', () => {
    expect(looksLikeFilepath('.bashrc')).toBe(true);
    expect(looksLikeFilepath('..')).toBe(false);
  });

  it('普通文字不是路径', () => {
    expect(looksLikeFilepath('这是一段说明文字')).toBe(false);
  });
});

describe('convertTextToToolCalls', () => {
  it('把「带路径的代码块」转成写文件调用并移除该代码块', () => {
    const text = '这是代码：\n```python src/main.py\nprint(1)\n```\n完成';
    const out = convertTextToToolCalls(text, TOOLS);

    expect(out.toolCalls).toHaveLength(1);
    // 工具名与参数名都取自客户端真实定义（不再硬编码 write_file / file_path）
    expect(out.toolCalls[0]?.function.name).toBe('write_to_file');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ filePath: 'src/main.py', content: 'print(1)\n' });
    expect(out.text).toBe('这是代码：\n完成');
  });

  it('支持「文件: path」后跟代码块的形式', () => {
    const text = '文件: src/a_1.py\n```\nprint(1)\n```';
    const out = convertTextToToolCalls(text, TOOLS);
    expect(out.toolCalls).toHaveLength(1);
    expect(argsOf(out.toolCalls[0]!)['filePath']).toBe('src/a_1.py');
  });

  it('⚠️ 没有可提取内容时把原文本原样返回（调用方必须检查是否真的提取到）', () => {
    const text = '只是一段说明文字，没有代码块。';
    const out = convertTextToToolCalls(text, TOOLS);
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe(text);
  });

  it('代码块首行不像路径时忽略', () => {
    const text = '```js\nconsole.log(1)\n```';
    const out = convertTextToToolCalls(text, TOOLS);
    expect(out.toolCalls).toEqual([]);
  });
});

describe('buildWriteArgs', () => {
  it('按工具声明的真实参数名构建', () => {
    expect(buildWriteArgs(['filePath', 'content'], '/a.ts', 'x')).toEqual({
      filePath: '/a.ts',
      content: 'x',
    });
  });

  it('识别 path / filepath / filename 与 code / text / body', () => {
    expect(buildWriteArgs(['path', 'code'], '/a.ts', 'x')).toEqual({ path: '/a.ts', code: 'x' });
    expect(buildWriteArgs(['filename', 'body'], '/a.ts', 'x')).toEqual({
      filename: '/a.ts',
      body: 'x',
    });
  });

  it('参数名不认识时回退 file_path / content', () => {
    expect(buildWriteArgs(['whatever'], '/a.ts', 'x')).toEqual({
      file_path: '/a.ts',
      content: 'x',
    });
  });

  it('空参数名列表也回退默认名', () => {
    expect(buildWriteArgs([], '/a.ts', 'x')).toEqual({ file_path: '/a.ts', content: 'x' });
  });
});

describe('inferFilename', () => {
  it('优先从用户请求里抠文件名', () => {
    expect(inferFilename('请创建 demo_1.py', '')).toBe('demo_1.py');
    expect(inferFilename('新建 报告.md', '')).toBe('报告.md');
  });

  it('markdown 标题 → 用标题做文件名', () => {
    expect(inferFilename('', '# My Report\n\ncontent')).toBe('My_Report.md');
  });

  it('markdown 但无标题 → README.md', () => {
    expect(inferFilename('', '#\n')).toBe('README.md');
  });

  it('按首行特征推断代码文件类型', () => {
    expect(inferFilename('', 'import os\nprint(1)')).toBe('main.py');
    expect(inferFilename('', 'const a = 1;')).toBe('index.js');
    expect(inferFilename('', '<?xml version="1.0"?>')).toBe('config.xml');
    expect(inferFilename('', '{"a": 1}')).toBe('config.json');
  });

  it('无法判断时回退 README.md', () => {
    expect(inferFilename('', '随便一段文字')).toBe('README.md');
  });
});

/** 补足长度的说明文字（`looksLikeFileContent` 有 300 字符下限）。 */
const PAD = '这是一段说明文字。'.repeat(60);

describe('looksLikeFileContent', () => {
  it('太短（<300）一律不是文件内容', () => {
    expect(looksLikeFileContent('# 标题')).toBe(false);
  });

  it('计划性语言 → 不是文件内容', () => {
    const text = `我先读取一下项目结构。\n${'# 内容\n'.repeat(200)}`;
    expect(looksLikeFileContent(text)).toBe(false);
  });

  it('markdown 标题开头且够长 → 是文件内容', () => {
    const text = `# 标题\n${'段落\n'.repeat(200)}`;
    expect(looksLikeFileContent(text)).toBe(true);
  });

  it('完整 HTML 文档 → 是文件内容', () => {
    const text = `<!DOCTYPE html>\n${'<div>x</div>\n'.repeat(80)}`;
    expect(looksLikeFileContent(text)).toBe(true);
  });

  it('含带路径的代码块 → 是文件内容', () => {
    const text = `${PAD}\n\`\`\`python src/a.py\nprint(1)\n\`\`\``;
    expect(looksLikeFileContent(text)).toBe(true);
  });

  it('3 个以上代码块 → 是文件内容', () => {
    const text = `${PAD}\n\`\`\`\n\`\`\`\`\`\`\n\`\`\`\`\`\`\n\`\`\``;
    expect(looksLikeFileContent(text)).toBe(true);
  });

  it('代码行占比高 → 是文件内容', () => {
    const lines = ['// 注释', 'const a = 1;', 'let b = 2;', 'function f() {}'];
    // 行数必须 > 20（函数里以 len(lines) > 20 为前置条件）
    const text = Array.from({ length: 12 }, () => lines).flat().join('\n');
    expect(looksLikeFileContent(text)).toBe(true);
  });

  it('纯自然语言描述（长但不含代码）→ 不是文件内容', () => {
    const text = '这是一段很长的自然语言说明。'.repeat(40);
    expect(looksLikeFileContent(text)).toBe(false);
  });
});

describe('directConvertToToolCalls', () => {
  it('把带路径的代码块直接包成写文件调用', () => {
    const text = `${PAD}\n\`\`\`python src/main.py\nprint(1)\n\`\`\``;
    const out = directConvertToToolCalls(text, TOOLS, '创建文件');

    expect(out.text).toBe('');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.function.name).toBe('write_to_file');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ filePath: 'src/main.py', content: 'print(1)\n' });
  });

  it('构造型文字不触发（原样返回）', () => {
    const text = '我先读取一下文件，然后再决定。';
    const out = directConvertToToolCalls(text, TOOLS);
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe(text);
  });

  it('没有带路径的代码块时整段包成一个文件', () => {
    // 以 # 开头且长度 > 500 才判定为文件内容
    const text = `# 报告\n${'内容行\n'.repeat(160)}`;
    const out = directConvertToToolCalls(text, TOOLS, '生成报告');
    expect(out.toolCalls).toHaveLength(1);
    const args = argsOf(out.toolCalls[0]!);
    expect(args['filePath']).toBe('报告.md');
    expect(args['content']).toBe(text);
  });

  it('使用客户端真实的写工具名与参数名（驼峰 filePath 也算数）', () => {
    const traeTools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'Write', parameters: { properties: { file_path: {}, content: {} } } },
      },
    ];
    const out = directConvertToToolCalls(
      `${PAD}\n\`\`\`python src/a.py\nx\n\`\`\``,
      traeTools,
    );
    expect(out.toolCalls[0]?.function.name).toBe('Write');
    expect(argsOf(out.toolCalls[0]!)).toEqual({ file_path: 'src/a.py', content: 'x\n' });
  });

  it('CodeBuddy 的驼峰参数名会被正确使用（不再回退成 file_path）', () => {
    const out = directConvertToToolCalls(`${PAD}\n\`\`\`python src/a.py\nx\n\`\`\``, TOOLS);
    expect(argsOf(out.toolCalls[0]!)).toEqual({ filePath: 'src/a.py', content: 'x\n' });
  });
});

describe('collectFilePathsInText', () => {
  it('收集带扩展名的路径并排除 URL', () => {
    const out = collectFilePathsInText('看 /a/b_1.ts 与 https://x.com/c_2.ts');
    expect([...out]).toEqual(['/a/b_1.ts']);
  });

  it('支持中文文件名', () => {
    const out = collectFilePathsInText('见 /docs/文档.md');
    expect([...out]).toEqual(['/docs/文档.md']);
  });

  it('limit 生效', () => {
    const out = collectFilePathsInText('/a/1.ts /b/2.ts /c/3.ts', 2);
    expect(out.size).toBe(2);
  });
});
