import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type Choice,
  displayWidth,
  firstSelectableIndex,
  padDisplay,
  renderChoiceList,
  resolveChoiceInput,
  supportsColor,
  tokenizeKeys,
} from '../../src/utils/prompt.js';

/**
 * 只测**纯函数内核**（列表渲染 + 输入解析）。
 *
 * 理由：真正会出 bug 的是这些分支判断（空输入选哪个、越界怎么办、
 * disabled 项被选中怎么办），而 TTY/raw mode 那层在 CI 里**没法可靠复现**
 * —— 伪造 TTY 的测试又慢又脆，反而掩盖问题。
 */

/** 测试里固定关掉颜色，否则断言要带上 ANSI 转义序列。 */
beforeEach(() => {
  process.env['NO_COLOR'] = '1';
});

afterEach(() => {
  delete process.env['NO_COLOR'];
});

const CHOICES: Choice<string>[] = [
  { value: 'chatglm', label: 'ChatGLM (智谱)', hint: '2 个账号 · 可对话' },
  { value: 'deepseek', label: 'DeepSeek', hint: '尚未登录' },
  { value: 'qianwen', label: '通义千问', disabled: '暂未实现对话' },
];

describe('resolveChoiceInput', () => {
  it('空输入 → 默认项（未指定默认时是第 1 项）', () => {
    expect(resolveChoiceInput('', CHOICES)).toEqual({ kind: 'ok', index: 0 });
    expect(resolveChoiceInput('   ', CHOICES)).toEqual({ kind: 'ok', index: 0 });
  });

  it('空输入 → 指定的默认项', () => {
    expect(resolveChoiceInput('', CHOICES, 1)).toEqual({ kind: 'ok', index: 1 });
  });

  it('数字按 1 起算', () => {
    expect(resolveChoiceInput('1', CHOICES)).toEqual({ kind: 'ok', index: 0 });
    expect(resolveChoiceInput('2', CHOICES)).toEqual({ kind: 'ok', index: 1 });
    // 前后空格容忍（从管道读进来常带 \r）
    expect(resolveChoiceInput(' 2 ', CHOICES)).toEqual({ kind: 'ok', index: 1 });
  });

  it('q / Q → 取消', () => {
    expect(resolveChoiceInput('q', CHOICES)).toEqual({ kind: 'cancel' });
    expect(resolveChoiceInput('Q', CHOICES)).toEqual({ kind: 'cancel' });
  });

  it('编号越界 → retry（并说明可选范围）', () => {
    const result = resolveChoiceInput('4', CHOICES);
    expect(result.kind).toBe('retry');
    expect(result.kind === 'retry' && result.reason).toContain('1~3');
  });

  it('0 与负数都不是合法编号', () => {
    expect(resolveChoiceInput('0', CHOICES).kind).toBe('retry');
    expect(resolveChoiceInput('-1', CHOICES).kind).toBe('retry');
  });

  it('非数字 → retry', () => {
    const result = resolveChoiceInput('abc', CHOICES);
    expect(result.kind).toBe('retry');
    expect(result.kind === 'retry' && result.reason).toContain('abc');
  });

  it('⭐ 选中 disabled 项 → retry，且**带上不可选原因**', () => {
    const result = resolveChoiceInput('3', CHOICES);
    expect(result.kind).toBe('retry');
    // 非 TTY 下用户看不到「不可选」的视觉提示，必须明确告诉他原因
    expect(result.kind === 'retry' && result.reason).toContain('暂未实现对话');
    expect(result.kind === 'retry' && result.reason).toContain('通义千问');
  });
});

describe('firstSelectableIndex', () => {
  it('跳过开头的 disabled 项', () => {
    expect(
      firstSelectableIndex([
        { value: 'a', label: 'A', disabled: '原因' },
        { value: 'b', label: 'B' },
      ]),
    ).toBe(1);
  });

  it('全部不可选时返回 0（不返回 -1，避免调用方拿到越界下标）', () => {
    expect(firstSelectableIndex([{ value: 'a', label: 'A', disabled: '原因' }])).toBe(0);
  });
});

