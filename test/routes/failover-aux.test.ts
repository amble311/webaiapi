/**
 * 辅助通道的三条规则（2026-10-17 用户要求）：
 *
 * 1. 用户**指定模型类型**时，该平台没有一个连接成功的 → 返回错误并停止对话
 *    （`router.getProvider` 抛 `PlatformUnavailableError`，**不跨平台转移**）；
 * 2. 该平台**只有一个可用**账号 → 辅助模型**可以尝试其它平台**的独立通道；
 * 3. 若所有平台所有账号**只有一个可用** → 辅助与主**共用**（`getAuxCandidates()` 返回空，
 *    自然回落到主候选串行执行）。
 *
 * 本文件钉住第 2 条：旧实现要求「辅助候选与主通道同平台」，跨平台候选被直接丢掉。
 */
import { describe, expect, it } from 'vitest';

import type { ModelRouter } from '../../src/controllers/router.js';
import type { ChatRequest } from '../../src/providers/base.js';
import { streamWithFailover } from '../../src/routes/failover.js';
import type { HistoryDB } from '../../src/controllers/history-db.js';

/** 记录「谁被调用了」的假 provider。 */
function fakeProvider(platform: string, tag: string, seen: string[]) {
  return {
    platform,
    getAccountId: (): string => `acc-${tag}`,
    async *chatStream(_request: ChatRequest): AsyncGenerator<{ content: string }> {
      seen.push(tag);
      yield { content: tag };
    },
  };
}

function fakeRouter(options: {
  main: ReturnType<typeof fakeProvider>;
  aux?: Array<[string, ReturnType<typeof fakeProvider>, number]>;
}): ModelRouter {
  return {
    getProvider: async () => options.main,
    getAuxCandidates: () => options.aux ?? [],
    noteMainPlatform: () => undefined,
    platformOfModel: () => 'chatglm',
  } as unknown as ModelRouter;
}

/** 跑一次流式，收集分片文本。 */
async function run(
  router: ModelRouter,
  model: string,
  context: Record<string, unknown> = {},
): Promise<{ text: string }> {
  const request = {
    message: '把这段历史压成摘要',
    stream: true,
    tools: [],
    context,
  } as unknown as ChatRequest;

  let text = '';
  for await (const [chunk] of streamWithFailover(router, model, request, {} as unknown as HistoryDB)) {
    if (chunk.content) text += chunk.content;
  }
  return { text };
}

describe('辅助通道：跨平台回落', () => {
  it('⭐ 同平台只有一个账号时，辅助任务改用其它平台的独立通道', async () => {
    const seen: string[] = [];
    const main = fakeProvider('chatglm-browser', 'main', seen);
    const aux = fakeProvider('deepseek-browser', 'aux', seen);

    // `getAuxCandidates` 里给的是**另一个平台**的候选（旧的 failover 会直接丢弃）
    const router = fakeRouter({ main, aux: [['deepseek', aux, 1]] });

    const { text } = await run(router, 'chatglm', { use_aux_page: true });

    expect(seen).toEqual(['aux']); // 只调了辅助通道，且是跨平台的
    expect(text).toBe('aux');
  });

  it('同平台有副账号时优先用它（顺序由 getAuxCandidates 决定）', async () => {
    const seen: string[] = [];
    const main = fakeProvider('chatglm-browser', 'main', seen);
    const samePlatform = fakeProvider('chatglm-browser', 'aux-same', seen);

    const router = fakeRouter({ main, aux: [['chatglm', samePlatform, 1]] });
    const { text } = await run(router, 'chatglm', { use_aux_page: true });

    expect(seen).toEqual(['aux-same']);
    expect(text).toBe('aux-same');
  });

  it('没有辅助候选（所有平台只有一个可用账号）→ 与主通道共用，串行执行', async () => {
    const seen: string[] = [];
    const main = fakeProvider('chatglm-browser', 'main', seen);

    const router = fakeRouter({ main });
    const { text } = await run(router, 'chatglm', { use_aux_page: true });

    expect(seen).toEqual(['main']); // 用主通道（共用那一个账号）
    expect(text).toBe('main');
  });

  it('不是辅助任务（没有 use_aux_page）→ 即使有候选也不用', async () => {
    const seen: string[] = [];
    const main = fakeProvider('chatglm-browser', 'main', seen);
    const aux = fakeProvider('deepseek-browser', 'aux', seen);

    const router = fakeRouter({ main, aux: [['deepseek', aux, 1]] });
    const { text } = await run(router, 'chatglm', {});

    expect(seen).toEqual(['main']);
    expect(text).toBe('main');
  });
});
