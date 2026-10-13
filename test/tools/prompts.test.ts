import { describe, expect, it } from 'vitest';

import { buildReparsePrompt } from '../../src/tools/prompts.js';
import type { ToolDefinition } from '../../src/types/message.js';

/** CodeBuddy 风格：write_to_file / replace_in_file。 */
const CODEBUDDY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      description: 'Write content to a file',
      parameters: { properties: { filePath: {}, content: {} }, required: ['filePath', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace a snippet',
      parameters: { properties: { filePath: {}, old_str: {}, new_str: {} } },
    },
  },
];

/** 只读客户端：只有 list_dir / read_file / search_content（实测过的事故场景）。 */
const READONLY_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List a directory',
      parameters: { properties: { path: {} }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { properties: { file_path: {} }, required: ['file_path'] },
    },
  },
];

describe('buildReparsePrompt', () => {
  it('⚠️ 工具名清单只含客户端真实工具名', () => {
    const prompt = buildReparsePrompt('AI 的第一轮回复', CODEBUDDY_TOOLS);
    expect(prompt).toContain('本次只有：write_to_file, replace_in_file');
    expect(prompt).toContain('# 可用工具');
    expect(prompt).toContain('- write_to_file(filePath, content): Write content to a file');
  });

  it('⚠️ 示例只用客户端真实存在的工具（不给客户端没有的 Write/SearchReplace 造示例）', () => {
    const prompt = buildReparsePrompt('回复', CODEBUDDY_TOOLS);
    expect(prompt).toContain('"name": "write_to_file"');
    expect(prompt).toContain('"name": "replace_in_file"');
    // 示例块里不能出现客户端没有的工具名
    const examples = prompt.slice(prompt.indexOf('# 输出格式'), prompt.indexOf('# 用户原始请求'));
    expect(examples).not.toContain('"name": "Write"');
    expect(examples).not.toContain('"name": "SearchReplace"');
  });

  it('⚠️ 只读客户端场景：绝不让提示词教模型输出 Write / SearchReplace', () => {
    // 这就是 2026-09-2x 的事故：旧提示词硬编码「工具名必须严格使用 read_file, Write, SearchReplace」，
    // 转换器照着输出 → 客户端没这些工具 → 被 filterUnknownToolCalls 全部丢弃
    const prompt = buildReparsePrompt('回复', READONLY_TOOLS);
    const examples = prompt.slice(prompt.indexOf('# 输出格式'), prompt.indexOf('# 用户原始请求'));

    expect(prompt).toContain('本次只有：list_dir, read_file');
    expect(examples).not.toContain('"name": "Write"');
    expect(examples).not.toContain('"name": "SearchReplace"');
    // 用第一个真实工具 + 它真实的必填参数名给示例
    expect(examples).toContain('"name": "list_dir"');
    expect(examples).toContain('"path"');
  });

  it('文件类操作建议只在客户端确实提供写/改工具时才给', () => {
    const withBoth = buildReparsePrompt('回复', CODEBUDDY_TOOLS);
    expect(withBoth).toContain('必须用 replace_in_file 修改，不要用 write_to_file 覆盖');

    const readonly = buildReparsePrompt('回复', READONLY_TOOLS);
    expect(readonly).not.toContain('必须用 replace_in_file 修改');
  });

  it('注入用户原始请求与第一轮回复', () => {
    const prompt = buildReparsePrompt('这是第一轮内容', CODEBUDDY_TOOLS, {
      userRequest: '请创建配置文件',
    });
    expect(prompt).toContain('# 用户原始请求\n请创建配置文件');
    expect(prompt).toContain('# AI的回复（需要转换为工具调用）\n这是第一轮内容');
  });

  it('第一轮回复超过 8000 字符时截断', () => {
    const prompt = buildReparsePrompt('a'.repeat(9000), CODEBUDDY_TOOLS);
    expect(prompt).toContain('[... 内容已截断 ...]');
    expect(prompt).not.toContain('a'.repeat(8001));
  });

  it('注入当前工作目录', () => {
    const prompt = buildReparsePrompt('回复', CODEBUDDY_TOOLS, {
      currentWorkingDir: '/opt/my_service',
    });
    expect(prompt).toContain('**当前工作目录**：`/opt/my_service`');
  });

  it('从对话历史/请求/回复里收集真实路径并注入（最多 10 条）', () => {
    const prompt = buildReparsePrompt('我改了 /opt/proj/src/a.ts', CODEBUDDY_TOOLS, {
      userRequest: '看下 /opt/proj/src/b.ts',
      conversationHistory: '工具结果：file_path: /opt/proj/src/c.ts',
    });

    expect(prompt).toContain('**对话中提到的真实文件路径**');
    expect(prompt).toContain('- /opt/proj/src/a.ts');
    expect(prompt).toContain('- /opt/proj/src/b.ts');
    expect(prompt).toContain('- /opt/proj/src/c.ts');
  });

  it('没有路径时给出相对路径的兜底指引', () => {
    const prompt = buildReparsePrompt('回复', CODEBUDDY_TOOLS, { currentWorkingDir: '/tmp' });
    expect(prompt).not.toContain('**对话中提到的真实文件路径**');
    expect(prompt).toContain('如果对话中没有提到具体路径');
  });

  it('包含禁止输出占位符的强指令', () => {
    const prompt = buildReparsePrompt('回复', CODEBUDDY_TOOLS);
    expect(prompt).toContain('绝对禁止输出占位符/示例文本');
    expect(prompt).toContain('不得编造');
  });

  it('客户端没有任何工具时也不崩', () => {
    const prompt = buildReparsePrompt('回复', [], { currentWorkingDir: '/tmp' });
    expect(prompt).toContain('（见下方可用工具）');
    expect(prompt).toContain('# 用户原始请求');
  });
});
