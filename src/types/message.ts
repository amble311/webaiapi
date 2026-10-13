/**
 * 消息模型 —— `legacy-python/src/models/request.py` 的 TypeScript 移植。
 *
 * 与原实现的差异：
 * - Python 用 pydantic 做校验（role 白名单、messages 非空、首条必须是 system/user）。
 *   TS 侧改为 zod（见 `src/types/openai.ts`）在 HTTP 边界校验，本文件只放纯类型与工具函数。
 * - `content` 保持「字符串或多模态数组」的原始形态，不再在读取时提前拍平成字符串，
 *   这样 `formatMessagesAsText` 才能正确处理 `image_url` 项（Python 版对 dict 入参
 *   能正确处理，对 pydantic 入参则因提前拍平而丢失图片标记）。
 */

/** 允许的消息角色。 */
export const ALLOWED_ROLES = ['system', 'user', 'assistant', 'tool', 'function'] as const;

export type MessageRole = (typeof ALLOWED_ROLES)[number];

/** 多模态内容项（OpenAI 格式）。 */
export interface ContentPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

export type MessageContent = string | ContentPart[] | null;

/** OpenAI 兼容的消息。 */
export interface ChatMessage {
  role: MessageRole | string;
  content?: MessageContent;
  name?: string | null;
  tool_calls?: ToolCallPayload[] | null;
  tool_call_id?: string | null;
}

/** OpenAI 工具调用（function 的 arguments 是 JSON 字符串）。 */
export interface ToolCallPayload {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 工具定义（OpenAI `tools` 数组的元素）。
 *
 * 这里用宽松类型：客户端（CodeBuddy / Trae）实际发来的结构并不总是严格符合规范，
 * Python 版也是把 `tools` 当 `List[Dict[str, Any]]` 用的。
 */
export interface ToolDefinition {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 消息的「扁平化」视图：所有字段都可选、便于统一取值。 */
export interface MessageDict {
  role: string;
  content: MessageContent;
  name?: string;
  tool_calls?: ToolCallPayload[];
  tool_call_id?: string;
}

/**
 * 取纯文本内容（合并多模态数组里的 text 项）。
 *
 * 与 Python `Message.get_text_content()` 等价。
 */
export function getTextContent(content: MessageContent): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      if (rec['type'] === 'text' && 'text' in rec) {
        parts.push(String(rec['text']));
      } else if (typeof rec['text'] === 'string') {
        parts.push(rec['text']);
      }
    }
  }
  return parts.join('');
}

/**
 * 把消息规范化成 `MessageDict`（等价于 Python `_msg_to_dict()`）。
 *
 * 与 Python 的区别：这里永远保留 `content` 的原始形态（字符串或数组），
 * 不再用 `get_text_content()` 提前拍平 —— 拍平会丢掉 `image_url` 标记。
 * 需要纯文本的地方请显式调用 {@link getTextContent}。
 */
export function messageToDict(msg: ChatMessage | Record<string, unknown>): MessageDict {
  const rec = msg as Record<string, unknown>;

  const out: MessageDict = {
    role: typeof rec['role'] === 'string' ? rec['role'] : '',
    content: (rec['content'] ?? '') as MessageContent,
  };

  const toolCalls = rec['tool_calls'];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    out.tool_calls = toolCalls as ToolCallPayload[];
  }
  const toolCallId = rec['tool_call_id'];
  if (typeof toolCallId === 'string' && toolCallId) {
    out.tool_call_id = toolCallId;
  }
  const name = rec['name'];
  if (typeof name === 'string' && name) {
    out.name = name;
  }

  return out;
}

/** 取工具定义的名字（容错：客户端结构可能不规范）。 */
export function toolNameOf(tool: ToolDefinition | undefined | null): string {
  const name = tool?.function?.name;
  return typeof name === 'string' ? name : '';
}

/** 取工具定义的参数名列表。 */
export function toolParamNames(tool: ToolDefinition | undefined | null): string[] {
  const props = tool?.function?.parameters?.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props);
}

/** 取工具定义的必填参数名列表。 */
export function toolRequiredParams(tool: ToolDefinition | undefined | null): string[] {
  const required = tool?.function?.parameters?.required;
  return Array.isArray(required) ? required : [];
}
