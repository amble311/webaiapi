import { describe, expect, it } from 'vitest';

import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  buildToolProtocol,
  formatMessagesAsText,
  formatToolsAsText,
} from '../../src/tools/protocol.js';
import type { ChatMessage, ToolDefinition } from '../../src/types/message.js';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from disk.',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' }, offset: { type: 'number' } },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      description: 'Write content to a file.',
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
      description: 'Replace a snippet.',
      parameters: {
        type: 'object',
        properties: { filePath: {}, old_str: {}, new_str: {} },
        required: ['filePath', 'old_str', 'new_str'],
      },
    },
  },
];

describe('formatToolsAsText', () => {
  it('没有工具时返回空字符串', () => {
    expect(formatToolsAsText([])).toBe('');
  });

  it('包含工具调用协议的基本骨架', () => {
    const text = formatToolsAsText(TOOLS);
    expect(text).toContain('# 工具调用协议');
    expect(text).toContain(TOOL_CALL_OPEN);
    expect(text).toContain(TOOL_CALL_CLOSE);
    expect(text).toContain('"name": "工具名", "arguments": {"参数名": "参数值"}');
  });

  it('⚠️ 必须显式声明「禁止联网搜索」「第一步必须调用工具」「工具数量」', () => {
    const text = formatToolsAsText(TOOLS);
    expect(text).toContain('不要联网搜索，命令语法也别搜');
    expect(text).toContain('第一步必须调用下方工具');
    expect(text).toContain(`本次对话可用的工具只有下方列出的这 ${TOOLS.length} 个`);
    expect(text).toContain('忽略运行环境自带的其他工具');
  });

  it('⚠️ 2026-10-14：禁止复述协议本身，并声明平台自带代码沙箱不可用', () => {
    const text = formatToolsAsText(TOOLS);
    // 实测模型把协议原句抄进回答（连说三遍「搜索结果与本任务无关，忽略」），整轮空转
    expect(text).toContain('禁止复述本协议');
    expect(text).toContain('execute_sandbox_code');
  });

  it('⚠️ 必须明确否认「存在轮数上限」并禁止用计划代替动作', () => {
    const text = formatToolsAsText(TOOLS);
    expect(text).toContain('本次会话没有工具调用轮数上限');
    expect(text).toContain('禁止用计划代替动作');
    expect(text).toContain('工具轮数已达上限');
  });

  it('工具列表用紧凑格式，必填参数带 *', () => {
    const text = formatToolsAsText(TOOLS);
    expect(text).toContain('- read_file(filePath*, offset)：Read the contents of a file from disk.');
  });

  it('说明超过 80 字符时截断为一行', () => {
    const longDesc = `很长的说明 ${'x'.repeat(200)}`;
    const tools: ToolDefinition[] = [
      { type: 'function', function: { name: 't', description: longDesc, parameters: {} } },
    ];
    const text = formatToolsAsText(tools);
    const line = text.split('\n').find((l) => l.startsWith('- t')) as string;
    expect(line.length).toBeLessThan(100);
    expect(line.endsWith('…')).toBe(true);
  });

  it('说明里的换行会被压成一行', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 't', description: '第一行\n第二行', parameters: {} },
      },
    ];
    expect(formatToolsAsText(tools)).toContain('- t()：第一行 第二行');
  });

  it('注入工作目录', () => {
    const text = formatToolsAsText(TOOLS, { workspacePath: '/opt/my_service' });
    expect(text).toContain('当前项目目录：`/opt/my_service`');
  });

  it('注入已知路径，超过 15 个时提示省略数量', () => {
    const paths = Array.from({ length: 18 }, (_, i) => `/opt/proj/file_${i}.ts`);
    const text = formatToolsAsText(TOOLS, { knownFilePaths: paths });

    expect(text).toContain('对话中已出现的真实路径：');
    expect(text).toContain('`/opt/proj/file_0.ts`');
    expect(text).not.toContain('file_15.ts');
    expect(text).toContain('（另有 3 个路径已省略）');
  });

  it('写/改工具名取自客户端真实工具定义', () => {
    const text = formatToolsAsText(TOOLS);
    expect(text).toContain('修改已有文件用 replace_in_file，创建新文件用 write_to_file');
  });

  it('客户端没有写/改工具时用默认文案（不硬编码成客户端的名字）', () => {
    const onlyRead: ToolDefinition[] = [
      { type: 'function', function: { name: 'read_file', parameters: { properties: { filePath: {} } } } },
    ];
    const text = formatToolsAsText(onlyRead);
    expect(text).toContain('修改已有文件用 SearchReplace，创建新文件用 Write');
  });
});

