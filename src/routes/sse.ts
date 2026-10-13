/**
 * OpenAI 兼容的 SSE 分片构造 —— 从 `legacy-python/src/api/routes.py` 的
 * `chat_completions` 里抽出的公共部分。
 *
 * ⚠️ 两条必须遵守的格式约束：
 * 1. **`tool_calls` 分片必须在 `data: [DONE]` 之前发出**。客户端（CodeBuddy/Trae）
 *    是收到 `[DONE]` 就结束本轮解析的，之后发的一律丢弃。
 * 2. **`finish_reason` 只能出现一次**，且在最后一个内容分片里；
 *    带 `tool_calls` 时必须是 `"tool_calls"` 而不是 `"stop"`
 *    （否则客户端会把这一轮当成"已答完"，不去执行工具）。
 */
import type { ToolCallPayload } from '../types/message.js';

/** SSE 结束标记。 */
export const DONE = 'data: [DONE]\n\n';

/** 分片里的 delta。 */
export interface ChunkDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

/** 一个 `chat.completion.chunk`。 */
export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChunkDelta;
    finish_reason: string | null;
  }>;
}

/**
 * 把对象序列化成一条 SSE 消息。
 *
 * ⚠️ 用 `JSON.stringify` 而非任何「美化」输出：客户端按行解析。
 * 中文**不需要**转义（JS 的 `JSON.stringify` 默认输出原字符，
 * 等价于 Python 的 `ensure_ascii=False`）。
 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 当前 Unix 时间戳（秒）。 */
export function nowSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

/**
 * 构造一个内容分片。
 *
 * ⚠️ 与 Python 的差异：Python 用 `int(asyncio.get_event_loop().time())` 填 `created`
 * （那是**单调时钟**，值很小，属于历史遗留的笔误）。这里改用真正的 Unix 时间戳；
 * `created` 字段客户端不解析，改成正确值只会有益无害。
 */
export function contentChunk(params: {
  id: string;
  model: string;
  content: string;
  role?: string;
  finishReason?: string | null;
  created?: number;
}): string {
  const { id, model, content, role, finishReason = null, created } = params;
  const delta: ChunkDelta = {};
  if (role !== undefined) delta.role = role;
  if (content) delta.content = content;

  return sseData({
    id,
    object: 'chat.completion.chunk',
    created: created ?? nowSeconds(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/**
 * 构造工具调用分片。
 *
 * OpenAI 的流式工具调用是分片的（`index` + `function.arguments` 增量），
 * 但**客户端普遍接受一次性发完整 arguments**，而本项目一次性解析完再发
 * （见 `chat_completions` 的「先缓冲完整回复，解析 tool_calls 后再发送」）。
 * 因此这里一次性发出全部，`finish_reason` 为 `"tool_calls"`。
 */
export function toolCallsChunk(params: {
  id: string;
  model: string;
  toolCalls: ReadonlyArray<ToolCallPayload>;
  created?: number;
}): string {
  const { id, model, toolCalls, created } = params;

  const payload = toolCalls.map((tc, index) => ({
    index,
    id: tc.id,
    type: 'function',
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));

  return sseData({
    id,
    object: 'chat.completion.chunk',
    created: created ?? nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: payload as unknown as Array<Record<string, unknown>> },
        finish_reason: 'tool_calls',
      },
    ],
  });
}

/**
 * 构造「首片」分片（只有 role，没有内容）。
 *
 * OpenAI 的流式响应第一片固定是 `{"role":"assistant"}`，客户端据此初始化消息。
 */
export function roleChunk(params: { id: string; model: string; created?: number }): string {
  return contentChunk({ ...params, content: '', role: 'assistant' });
}
