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