describe('renderChoiceList', () => {
  it('每项一行，带编号', () => {
    const lines = renderChoiceList(CHOICES, 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('1.');
    expect(lines[2]).toContain('3.');
  });

  it('⭐ 只有选中项带 ❯ 指针', () => {
    const lines = renderChoiceList(CHOICES, 1);
    expect(lines[1]).toContain('❯');
    expect(lines[0]).not.toContain('❯');
    expect(lines[2]).not.toContain('❯');
  });

  it('hint 与 disabled 原因都会显示；disabled 用 ✗ 区分', () => {
    const lines = renderChoiceList(CHOICES, 0);
    expect(lines[0]).toContain('2 个账号');
    expect(lines[2]).toContain('✗ 暂未实现对话');
  });

  it('numbered=false 时不出现编号（用于「已选定」的回显）', () => {
    const lines = renderChoiceList(CHOICES, 0, { numbered: false });
    expect(lines[0]).not.toMatch(/\d+\./);
  });
});

describe('supportsColor', () => {
  it('设了 NO_COLOR 就不上色（避免重定向到文件时写进转义序列）', () => {
    expect(supportsColor()).toBe(false);
  });

  it('渲染结果里不含 ANSI 转义', () => {
    const lines = renderChoiceList(CHOICES, 0);
    for (const line of lines) expect(line).not.toContain('\u001b[');
  });
});

describe('displayWidth / padDisplay', () => {
  it('ASCII 一个字符一列', () => {
    expect(displayWidth('abc')).toBe(3);
  });

  it('⭐ 中文 / 全角占两列（`padEnd` 会数错）', () => {
    expect(displayWidth('智谱')).toBe(4);
    expect(displayWidth('（全角）')).toBe(8);
    // 这正是 `padEnd` 出错的地方：'智谱'.length === 2，但占 4 列
    expect('智谱'.length).toBe(2);
  });

  it('按显示宽度补齐 → 中英混排能对齐', () => {
    const a = padDisplay('ChatGLM (智谱)', 18);
    const b = padDisplay('DeepSeek', 18);
    expect(displayWidth(a)).toBe(18);
    expect(displayWidth(b)).toBe(18);
  });

  it('超宽时不截断（宁可不齐，也不要吃掉内容）', () => {
    expect(padDisplay('很长很长很长很长的名字', 4)).toBe('很长很长很长很长的名字');
  });
});

/* ==================================================================== */
/* 按键解析                                                             */
/* ==================================================================== */

describe('tokenizeKeys', () => {
  const kinds = (input: string, flush = false): string[] =>
    tokenizeKeys(input, { flushTrailingEscape: flush }).tokens.map((t) => t.kind);

  it('单个按键', () => {
    expect(kinds('\u001b[A')).toEqual(['up']);
    expect(kinds('\u001b[B')).toEqual(['down']);
    expect(kinds('\u001bOA')).toEqual(['up']); // 部分终端用 SS3 形式
    expect(kinds('\r')).toEqual(['enter']);
    expect(kinds('\n')).toEqual(['enter']);
    expect(kinds('\u0003')).toEqual(['sigint']);
  });

  it('⭐ 一个 chunk 里的**多个**按键全部解析出来', () => {
    // 连按方向键 / 粘贴 / pty 转发都会出现这种 chunk。
    // 旧实现用 switch 精确匹配整块 → 除第一个外全部被静默丢弃
    expect(kinds('\u001b[B\u001b[B')).toEqual(['down', 'down']);
    expect(kinds('\u001b[B\r')).toEqual(['down', 'enter']);
    expect(kinds('\u001b[A\u001b[B\u001b[A')).toEqual(['up', 'down', 'up']);
  });

  it('普通字符逐个成 token（数字键跳转要用）', () => {
    expect(kinds('12')).toEqual(['char', 'char']);
    const tokens = tokenizeKeys('2').tokens;
    expect(tokens[0]).toEqual({ kind: 'char', value: '2' });
  });

  it('⭐ 被切开的转义序列留在 rest 里，不误判为按键', () => {
    const first = tokenizeKeys('\u001b');
    expect(first.tokens).toEqual([]);
    expect(first.rest).toBe('\u001b');

    const second = tokenizeKeys('\u001b[');
    expect(second.tokens).toEqual([]);
    expect(second.rest).toBe('\u001b[');
  });

  it('⭐ 拼接两个 chunk 后能解析出方向键（跨 chunk 的按键不能丢）', () => {
    const first = tokenizeKeys('a\u001b');
    expect(first.tokens).toEqual([{ kind: 'char', value: 'a' }]);
    expect(first.rest).toBe('\u001b');

    const second = tokenizeKeys(`${first.rest}[B`);
    expect(second.tokens).toEqual([{ kind: 'down' }]);
    expect(second.rest).toBe('');
  });

  it('⭐ 收尾解析时把孤立的 ESC 判成取消（否则单独按 Esc 会永久挂住）', () => {
    expect(kinds('\u001b', true)).toEqual(['cancel']);
    expect(kinds('\u001b[', true)).toEqual(['cancel']);
  });

  it('完整但未识别的 ESC 序列 → 取消，且不吞掉后面的按键', () => {
    // `\u001bZ` 是 Alt+Z 这类的字节形态：整体判成「取消」，但 Z 本身仍是字符
    // （调用方在收到 cancel 时已经结束，后续 token 会被丢弃，所以没有副作用）。
    expect(kinds('\u001bZ')).toEqual(['cancel', 'char']);
    // 关键点：后面的 `\r` 仍然被解析出来（没有把剩余输入整段吞掉）
    expect(kinds('\u001bZ\r')).toEqual(['cancel', 'char', 'enter']);
  });

  it('⭐ 其它 CSI 序列（Home/End/PageUp）整段吃掉，不能变成字符输入', () => {
    // 否则 `[` `3` `~` 会当成普通字符，可能在列表里触发莫名其妙的跳转
    expect(kinds('\u001b[3~')).toEqual([]);
    expect(kinds('\u001b[H')).toEqual([]);
    expect(kinds('\u001b[3~\r')).toEqual(['enter']);
  });

  it('Ctrl+D 当作取消（多数终端下等于 EOF）', () => {
    expect(kinds('\u0004')).toEqual(['cancel']);
  });

  it('其它控制字符被丢弃', () => {
    expect(kinds('\u0000\u0007')).toEqual([]);
    expect(kinds('\u0007\r')).toEqual(['enter']);
  });

  it('空输入返回空', () => {
    expect(tokenizeKeys('')).toEqual({ tokens: [], rest: '' });
  });
});
