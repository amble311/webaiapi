/**
 * 「模型调了客户端没有的工具」的恢复路径 —— 2026-10-14 事故回归测试。
 *
 * ## 事故（xzh 实测）
 * ChatGLM 判定问题需要跑代码（SSE 里 `answer_type=python`），于是调用它**平台自带**的
 * `execute_sandbox_code`。该名字不在客户端工具列表里 → `filterUnknownToolCalls` 丢弃
 * → 整轮降级成纯文本，而那段「文本」正好是 `<tool_call>…</tool_call>` 原文
 * → 客户端收到纯文本（没有 tool_calls）**直接结束回合**，用户看到的是「对话无故停止」。
 *
 * 这里钉住三件事：
 * 1. 命中时启动**工具名纠正轮**，把客户端真实工具列表发回去，拿回可执行的调用；
 * 2. 纠正轮失败时，**绝不**把 `<tool_call>` 原文当正文下发；
 * 3. 剩余预算不够时不启动纠正轮，但同样给出可操作的说明。
 *
 * ⚠️ `api-logger` 被打桩：它写的是**用户用来排查问题的** `logs/api_requests.log`，
 *    测试不该往里塞假记录。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/log/api-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/log/api-logger.js')>();
  const noop = (): void => undefined;
  return {
    ...actual,
    resetApiLog: noop,
    logApiRequest: noop,
    logApiResponse: noop,
    logApiError: noop,
    logRoundStart: noop,
    logAiPlatformRequest: noop,
    logAiPlatformResponse: noop,
    logAiPlatformResponseComplete: noop,
  };
});

import type { HistoryDB } from '../../src/controllers/history-db.js';
import type { ModelRouter } from '../../src/controllers/router.js';
import type { ChatRequest } from '../../src/providers/base.js';
import { resetLastRawSse, setLastRawSse } from '../../src/providers/chatglm-sse.js';
import { parseAndRecoverToolCalls, type PreparedRequest } from '../../src/routes/chat.js';
import { createToolMaps } from '../../src/tools/names.js';
import type { ToolDefinition } from '../../src/types/message.js';

/** 客户端真实工具（对应事故现场的 `bash` / `list_dir`）。 */
const TOOLS: ToolDefinition[] = [
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
      name: 'write_file',
      description: 'Write a file',
      parameters: { properties: { path: {}, content: {} }, required: ['path', 'content'] },
    },
  },
];

/** 事故现场 SSE 原文：整段就是一个「平台自带工具」的调用块。 */
const SANDBOX_SSE_TEXT =
  '<tool_call>\n{"name": "execute_sandbox_code", "arguments": {"code": "print(1)"}}\n</tool_call>';

function prepared(deadlineInSeconds = 200): PreparedRequest {
  return {
    requestId: 'chatcmpl-test',
    deadlineTs: Date.now() + deadlineInSeconds * 1000,
    request: {
      model: 'chatglm',
      stream: true,
      tools: TOOLS,
      messages: [{ role: 'user', content: '继续' }],
    },
    conversationId: null,
    messageText: '继续',
    rawMessageText: '继续',
    deltaText: '',
    workspacePath: '/tmp/proj',
    knownFilePaths: [],
    toolsText: '',
    toolRoundCount: 1,
    lastMessage: { role: 'user', content: '继续' },
  };
}

/** 假 router：provider 按顺序吐出预设回复，并把收到的提示词记进 `seen`。 */
function makeRouter(replies: string[], seen: string[]): ModelRouter {
  const provider = {
    platform: 'chatglm-browser',
    getAccountId: (): string => 'default',
    async *chatStream(request: ChatRequest): AsyncGenerator<{ content: string }> {
      seen.push(request.message);
      yield { content: replies.shift() ?? '' };
    },
  };

  return {
    getAuxCandidates: () => [],
    /* `streamWithFailover` 每次请求入口都会记录主通道平台（辅助通道据此优先同平台），
     * 假 router 也要提供，否则真实代码那一行会抛错、恢复轮整个跑不起来。 */
    noteMainPlatform: () => undefined,
    getProvider: async () => provider,
  } as unknown as ModelRouter;
}

async function run(router: ModelRouter, deadlineInSeconds = 200) {
  return parseAndRecoverToolCalls({
    parseSource: SANDBOX_SSE_TEXT,
    fullResponse: SANDBOX_SSE_TEXT,
    fromSse: true,
    currentPlatform: 'chatglm',
    prepared: prepared(deadlineInSeconds),
    modelRouter: router,
    historyDb: {} as unknown as HistoryDB,
    toolMaps: createToolMaps(TOOLS),
    options: { fixPaths: false, validateSearchReplace: false },
  });
}

