/**
 * ChatGPT 网页版对话流的解析（2026-10-19）。
 *
 * 夹具 `fixtures/chatgpt-conversation.txt` 是按**真实捕获的形状**逐帧写的：
 * 真实那轮里助手正文是 `{"v":{"message":{…"parts":["收到收到"]}}}` 一帧给出的；
 * 这里刻意改成 3 个 `append` 补丁来覆盖**流式增量**那条路径（真实长回答就是这么推的）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractChatgptSse, splitSseFrames } from '../../src/providers/chatgpt-sse.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, 'fixtures', 'chatgpt-conversation.txt'), 'utf8');

describe('splitSseFrames', () => {
  it('按空行分帧，支持多行 data', () => {
    const frames = splitSseFrames('event: delta\ndata: a\ndata: b\n\nevent: done\n');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: 'delta', data: 'a\nb' });
    expect(frames[1]?.event).toBe('done');
  });
});

describe('extractChatgptSse', () => {
  it('⭐ 流式 append 补丁 → 拼出完整正文，并识别结束', () => {
    const result = extractChatgptSse(FIXTURE);

    expect(result.answer).toBe('递归是函数自己调用自己。');
    expect(result.finished).toBe(true);
    expect(result.conversationId).toBe('6ad61833-9e3c-83e8-981f-05935a013a49');
  });

  it('⭐ 单帧给出正文（真实那次就是这样：parts:["收到收到"]）', () => {
    const raw = [
      'event: delta',
      'data: {"v":{"message":{"id":"a1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["收到收到"]},"status":"finished_successfully","end_turn":true}}}',
      '',
      'data: [DONE]',
    ].join('\n');

    const result = extractChatgptSse(raw);
    expect(result.answer).toBe('收到收到');
    expect(result.finished).toBe(true);
  });

  it('未结束（status=in_progress、没有 [DONE]）→ finished=false（provider 据此继续等）', () => {
    const raw = [
      'event: delta',
      'data: {"v":{"message":{"id":"a1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["半句"]},"status":"in_progress","end_turn":null}}}',
    ].join('\n');

    const result = extractChatgptSse(raw);
    expect(result.answer).toBe('半句');
    expect(result.finished).toBe(false);
  });

  it('只取**助手**正文：用户消息、system 空消息、model_editable_context 都不算', () => {
    const raw = [
      'event: delta',
      'data: {"v":{"message":{"id":"u1","author":{"role":"user"},"content":{"content_type":"text","parts":["这是用户说的话"]},"status":"finished_successfully","end_turn":true}}}',
      '',
      'event: delta',
      'data: {"v":{"message":{"id":"s1","author":{"role":"system"},"content":{"content_type":"text","parts":[""]},"status":"finished_successfully","end_turn":true}}}',
      '',
      'event: delta',
      'data: {"v":{"message":{"id":"a1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["助手回答"]},"status":"finished_successfully","end_turn":true}}}',
    ].join('\n');

    expect(extractChatgptSse(raw).answer).toBe('助手回答');
  });

  it('坏帧 / 非 JSON 的 data 不会崩', () => {
    const raw = [
      'data: {broken json',
      '',
      'data: "v1"',
      '',
      'event: delta',
      'data: {"v":{"message":{"id":"a1","author":{"role":"assistant"},"content":{"content_type":"text","parts":["ok"]},"status":"finished_successfully","end_turn":true}}}',
    ].join('\n');

    const result = extractChatgptSse(raw);
    expect(result.answer).toBe('ok');
    expect(result.finished).toBe(true);
  });

  it('空输入 → 全空，不抛', () => {
    expect(extractChatgptSse('')).toEqual({
      answer: '',
      thinking: '',
      finished: false,
      conversationId: '',
    });
  });
});

/**
 * Provider 的可测部分（其余只能真机验证：页面水合、发送、读流）。
 */
