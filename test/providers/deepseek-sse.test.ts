/**
 * DeepSeek SSE 解析（`/api/v0/chat/completion`，走 XHR）。
 *
 * ⚠️ 夹具是 **2026-10-16 真机抓到的一个完整回合**（发「只回四个字：收到收到」，
 * 9 个事件、1072 字节），原样贴进来的 —— 别改成手写的样子，
 * 否则「快照里已有部分正文 + APPEND 再补」这个关键语义就丢了。
 */
import { describe, expect, it } from 'vitest';

import { extractDeepseekSse, iterSseEvents } from '../../src/providers/deepseek-sse.js';

/** 真机报文（发「只回四个字：收到收到」）。 */
const REAL_ROUND = `event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":1792152471.328292}

data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"ban_edit":false,"ban_regenerate":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"feedback":null,"inserted_at":1792152471.3190699,"search_enabled":true,"fragments":[{"id":2,"type":"RESPONSE","content":"收到","references":[],"stage_id":1}],"conversation_mode":"DEFAULT","has_pending_fragment":false,"auto_continue":false,"search_triggered":false,"extra_search_providers":[]}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"收到"}

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},{"p":"quasi_status","v":"FINISHED"}]}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":1792152471.501291}

event: title
data: {"content":"收到收到"}

event: close
data: {"click_behavior":"none","auto_resume":false}

`;

describe('extractDeepseekSse', () => {
  it('⭐ 真实回合：快照里的部分正文 + APPEND 增量 = 完整回答', () => {
    const r = extractDeepseekSse(REAL_ROUND);
    // 快照里是「收到」，APPEND 再补「收到」——只取快照或只拼增量都会得到半句
    expect(r.answer).toBe('收到收到');
    expect(r.thinking).toBe('');
    expect(r.finished).toBe(true);
    expect(r.modelType).toBe('default');
    expect(r.messageId).toBe(2);
    expect(r.usageTokens).toBe(41);
  });

  it('⭐⭐ 帧形态三「裸增量」 `{"v":"…"}` 必须累加（2026-10-16 实测事故）', () => {
    /* 事故现场：agent 那轮提示词很大（8k tokens + 20 个工具），
     * 平台推了 **2410 字节**的流，而我们的解析器只吐出 4 个字符 —— 因为长回答里
     * **绝大多数文本走的是「裸增量帧」**（实测 81 帧里有 77 帧是它）：
     *
     *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"先"}
     *   data: {"v":"了解"}      ← 这一种以前被整个丢掉
     *   data: {"v":"项目"}
     *
     * 结果：只剩快照里的「我需要」+ 第一帧的「先」= 4 字，而页面 DOM 上是 169 字
     * （用户报「回复没有获取完全」）。修好后解析结果与 DOM 长度**逐字一致**。 */
    const raw = [
      'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n',
      'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"我需要"}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"先"}\n\n',
      'data: {"v":"了解"}\n\n',
      'data: {"v":"项目"}\n\n',
      'data: {"v":"结构"}\n\n',
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":3365},{"p":"quasi_status","v":"FINISHED"}]}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');

    const r = extractDeepseekSse(raw);
    expect(r.answer).toBe('我需要先了解项目结构');
    expect(r.answer.length).toBeGreaterThan(4); // 事故里就是 4
    expect(r.finished).toBe(true);
    expect(r.usageTokens).toBe(3365);
  });

  it('裸增量帧在思考阶段同样累加（进 thinking 而不是正文）', () => {
    const raw = [
      'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"THINK","content":"先想"}]}}}\n\n',
      'data: {"v":"一下"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ].join('');
    const r = extractDeepseekSse(raw);
    expect(r.thinking).toBe('先想一下');
    expect(r.answer).toBe('');
  });

  it('⭐ 从流中间开始抓（没有快照）：只看 APPEND 也能攒出正文', () => {
    const midStream = [
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"你好"}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，世界"}',
      '',
    ].join('\n');
    const r = extractDeepseekSse(midStream);
    expect(r.answer).toBe('你好，世界');
    expect(r.finished).toBe(false); // 还没收到 FINISHED / close
  });

  it('深度思考：THINK 与 RESPONSE 片段分开（正文不混入思考）', () => {
    const withThink = [
      'data: {"v":{"response":{"message_id":2,"status":"WIP","fragments":[{"type":"THINK","content":"先想一下"},{"type":"RESPONSE","content":""}]}}}',
      '',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"答案"}',
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n');
    const r = extractDeepseekSse(withThink);
    expect(r.answer).toBe('答案');
    expect(r.thinking).toBe('先想一下');
    expect(r.finished).toBe(true);
  });

  it('流没结束（只有 status=WIP 与 update_session）→ finished=false', () => {
    const r = extractDeepseekSse(
      'event: update_session\ndata: {"updated_at":1}\n\ndata: {"p":"response/fragments/-1/content","o":"APPEND","v":"别"}',
    );
    expect(r.answer).toBe('别');
    expect(r.finished).toBe(false);
  });

  it('脏输入不崩（空串 / 非 JSON / 半截帧）', () => {
    expect(extractDeepseekSse('')).toEqual({
      answer: '',
      thinking: '',
      finished: false,
      modelType: '',
      messageId: 0,
      usageTokens: 0,
    });
    expect(extractDeepseekSse('完全不是 SSE').answer).toBe('');
    expect(extractDeepseekSse('data: {半截').answer).toBe('');
    expect(extractDeepseekSse('data: [1,2,3]').answer).toBe('');
  });

  it('iterSseEvents：切出 event/data，多行 data 会拼起来', () => {
    const events = iterSseEvents('event: a\ndata: {"x":1}\n\ndata: 第二行\ndata: 续行\n\n');
    expect(events).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: '', data: '第二行\n续行' },
    ]);
  });
});