describe('parseAndRecoverToolCalls：模型调了客户端没有的工具', () => {
  beforeEach(() => resetLastRawSse());

  it('启动动作恢复轮：把真实工具列表发回去，拿回可执行的调用', async () => {
    const seen: string[] = [];
    const router = makeRouter(
      ['<tool_call>\n{"name": "bash", "arguments": {"command": "python3 -c print(1)"}}\n</tool_call>'],
      seen,
    );

    const outcome = await run(router);

    expect(seen).toHaveLength(1);
    // 恢复轮必须点名那个不存在的工具，并只列客户端真实工具
    expect(seen[0]).toContain('execute_sandbox_code');
    expect(seen[0]).toContain('- bash(command, timeout, cwd)');
    expect(outcome.parsedToolCalls.map((tc) => tc.function.name)).toEqual(['bash']);
    expect(outcome.finishReason).toBe('tool_calls');
    // ⚠️ 不再合成「正在执行 N 个操作」：正文只能是模型自己的话（这里是空）
    expect(outcome.parsedText).toBe('');
    expect(outcome.parsedText).not.toContain('正在执行');
  });

  it('⚠️ 动作恢复轮失败时：绝不把 <tool_call> 原文当正文下发', async () => {
    const router = makeRouter(['我无法完成这个操作。'], []);

    const outcome = await run(router);

    expect(outcome.parsedToolCalls).toEqual([]);
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.parsedText).not.toContain('<tool_call>');
    expect(outcome.parsedText).not.toContain('execute_sandbox_code", "arguments"');
    expect(outcome.parsedText).toContain('本环境不存在的工具');
    expect(outcome.parsedText).toContain('execute_sandbox_code');
  });

  it('动作恢复轮自己又编了个名字时同样过滤，只回退说明', async () => {
    const router = makeRouter(
      ['<tool_call>\n{"name": "browser_open", "arguments": {"url": "https://x"}}\n</tool_call>'],
      [],
    );

    const outcome = await run(router);

    expect(outcome.parsedToolCalls).toEqual([]);
    expect(outcome.parsedText).not.toContain('<tool_call>');
    expect(outcome.parsedText).toContain('本环境不存在的工具');
  });

  it('⭐ 路径参数里装的是 shell 命令 → 改派给命令执行工具（不静默丢弃）', async () => {
    const seen: string[] = [];
    const router = makeRouter([], seen); // 不该启动恢复轮
    const sseText =
      '<tool_call>\n{"name": "write_file", "arguments": {"path": "cd /home/amble/object/btc' +
      ' && ./start.sh", "content": "#!/bin/bash"}}\n</tool_call>';

    const outcome = await parseAndRecoverToolCalls({
      parseSource: sseText,
      fullResponse: sseText,
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: prepared(),
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });

    expect(seen).toEqual([]);
    expect(outcome.parsedToolCalls.map((tc) => tc.function.name)).toEqual(['bash']);
    expect(JSON.parse(outcome.parsedToolCalls[0]?.function.arguments ?? '{}')).toEqual({
      command: 'cd /home/amble/object/btc && ./start.sh',
    });
    expect(outcome.finishReason).toBe('tool_calls');
  });

  it('⭐ 恢复轮带「最近进展」：用户真提问 + 上一轮做了什么（不是把 tool 结果当用户请求）', async () => {
    const seen: string[] = [];
    const router = makeRouter(['抱歉，无法完成。'], seen);

    // 多轮工具调用的典型形态：最后一条是 tool 结果
    const withToolTail: PreparedRequest = {
      ...prepared(),
      request: {
        model: 'chatglm',
        stream: true,
        tools: TOOLS,
        messages: [
          { role: 'user', content: '把服务重启一下' },
          { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '已写入 /home/amble/object/btc/README.md（1231 字符）' },
        ],
      } as unknown as PreparedRequest['request'],
      lastMessage: { role: 'tool', content: '已写入 /home/amble/object/btc/README.md（1231 字符）' },
    };

    // 必须是「像计划书」的回答才会触发恢复轮（`looksUnfinishedAnswer`）——
    // 2026-10-14 起「本轮没有工具调用」本身**不再**触发（那会造成死循环）。
    const outcome = await parseAndRecoverToolCalls({
      parseSource: '我打算待下一轮执行：清理误写入的文件，然后启动服务验证状态。',
      fullResponse: '我打算待下一轮执行：清理误写入的文件，然后启动服务验证状态。',
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: withToolTail,
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });

    expect(seen).toHaveLength(1);
    const recoveryPrompt = seen[0] as string;
    // 「最近进展」要带上：用户真提问（`extractUserQuestion` 的口径）+ 上一轮做了什么
    expect(recoveryPrompt).toContain('# 最近进展（对话尾部）');
    expect(recoveryPrompt).toContain('用户: 把服务重启一下');
    expect(recoveryPrompt).toContain('AI 调用工具: write_file');
    expect(recoveryPrompt).toContain('已写入 /home/amble/object/btc/README.md（1231 字符）');

    expect(outcome.parsedToolCalls).toEqual([]);
  });

  it('⭐ 模型自述「没有文件系统访问权限」→ 触发动作恢复轮（其实工具都在）', async () => {
    const seen: string[] = [];
    const router = makeRouter(
      ['<tool_call>\n{"name": "bash", "arguments": {"command": "ls /home/amble/object/btc"}}\n</tool_call>'],
      seen,
    );
    // 2026-10-15 实测原文（这一轮模型坚持说自己在裸聊，客户端只拿到残句 + stop）
    const claim =
      '根据协议要求，我第一步必须调用读取工具，但当前环境**没有提供本地文件系统访问权限**' +
      '（无 `list_dir` / `read_file` 等真实工具可用），无法直接操作 `/home/amble/object/btc` 目录。';

    const outcome = await parseAndRecoverToolCalls({
      parseSource: claim,
      fullResponse: claim,
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: prepared(),
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });

    expect(seen).toHaveLength(1); // 触发恢复轮
    expect(seen[0]).toContain('没有提供本地文件系统访问权限'); // 把自述带给恢复轮
    expect(outcome.parsedToolCalls.map((tc) => tc.function.name)).toEqual(['bash']);
    expect(outcome.finishReason).toBe('tool_calls');
  });

  it('⭐ 正常收尾（无工具调用）不再触发恢复轮 —— 修复 2026-10-14 的死循环', async () => {
    const seen: string[] = [];
    const router = makeRouter(['不该被调用'], seen);
    const conclusion = '本轮状态确认：API 后端运行正常，TUI 未启动。无需进一步操作。';

    const outcome = await parseAndRecoverToolCalls({
      parseSource: conclusion,
      fullResponse: conclusion,
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: prepared(),
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });

    // 原生模型就是「没有工具调用 = 本轮结束」，我们不再逼它继续动手
    expect(seen).toEqual([]);
    expect(outcome.parsedToolCalls).toEqual([]);
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.parsedText).toBe(conclusion);
  });

  it('⭐ 平台整轮只产出思考、没有正文 → 用思考材料驱动恢复轮（2026-10-16 事故）', async () => {
    const seen: string[] = [];
    const router = makeRouter(
      ['<tool_call>\n{"name": "bash", "arguments": {"command": "ls /home/amble/object/btc"}}\n</tool_call>'],
      seen,
    );

    /* 主轮 SSE：`text` 为空、`think` 里有它想做的事 —— provider 侧因为「有思考材料」
     * 按设计**不报错**，于是文本=0、工具调用=0，客户端只会看到一句空响应说明。
     * 材料明明在手（思考里就有它要做的事），必须用它驱动恢复轮。 */
    setLastRawSse({ text: '', think: '我需要：1. 用 list_dir 查看项目结构；2. 清理无用脚本。' });

    try {
      const outcome = await parseAndRecoverToolCalls({
        parseSource: '',
        fullResponse: '',
        fromSse: true,
        currentPlatform: 'chatglm',
        prepared: prepared(),
        modelRouter: router,
        historyDb: {} as unknown as HistoryDB,
        toolMaps: createToolMaps(TOOLS),
        options: { fixPaths: false, validateSearchReplace: false },
      });

      expect(seen).toHaveLength(1);
      // 没有「调错名字」时走「压根没动手」那套措辞
      expect(seen[0]).toContain('没有给出可执行的工具调用');
      // 思考材料要带进恢复轮（否则它不知道要做什么）
      expect(seen[0]).toContain('用 list_dir 查看项目结构');
      expect(outcome.parsedToolCalls.map((tc) => tc.function.name)).toEqual(['bash']);
      expect(outcome.finishReason).toBe('tool_calls');
    } finally {
      resetLastRawSse();
    }
  });

  it('⚠️ 有正文的正常收尾 + 空思考 → 仍然不触发（H2 不会复活死循环）', async () => {
    const seen: string[] = [];
    const router = makeRouter(['不该被调用'], seen);
    setLastRawSse({ text: '', think: '' });

    try {
      const outcome = await parseAndRecoverToolCalls({
        parseSource: '清理完成：删除了 3 个无用脚本，测试全绿。',
        fullResponse: '清理完成：删除了 3 个无用脚本，测试全绿。',
        fromSse: true,
        currentPlatform: 'chatglm',
        prepared: prepared(),
        modelRouter: router,
        historyDb: {} as unknown as HistoryDB,
        toolMaps: createToolMaps(TOOLS),
        options: { fixPaths: false, validateSearchReplace: false },
      });

      expect(seen).toEqual([]);
      expect(outcome.finishReason).toBe('stop');
    } finally {
      resetLastRawSse();
    }
  });

  it('⭐ 重复调用抑制：同一工具+参数已执行过 → 不再下发，并把原因告诉模型', async () => {
    const cmd = 'cd /home/amble/object/btc && ./start.sh status';
    const seen: string[] = [];
    const router = makeRouter(['不该被调用'], seen);

    // 客户端历史里同一条 bash 已经执行过两次
    const looping: PreparedRequest = {
      ...prepared(),
      request: {
        model: 'chatglm',
        stream: true,
        tools: TOOLS,
        messages: [
          { role: 'user', content: '继续' },
          { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) } }] },
          { role: 'tool', tool_call_id: 'c1', content: '[INFO] API: 运行中' },
          { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) } }] },
          { role: 'tool', tool_call_id: 'c2', content: '[INFO] API: 运行中' },
        ],
      } as unknown as PreparedRequest['request'],
      lastMessage: { role: 'tool', content: '[INFO] API: 运行中' },
    };

    const sseText =
      `清理完成，无需进一步操作。<tool_call>\n{"name": "bash", "arguments": ${JSON.stringify({ command: cmd })}}\n</tool_call>`;

    const outcome = await parseAndRecoverToolCalls({
      parseSource: sseText,
      fullResponse: sseText,
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: looping,
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });

    expect(seen).toEqual([]); // 不该再启动恢复轮
    expect(outcome.parsedToolCalls).toEqual([]); // 重复调用被拦下
    expect(outcome.finishReason).toBe('stop');
    // 正文保留模型的话，并**追加被抑制的原因**（2026-10-18 改：不告诉模型它就会换个说法重试）
    expect(outcome.parsedText).toContain('清理完成，无需进一步操作。');
    expect(outcome.parsedText).toContain('已跳过 1 个重复调用');
    expect(outcome.parsedText).toContain('bash');
  });

  it('剩余预算不足时跳过恢复轮，但仍给出明确说明', async () => {
    const seen: string[] = [];
    const router = makeRouter(['不该被调用'], seen);

    const outcome = await run(router, 10);

    expect(seen).toEqual([]);
    expect(outcome.parsedToolCalls).toEqual([]);
    expect(outcome.parsedText).toContain('本环境不存在的工具');
    expect(outcome.parsedText).not.toContain('<tool_call>');
  });
});

