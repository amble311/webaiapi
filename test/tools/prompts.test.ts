import { describe, expect, it } from 'vitest';

import { RECOVERY_ANSWER_MAX_LEN, buildActionRecoveryPrompt } from '../../src/tools/prompts.js';
import type { ToolDefinition } from '../../src/types/message.js';

/**
 * 唯一一层兜底（动作恢复轮）的提示词。
 *
 * 原来有三套独立兜底：两轮策略 reparse / 自驱动续跑 / 工具名纠正轮，
 * 2026-10-14 合并成这一轮（见 `docs/native-parity.md`）。
 */

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

/** 有命令执行工具的客户端（`execute_sandbox_code` 事故场景）。 */
const BASH_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command',
      parameters: {
        properties: { command: {}, timeout: {}, cwd: {} },
        required: ['command'],
      },
    },
  },
  ...READONLY_TOOLS,
];

describe('buildActionRecoveryPrompt', () => {
  it('⚠️ 工具清单只含客户端真实工具名，绝不硬编码', () => {
    const prompt = buildActionRecoveryPrompt(CODEBUDDY_TOOLS);
    expect(prompt).toContain('# 本次可用的真实工具（只有这些可用）');
    expect(prompt).toContain('- write_to_file(filePath, content): Write content to a file');
    expect(prompt).toContain('- replace_in_file(filePath, old_str, new_str): Replace a snippet');
    // 客户端没有的工具名一个字都不能出现
    expect(prompt).not.toContain('SearchReplace');
    expect(prompt).not.toContain('bash(');
  });

  it('⭐ 点名「客户端没有的工具」（原来由工具名纠正轮负责）', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, {
      invalidNames: ['execute_sandbox_code'],
      invalidCalls: ['execute_sandbox_code({"code":"print(1)"})'],
      answer: '我想跑一下 print(1) 确认环境',
      currentWorkingDir: '/opt/proj',
    });

    expect(prompt).toContain('`execute_sandbox_code`');
    expect(prompt).toContain('本环境不存在的工具');
    expect(prompt).toContain('[你上一轮实际输出的调用]\nexecute_sandbox_code({"code":"print(1)"})');
    expect(prompt).toContain('[你上一轮的回复]\n我想跑一下 print(1) 确认环境');
    expect(prompt).toContain('`/opt/proj`');
  });

  it('⭐ 没有调用时定性为「只有文字/计划」（原来由续跑与 reparse 负责）', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, { answer: '我打算先看看目录' });
    expect(prompt).toContain('没有给出可执行的工具调用');
    expect(prompt).not.toContain('本环境不存在的工具');
  });

  it('⚠️ 只输出工具调用 + 禁占位符 + 禁复述（directive 风格，这一轮要快）', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS);
    expect(prompt).toContain('**只输出工具调用**');
    expect(prompt).toContain('禁止占位符');
    expect(prompt).toContain('也不要复述本段文字');
  });

  it('带最近进展（转换轮据此知道做到哪了）', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, {
      recentProgress: '用户: 把服务重启一下\nAI 调用工具: write_file',
    });
    expect(prompt).toContain('# 最近进展（对话尾部）');
    expect(prompt).toContain('AI 调用工具: write_file');
  });

  it('多个无效工具名去重后点名', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, {
      invalidNames: ['execute_sandbox_code', 'execute_sandbox_code', 'browser_search'],
    });
    expect(prompt).toContain('`execute_sandbox_code`, `browser_search`');
  });

  it('正文为空（整轮只有工具调用块）时也不崩', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, { invalidNames: ['x'] });
    expect(prompt).not.toContain('[你上一轮的回复]');
    expect(prompt).not.toContain('[你上一轮实际输出的调用]');
    expect(prompt).toContain('现在输出工具调用：');
  });

  it('回放的正文超长时截断', () => {
    const prompt = buildActionRecoveryPrompt(BASH_TOOLS, { answer: 'a'.repeat(5000) });
    expect(prompt).toContain('[... 内容已截断 ...]');
    expect(prompt).not.toContain('a'.repeat(RECOVERY_ANSWER_MAX_LEN + 1));
  });

  it('客户端没有任何工具时也不崩', () => {
    const prompt = buildActionRecoveryPrompt([], { currentWorkingDir: '/tmp' });
    expect(prompt).toContain('# 本次可用的真实工具（只有这些可用）');
    expect(prompt).toContain('`/tmp`');
  });
});
