/**
 * OpenAI 兼容的请求/响应模型 —— `legacy-python/src/models/{request,response}.py` 的移植。
 *
 * 与原实现的差异：
 * - pydantic → zod。校验规则逐条对齐（role 白名单、messages 非空、
 *   首条必须是 system/user、temperature/max_tokens 等取值范围）。
 * - `EmbeddingRequest` / `ModerationRequest` / `CreateConversationRequest` 不移植：
 *   Python 版定义了但**没有任何路由使用它们**（`grep` 可验证）。
 */
import { z } from 'zod';

import { ALLOWED_ROLES, type MessageContent } from './message.js';

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

const contentSchema = z.union([z.string(), z.array(z.unknown()), z.null()]);

export const messageSchema = z.object({
  role: z.enum(ALLOWED_ROLES),
  content: contentSchema.optional(),
  name: z.string().nullish(),
  tool_calls: z.array(z.unknown()).nullish(),
  tool_call_id: z.string().nullish(),
});

export type MessageInput = z.infer<typeof messageSchema>;

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1, '消息列表不能为空'),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).nullish(),
    max_tokens: z.number().int().min(1).nullish(),
    tools: z.array(z.unknown()).nullish(),
    tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
    conversation_id: z.string().nullish(),
    workspace_path: z.string().nullish(),
    // OpenAI 兼容参数：接收但不一定使用
    n: z.number().int().nullish().default(1),
    top_p: z.number().min(0).max(1).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    response_format: z.record(z.string(), z.unknown()).nullish(),
  })
  .refine(
    (value) => {
      const first = value.messages[0];
      return first !== undefined && (first.role === 'system' || first.role === 'user');
    },
    {
      message: '第一条消息必须是 system 或 user',
      path: ['messages'],
    },
  );

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

export interface ChatCompletionChoice {
  index: number;
  message: Record<string, unknown>;
  finish_reason: string;
  logprobs?: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage | null;
  system_fingerprint?: string | null;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  provider: string;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelInfo[];
}

export interface HealthCheckResponse {
  status: string;
  version: string;
  providers: Record<string, Record<string, string>>;
}

/** 当前 Unix 时间戳（秒），等价于 Python `int(datetime.now().timestamp())`。 */
export function nowSeconds(now: () => number = Date.now): number {
  return Math.floor(now() / 1000);
}

/** 模型信息工厂（`created` 可注入，便于测试）。 */
export function makeModelInfo(
  id: string,
  provider: string,
  now: () => number = Date.now,
): ModelInfo {
  return { id, object: 'model', created: nowSeconds(now), owned_by: 'ai-api', provider };
}

/** 构造 OpenAI 格式的错误对象（等价于 `ErrorResponse.from_openai_error`）。 */
export function buildOpenAiError(
  message: string,
  errorType = 'invalid_request_error',
  param?: string | null,
  code?: string | null,
): Record<string, unknown> {
  const error: Record<string, unknown> = { message, type: errorType };
  if (code != null) error['code'] = code;
  if (param != null) error['param'] = param;
  return error;
}

/** 取消息内容的纯文本（便捷转发，避免使用方到处 import）。 */
export type { MessageContent };