/**
 * ⭐ 批量下发策略（步骤 9）—— 2026-10-16 实测修正。
 *
 * 事故（用户报「模型不肯动手」）：模型一轮规划了 8 个调用
 * （`search_content×4, read_file×2, execute_command×2`），旧策略「只要含写操作就**只发第一个**」
 * 把它砍成 **1 个**，其余 7 个（含 4 次读）**凭空消失且模型不知道** → 它以为信息不全 →
 * 重新读一遍……实测连续 **8 轮只读不写**。
 *
 * 新策略：**下发到「第一个写操作」为止**（它之前的只读调用照旧一起发），之后的丢弃。
 * 保留的取舍：写操作会让后面调用的 `old_str` / 行号失效，必须等模型看到写的结果。
 */
describe('批量下发策略：含写操作时不再「只发第一个」', () => {
  const run = async (source: string): Promise<string[]> => {
    const seen: string[] = [];
    const router = makeRouter(['不该被调用'], seen);
    const outcome = await parseAndRecoverToolCalls({
      parseSource: source,
      fullResponse: source,
      fromSse: true,
      currentPlatform: 'chatglm',
      prepared: prepared(),
      modelRouter: router,
      historyDb: {} as unknown as HistoryDB,
      toolMaps: createToolMaps(TOOLS),
      options: { fixPaths: false, validateSearchReplace: false },
    });
    return outcome.parsedToolCalls.map((tc) => tc.function.name);
  };

  const call = (name: string, args: Record<string, unknown>): string =>
    `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

  it('⭐ 读 + 读 + 写 + 写 → 下发前 3 个（事故前只剩 1 个）', async () => {
    const source = [
      call('list_dir', { target_directory: '/a' }),
      call('list_dir', { target_directory: '/b' }),
      call('bash', { command: 'rm /a' }),
      call('bash', { command: 'rm /b' }),
    ].join('\n');
    expect(await run(source)).toEqual(['list_dir', 'list_dir', 'bash']);
  });

  it('第一个就是写 → 仍只发 1 个（保留「写后必须重规划」的取舍）', async () => {
    const source = [
      call('bash', { command: 'echo a' }),
      call('list_dir', { target_directory: '/' }),
    ].join('\n');
    expect(await run(source)).toEqual(['bash']);
  });

  it('全只读 → 全部下发（不回归）', async () => {
    const source = [
      call('list_dir', { target_directory: '/a' }),
      call('list_dir', { target_directory: '/b' }),
      call('list_dir', { target_directory: '/c' }),
    ].join('\n');
    expect(await run(source)).toEqual(['list_dir', 'list_dir', 'list_dir']);
  });
});