describe('ChatGptBrowserProvider（可测部分）', () => {
  it('模型名就是 `chatgpt`，平台标识为 chatgpt-browser', async () => {
    const { ChatGptBrowserProvider, guardChatgptPrompt } = await import(
      '../../src/providers/chatgpt.js'
    );
    const provider = new ChatGptBrowserProvider({ accountId: 'acc1' });
    expect(provider.models).toEqual(['chatgpt']);
    expect(provider.platform).toBe('chatgpt-browser');
    expect(provider.getAccountId()).toBe('acc1');

    expect(guardChatgptPrompt('短提示')).toBe('短提示');
    const long = 'A'.repeat(10) + 'B'.repeat(64_005);
    const out = guardChatgptPrompt(long);
    expect(out.length).toBe(64_000);
    expect(out.endsWith('B')).toBe(true);
  });

  it('chatgpt 已声明实现对话能力（与工厂表一致）', async () => {
    const { PLATFORMS_WITH_PROVIDER } = await import('../../src/browser/platforms.js');
    expect(PLATFORMS_WITH_PROVIDER).toContain('chatgpt');
  });
});

/**
 * ⭐ 2026-10-24 实测：后端接口返回的工具调用正文被 `<escape>` 包裹，
 * 解析器能取出调用，但剩余正文会留下 `<escape></escape>` 残渣 ✗ → 必须剥掉。
 */
describe('stripChatgptArtifacts', () => {
  it('剥掉 escape 包裹，工具调用块本身不动', async () => {
    const { stripChatgptArtifacts } = await import('../../src/providers/chatgpt.js');
    const raw = '<escape><tool_call>{"name":"read_file"}</tool_call></escape>';
    expect(stripChatgptArtifacts(raw)).toBe('<tool_call>{"name":"read_file"}</tool_call>');
  });

  it('大写的 ESCAPE 也认；普通文本不受影响', async () => {
    const { stripChatgptArtifacts } = await import('../../src/providers/chatgpt.js');
    expect(stripChatgptArtifacts('<ESCAPE>你好</ESCAPE>')).toBe('你好');
    expect(stripChatgptArtifacts('就是普通回答')).toBe('就是普通回答');
  });
});

/**
 * ⭐⭐ 2026-10-24 实测：旧代码 `if (text) answer = text` 会被 thoughts / reasoning_recap
 * 的片段**覆盖** ✗ —— 实测答案退化成「我检查了你给出的项目路径 `/…」（15 字符），
 * `<tool_call>` 被吞掉。只有 content_type === "text" 才是正文。
 */
describe('thoughts 不能覆盖正文', () => {
  it('⭐ thoughts 的片段不覆盖最终 text', () => {
    const raw = [
      'event: delta',
      'data: {"v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"thoughts","parts":["我检查了你给出的项目路径 `/"]},"status":"finished_successfully","end_turn":false}}}',
      '',
      'event: delta',
      'data: {"v":{"message":{"id":"m2","author":{"role":"assistant"},"content":{"content_type":"text","parts":["<tool_call>{\\"name\\":\\"list_dir\\"}</tool_call>"]},"status":"finished_successfully","end_turn":true}}}',
    ].join('\n');

    const r = extractChatgptSse(raw);
    expect(r.answer).toContain('<tool_call>');
    expect(r.answer).not.toContain('我检查了你给出的项目路径');
    expect(r.finished).toBe(true);
  });

  it('⭐ 最终正文只是占位符 <text> 时，不当作正文', () => {
    const raw = [
      'event: delta',
      'data: {"v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"content_type":"code","parts":[]},"status":"finished_successfully","end_turn":false}}}',
      '',
      'event: delta',
      'data: {"v":{"message":{"id":"m2","author":{"role":"assistant"},"content":{"content_type":"text","parts":["<text>"]},"status":"finished_successfully","end_turn":true}}}',
    ].join('\n');
    expect(extractChatgptSse(raw).answer).toBe('');
  });
});
