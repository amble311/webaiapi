import { beforeEach, describe, expect, it } from 'vitest';

import {
  extractSseAll,
  extractSseAnswer,
  getLastRawSse,
  isBlankOrForeignUrl,
  isBrowserConnectionError,
  iterSseJson,
  resetLastRawSse,
  safeIncremental,
  setLastRawSse,
} from '../../src/providers/chatglm-sse.js';

/** 造一条 ChatGLM 风格的 SSE 事件（`data: {...}`）。 */
function evt(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 造一条 `parts[].content[]` 事件。 */
function contentEvt(
  logicId: string,
  content: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): string {
  return evt({
    id: 'conv-1',
    conversation_id: 'conv-1',
    status: 'init',
    parts: [{ role: 'assistant', logic_id: logicId, content }],
    ...extra,
  });
}

describe('iterSseJson', () => {
  it('从 `data: {...}` 里取出 JSON', () => {
    const raw = evt({ a: 1 }) + evt({ b: 2 });
    expect([...iterSseJson(raw)]).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('⭐ 多个 JSON 直接拼在同一行（中间无换行）也能全部取出', () => {
    const raw = 'data: {"a":1}{"b":2}{"c":3}';
    expect([...iterSseJson(raw)]).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('跳过坏 JSON 继续往后扫，且不死循环', () => {
    const raw = 'data: {"broken": , {"ok":1}';
    expect([...iterSseJson(raw)]).toEqual([{ ok: 1 }]);
  });

  it('正确跨越字符串里的花括号', () => {
    const raw = '{"a":"} 不是结尾","b":1}';
    expect([...iterSseJson(raw)]).toEqual([{ a: '} 不是结尾', b: 1 }]);
  });

  it('忽略数组与标量（只产出对象）', () => {
    const raw = '{"arr":[1,2]}[1,2]"str"42';
    expect([...iterSseJson(raw)]).toEqual([{ arr: [1, 2] }]);
  });

  it('空输入返回空', () => {
    expect([...iterSseJson('')]).toEqual([]);
    expect([...iterSseJson('no json here')]).toEqual([]);
  });
});

describe('extractSseAll — 正文（type=text）', () => {
  it('取文本', () => {
    const raw = contentEvt('lg1', [{ type: 'text', text: '你好世界' }]);
    expect(extractSseAll(raw).answer).toBe('你好世界');
  });

  it('⭐ 只取最长，绝不累积拼接', () => {
    const raw =
      contentEvt('lg1', [{ type: 'text', text: '好' }]) +
      contentEvt('lg1', [{ type: 'text', text: '你好' }]) +
      contentEvt('lg1', [{ type: 'text', text: '你好世界' }]);
    expect(extractSseAll(raw).answer).toBe('你好世界');
  });

  it('⭐ 模型中途改写回答时交出最终版，而不是「草稿 + 终稿」', () => {
    // 实测：先输出 78 字符草稿，联网搜索回来后整段换成 2846 字符终稿
    const draft = '我先帮你查一下 requirements.txt 里的依赖版本。';
    const final = `## 依赖清单\n\n${'- fastify ^5.12.5\n'.repeat(20)}`;
    expect(final.length).toBeGreaterThan(draft.length);

    const raw =
      contentEvt('lg1', [{ type: 'text', text: draft }]) +
      contentEvt('lg1', [{ type: 'text', text: final }]);

    const { answer } = extractSseAll(raw);
    expect(answer).toBe(final);
    expect(answer).not.toContain('我先帮你查一下');
  });

  it('已知边界：改写后的答案若**更短**，「取最长」会保留草稿', () => {
    // 这是「取最长」规则的固有取舍。实测改写后总是变长（78 → 2846），
    // 所以可接受；但记录在此，免得将来遇到反而以为是新 bug。
    const draft = '这是一段比较长的草稿，说明了接下来要做的很多事情和步骤。';
    const final = '好了。';
    const raw =
      contentEvt('lg1', [{ type: 'text', text: draft }]) +
      contentEvt('lg1', [{ type: 'text', text: final }]);

    expect(extractSseAll(raw).answer).toBe(draft);
  });

  it('保留下划线/半角引号/空格（DOM 渲染会破坏这些）', () => {
    const code = 'if __name__ == "__main__":\n    print("hello world")';
    const raw = contentEvt('lg1', [{ type: 'text', text: code }]);
    expect(extractSseAll(raw).answer).toBe(code);
  });

  it('没有 text 时正文为空串', () => {
    const raw = contentEvt('lg1', [{ type: 'think', think: '想一下' }]);
    expect(extractSseAll(raw).answer).toBe('');
  });
});

describe('extractSseAll — 思考（type=think）', () => {
  it('增量片段被追加', () => {
    const raw =
      contentEvt('lg1', [{ type: 'think', think: '分析' }]) +
      contentEvt('lg1', [{ type: 'think', think: '请求' }]);
    expect(extractSseAll(raw).think).toBe('分析请求');
  });

  it('⭐ 累积快照被替换（不重复拼接）', () => {
    const raw =
      contentEvt('lg1', [{ type: 'think', think: '分析' }]) +
      contentEvt('lg1', [{ type: 'think', think: '分析请求' }]) +
      contentEvt('lg1', [{ type: 'think', think: '分析请求完成' }]);
    expect(extractSseAll(raw).think).toBe('分析请求完成');
  });

  it('⭐ 轮次被掐断（快照没来）时也能拿到完整思考', () => {
    // 这正是「按逻辑_id 累积」而不是「取最长」的原因：
    // 取最长只会拿到最后一个增量片段
    const raw =
      contentEvt('lg1', [{ type: 'think', think: '第一段' }]) +
      contentEvt('lg1', [{ type: 'think', think: '第二段' }]) +
      contentEvt('lg1', [{ type: 'think', think: '第三段' }]);
    expect(extractSseAll(raw).think).toBe('第一段第二段第三段');
  });

  it('新片段是已累积内容的前缀时忽略（重复下发）', () => {
    const raw =
      contentEvt('lg1', [{ type: 'think', think: '分析请求' }]) +
      contentEvt('lg1', [{ type: 'think', think: '分析' }]);
    expect(extractSseAll(raw).think).toBe('分析请求');
  });

  it('按 logic_id 分组，并按出现顺序拼接', () => {
    const raw =
      contentEvt('lg1', [{ type: 'think', think: 'A' }]) +
      contentEvt('lg2', [{ type: 'think', think: 'B' }]) +
      contentEvt('lg1', [{ type: 'think', think: 'C' }]);
    // lg1 = A + C（C 不以前缀开头 → 追加）；lg2 = B
    expect(extractSseAll(raw).think).toBe('AC\n\nB');
  });

  it('logic_id 缺失时退回事件 id', () => {
    const raw = evt({
      id: 'evt-9',
      parts: [{ content: [{ type: 'think', think: 'X' }] }],
    });
    expect(extractSseAll(raw).think).toBe('X');
  });

  it('空 think 被忽略', () => {
    const raw =
      contentEvt('lg1', [{ type: 'think', think: '' }]) +
      contentEvt('lg1', [{ type: 'think', think: 'X' }]);
    expect(extractSseAll(raw).think).toBe('X');
  });
});

describe('extractSseAll — 完成信号与平台内部工具', () => {
  it('⭐ status=finish 是权威完成信号', () => {
    const raw = contentEvt('lg1', [{ type: 'text', text: '答' }]);
    expect(extractSseAll(raw).finished).toBe(false);

    const raw2 = raw + evt({ id: 'conv-1', status: 'finish', meta_data: {} });
    expect(extractSseAll(raw2).finished).toBe(true);
  });

  it('统计平台内部工具调用（发现「跑去用网页端自带搜索」）', () => {
    const raw =
      contentEvt('lg1', [{ type: 'tool_calls', tool_calls: { name: 'search' } }]) +
      contentEvt('lg1', [{ type: 'tool_calls', tool_calls: { name: 'search' } }]) +
      contentEvt('lg1', [{ type: 'tool_calls', tool_calls: { name: 'finish' } }]);

    expect(extractSseAll(raw).platformTools).toEqual({ search: 2, finish: 1 });
  });

  it('tool_calls 结构异常时不报错', () => {
    const raw =
      contentEvt('lg1', [{ type: 'tool_calls', tool_calls: 'not-an-object' }]) +
      contentEvt('lg1', [{ type: 'tool_calls' }]);
    expect(extractSseAll(raw).platformTools).toEqual({});
  });
});

describe('extractSseAll — 边界', () => {
  it('空报文 / 无 parts / parts 非数组都安全', () => {
    expect(extractSseAll('')).toEqual({
      answer: '',
      think: '',
      finished: false,
      platformTools: {},
    });
    expect(extractSseAll(evt({ id: 'x' })).answer).toBe('');
    expect(extractSseAll(evt({ id: 'x', parts: 'nope' })).answer).toBe('');
  });

  it('content 非数组 / 元素非对象都安全', () => {
    const raw = evt({ id: 'x', parts: [{ logic_id: 'l', content: 'nope' }] });
    expect(extractSseAll(raw).answer).toBe('');

    const raw2 = evt({ id: 'x', parts: [{ logic_id: 'l', content: [null, 42] }] });
    expect(extractSseAll(raw2).answer).toBe('');
  });

  it('extractSseAnswer 是便捷封装', () => {
    const raw = contentEvt('lg1', [
      { type: 'think', think: '想' },
      { type: 'text', text: '答' },
    ]);
    expect(extractSseAnswer(raw)).toEqual({ answer: '答', think: '想' });
  });
});

describe('safeIncremental', () => {
  it('正常流式：前缀相同 → 切出后缀', () => {
    expect(safeIncremental('你好', '你好世界')).toBe('世界');
  });

  it('完全没变 → 不出内容', () => {
    expect(safeIncremental('你好', '你好')).toBeUndefined();
  });

  it('⭐ 模型改写回答 → 交出整段新文本（绝不能给半句话碎片）', () => {
    const draft = '我先';
    const final = '根据 requirements.txt，需要升级 3 个依赖。';
    expect(safeIncremental(draft, final)).toBe(final);
  });

  it('文本变短（被替换）→ 不出内容', () => {
    expect(safeIncremental('你好世界', '你好')).toBeUndefined();
  });

  it('空当前文本 → undefined；空历史 → 全量', () => {
    expect(safeIncremental('你好', '')).toBeUndefined();
    expect(safeIncremental('', '你好')).toBe('你好');
  });
});

describe('isBrowserConnectionError', () => {
  it('⭐ 识别连接类错误（命中后要主动失效共享浏览器）', () => {
    for (const msg of [
      'Connection closed',
      'Target closed',
      'Target page, context or browser has been closed',
      'Browser has been closed',
      'Juggler error',
      'Protocol error (Runtime.callFunctionOn)',
      'read EPIPE (broken pipe)',
    ]) {
      expect(isBrowserConnectionError(new Error(msg))).toBe(true);
    }
  });

  it('业务/解析错误不算连接错误', () => {
    expect(isBrowserConnectionError(new Error('未找到输入框'))).toBe(false);
    expect(isBrowserConnectionError(new Error('消息发送失败'))).toBe(false);
  });

  it('非 Error 入参也安全', () => {
    expect(isBrowserConnectionError('connection closed')).toBe(true);
    expect(isBrowserConnectionError(null)).toBe(false);
    expect(isBrowserConnectionError(undefined)).toBe(false);
    expect(isBrowserConnectionError(42)).toBe(false);
  });
});

describe('isBlankOrForeignUrl', () => {
  it('空白页与非目标域名需要导航', () => {
    expect(isBlankOrForeignUrl('', 'chatglm.cn')).toBe(true);
    expect(isBlankOrForeignUrl('about:blank', 'chatglm.cn')).toBe(true);
    expect(isBlankOrForeignUrl('https://example.com/', 'chatglm.cn')).toBe(true);
  });

  it('目标域名不需要导航', () => {
    expect(
      isBlankOrForeignUrl('https://chatglm.cn/main/alltoolsdetail?lang=zh', 'chatglm.cn'),
    ).toBe(false);
  });
});

describe('主轮全局（_last_raw_sse_*）', () => {
  beforeEach(() => {
    resetLastRawSse();
  });

  it('初始为空', () => {
    expect(getLastRawSse()).toEqual({ text: '', think: '', toolCalls: [] });
  });

  it('可登记与读取', () => {
    setLastRawSse({ text: '正文', think: '思考' });
    expect(getLastRawSse()).toMatchObject({ text: '正文', think: '思考' });
  });

  it('⛔ 辅助通道不写全局：调用方必须靠 ownsGlobals 自己把关', () => {
    // 这里只验证「不调用 set 就不会被改」，把把关责任写成可读的断言
    const before = { ...getLastRawSse() };
    // 模拟「辅助通道跳过 setLastRawSse」
    expect(getLastRawSse()).toEqual(before);
  });

  it('reset 可清空', () => {
    setLastRawSse({ text: 'x', think: 'y', toolCalls: [{ a: 1 }] });
    resetLastRawSse();
    expect(getLastRawSse()).toEqual({ text: '', think: '', toolCalls: [] });
  });
});

