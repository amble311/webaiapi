import { beforeEach, describe, expect, it } from 'vitest';

import {
  countPlatformToolCalls,
  extractSseAll,
  extractSseAnswer,
  getLastRawSse,
  isBlankOrForeignUrl,
  isBrowserConnectionError,
  iterSseJson,
  resetLastRawSse,
  pickTextSemantics,
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


/**
 * 正文的两种流语义（2026-10-15 事故回归）。
 *
 * 事故：同一 `logic_id` 下发 124 个 1~32 字符的片段，旧的「只取最长的那一个片段」
 * 把 2032 字的完整回答丢成 37 字的表格残句 → 没有工具调用 → 客户端收到残句 + stop
 * → 用户看到「对话无故停止」。
 */
describe('正文语义：增量 / 快照（pickTextSemantics + extractSseAll）', () => {
  it('⭐ 增量流：碎片拼起来才是完整回答（按今天的真实片段形状）', () => {
    const fragments = [
      '根据', '协议', '要求', '，', '我', '第一步', '必须', '调用', '读取', '工具', '，',
      '但当前环境**没有提供本地文件系统访问权限**（无 `list',
      '_dir` / `read_file` 等真实工具可用），',
      '无法直接操作 `/home/amble/object/btc',
      '` 目录。',
    ];
    const raw = fragments.map((t) => contentEvt('lid-inc', [{ type: 'text', text: t }])).join('');

    const r = extractSseAll(raw);
    expect(r.answer).toBe(fragments.join(''));
    expect(r.answer).toContain('没有提供本地文件系统访问权限');
  });

  it('⭐ 快照流：草稿 + 整段改写 → 只取最终那份（绝不能拼成「草稿+最终」）', () => {
    const draft = `草稿：${'甲'.repeat(300)}`;
    const final = `最终答案：${'乙'.repeat(500)}`;
    const raw =
      contentEvt('lid-snap', [{ type: 'text', text: draft }]) +
      contentEvt('lid-snap', [{ type: 'text', text: final }]);

    const r = extractSseAll(raw);
    expect(r.answer).toBe(final);
    expect(r.answer).not.toContain('草稿');
  });

  it('快照流：新版本以旧版本为前缀（整段扩展）→ 取新版，不重复拼接', () => {
    const draft = 'A'.repeat(200);
    const final = `${draft}${'B'.repeat(200)}`;
    const raw =
      contentEvt('lid-ext', [{ type: 'text', text: draft }]) +
      contentEvt('lid-ext', [{ type: 'text', text: final }]);

    const r = extractSseAll(raw);
    expect(r.answer).toBe(final);
    expect(r.answer.length).toBe(400);
  });

  it('平台把同一份快照重复下发 → 不能重复拼接', () => {
    const once = 'X'.repeat(300);
    const raw =
      contentEvt('lid-dup', [{ type: 'text', text: once }]) +
      contentEvt('lid-dup', [{ type: 'text', text: once }]);

    expect(extractSseAll(raw).answer).toBe(once);
  });

  it('单个片段（最常见的形态）→ 原样返回', () => {
    const raw = contentEvt('lid-one', [{ type: 'text', text: '只回四个字：收到收到' }]);
    expect(extractSseAll(raw).answer).toBe('只回四个字：收到收到');
  });

  it('多个 logic_id（不同草稿）→ 取最长的那一份，不跨组拼接', () => {
    const short = '短草稿';
    const long = `长草稿${'丙'.repeat(120)}`;
    const raw =
      contentEvt('lid-a', [{ type: 'text', text: short }]) +
      contentEvt('lid-b', [{ type: 'text', text: long }]);

    expect(extractSseAll(raw).answer).toBe(long);
  });

  it('pickTextSemantics 判定表', () => {
    const g = (joined: string, longest: string, count: number, sawSnapshot = false) => ({
      joined,
      longest,
      count,
      sawSnapshot,
    });
    // 单片段
    expect(pickTextSemantics(g('abc', 'abc', 1))).toBe('abc');
    // 大量小碎片 → 增量
    expect(pickTextSemantics(g('x'.repeat(2000), 'x'.repeat(31), 124))).toBe('x'.repeat(2000));
    // 快照信号 → 取最长
    expect(pickTextSemantics(g('x'.repeat(600), 'x'.repeat(400), 2, true))).toBe('x'.repeat(400));
    // 少量大片段（草稿+最终）→ 取最长
    expect(pickTextSemantics(g('x'.repeat(800), 'x'.repeat(500), 2))).toBe('x'.repeat(500));
  });
});

/**
 * 平台自带工具的计数（提前收尾判据用的信号）。
 *
 * ⚠️ 实测出现过的名字：`search` / `open` / `execute_sandbox_code` / **`retrieve`**
 * （2026-10-15：单轮 6~9 次 retrieve，跑去查 v2rayN 代理配置，白烧 145s）。
 */
describe('countPlatformToolCalls', () => {
  it('排除 finish（每轮正常收尾都会推）', () => {
    expect(countPlatformToolCalls({ finish: 193 })).toBe(0);
    expect(countPlatformToolCalls({ search: 57, finish: 64 })).toBe(57);
  });

  it('⭐ retrieve / 沙箱 / 浏览器类工具同样计入', () => {
    expect(countPlatformToolCalls({ retrieve: 6, finish: 3 })).toBe(6);
    expect(countPlatformToolCalls({ execute_sandbox_code: 57, finish: 64 })).toBe(57);
    expect(countPlatformToolCalls({ open: 52 })).toBe(52);
    expect(countPlatformToolCalls({ search: 3, open: 2, retrieve: 1, finish: 9 })).toBe(6);
  });

  it('空表 / 脏值不崩', () => {
    expect(countPlatformToolCalls({})).toBe(0);
    expect(
      countPlatformToolCalls({ a: 0, b: -1, c: Number.NaN, d: 2 } as Record<string, number>),
    ).toBe(2);
  });
});