describe('buildToolProtocol', () => {
  it('一次返回注入文本与映射表', () => {
    const { text, maps } = buildToolProtocol(TOOLS);
    expect(text).toContain('# 工具调用协议');
    expect(maps.name['write']).toBe('write_to_file');
    expect(maps.name['edit']).toBe('replace_in_file');
    expect(maps.name['read']).toBe('read_file');
  });
});

describe('formatMessagesAsText', () => {
  it('按角色拍平成带标记的文本', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ];
    expect(formatMessagesAsText(messages)).toBe('[System]\n你是助手\n\n[User]\n你好\n\n[Assistant]\n你好呀');
  });

  it('assistant 的 tool_calls 序列化成 <tool_call> 块', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"filePath":"/a.ts"}' },
          },
        ],
      },
    ];
    const text = formatMessagesAsText(messages);
    expect(text).toContain('<tool_call>');
    expect(text).toContain('{"name": "read_file", "arguments": {"filePath":"/a.ts"}}');
  });

  it('tool 结果带工具名与 id', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', name: 'read_file', tool_call_id: 'call_1', content: '文件内容' },
    ];
    expect(formatMessagesAsText(messages)).toBe('[Tool Result: read_file (id=call_1)]\n文件内容');
  });

  it('assistant 文本超过 3000 字符时截断并加标记', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'a'.repeat(3500) }];
    const text = formatMessagesAsText(messages);
    expect(text).toContain('... [回复已截断]');
    expect(text.length).toBeLessThan(3100);
  });

  it('tool 结果超过 5000 字符时截断（非 Read 类）', () => {
    const messages: ChatMessage[] = [{ role: 'tool', name: 'grep', content: 'x'.repeat(6000) }];
    const text = formatMessagesAsText(messages);
    expect(text).toContain('[工具结果已截断，原始长度 6000 字符]');
  });

  it('⚠️ Read 类工具结果保留全文（AI 需要完整内容才能生成替换）', () => {
    const content = 'x'.repeat(6000);
    const messages: ChatMessage[] = [{ role: 'tool', name: 'Read', content }];
    const text = formatMessagesAsText(messages);
    expect(text).toContain(content);
    expect(text).not.toContain('已截断');
  });

  it('工具调用参数超长时先按 3000 截断，再受 assistant 文本上限二次截断', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'write_to_file',
              arguments: JSON.stringify({ content: 'y'.repeat(4000) }),
            },
          },
        ],
      },
    ];
    const text = formatMessagesAsText(messages);
    // 参数截断标记本身会被随后的 assistant 上限截掉，最终只看到「回复已截断」
    expect(text).toContain('[回复已截断]');
    expect(text).not.toContain('y'.repeat(3100));
  });

  it('写文件成功后附加「不要再用 write_file 覆盖」提示', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', name: 'write_file', content: 'File written successfully' },
    ];
    expect(formatMessagesAsText(messages)).toContain('文件已完整更新');
  });

  it('替换失败后附加「改用整文件写入」提示', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', name: 'SearchReplace', content: 'Error: old_str not found' },
    ];
    expect(formatMessagesAsText(messages)).toContain('建议改用 write_file');
  });

  it('多模态内容：提取文本并把图片标记为 [Image provided]', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image_url', image_url: { url: 'x' } },
        ],
      },
    ];
    expect(formatMessagesAsText(messages)).toBe('[User]\n看看这张图 [Image provided]');
  });

  it('function 角色结果截断到 3000', () => {
    const messages: ChatMessage[] = [
      { role: 'function', name: 'f', content: 'z'.repeat(4000) },
    ];
    expect(formatMessagesAsText(messages)).toContain('[函数结果已截断，原始长度 4000 字符]');
  });

  it('空列表返回空字符串', () => {
    expect(formatMessagesAsText([])).toBe('');
  });
});
