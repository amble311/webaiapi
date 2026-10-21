/**
 * ChatGPT 网页版（`chatgpt.com`）对话流的解析器 —— **纯函数，便于单测**。
 *
 * ## 实测契约（2026-10-19，用真实凭证 + 真实发送抓出来的）
 * `POST /backend-api/conversation` 返回 **SSE**，帧有三类：
 *
 * 1. **整条消息**：`event: delta` + `data: {"v":{"message":{ id, author:{role}, content:{content_type,parts}, status, end_turn }}}`
 *    —— 同一 `id` 的消息会在后续帧里被**再次下发**（状态从 `in_progress` 变 `finished_successfully`）。
 * 2. **补丁**：`data: {"p":"/message/status","o":"replace","v":"finished_successfully"}`
 *    或 `{"p":"/message/content/parts/0","o":"append","v":"一段文字"}` ——
 *    `p` 是**相对当前消息**的 JSON 指针，`o` ∈ `add` / `append` / `replace` / `patch`。
 * 3. **元数据**：`data: {"type":"input_message"|"message_marker"|"server_ste_metadata"|…}`
 *    —— 只有 `message_marker` 里的 `conversation_id` 有用。
 *
 * 结束：助手消息 `status === "finished_successfully"` 且 `end_turn === true`，或流末尾的 `[DONE]`。
 *
 * ⚠️ 正文取 `content.parts`（`content_type === "text"`）；`thoughts` / `model_editable_context`
 * 不算正文（前者是思考、后者是编辑器上下文）。
 */

/** 一帧里 `data:` 的 JSON 形状（宽泛，避免为每个字段建模）。 */
type Json = Record<string, unknown>;

export interface ChatgptSseResult {
  /** 助手正文（已把 `parts` 拼接）。 */
  answer: string;
  /** 思考内容（`content_type: "thoughts"`，没有则为空串）。 */
  thinking: string;
  /** 是否已结束（`finished_successfully` + `end_turn`，或收到 `[DONE]`）。 */
  finished: boolean;
  /** 会话 id（`message_marker` 帧里给）。 */
  conversationId: string;
}

/** 解析 SSE 文本成帧（`event:` + 多行 `data:`）。 */
export function splitSseFrames(raw: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!event && data.length === 0) continue;
    frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

/** JSON 指针（`/message/content/parts/0`）→ 路径段。 */
function pointerSegments(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function readPath(target: unknown, segments: string[]): unknown {
  let cur: unknown = target;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Json)[seg];
  }
  return cur;
}

/** 在 `target` 上按指针写值（`add` / `replace` 语义；数组越界就 push）。 */
function writePath(target: unknown, segments: string[], value: unknown): void {
  if (segments.length === 0) return; // 根替换由调用方处理
  const last = segments[segments.length - 1] as string;
  const parent = readPath(target, segments.slice(0, -1));
  if (parent === null || typeof parent !== 'object') return;
  if (Array.isArray(parent)) {
    const idx = Number(last);
    if (Number.isInteger(idx) && idx >= 0 && idx < parent.length) parent[idx] = value;
    else parent.push(value);
    return;
  }
  (parent as Json)[last] = value;
}

/** 把一条补丁应用到**当前消息**上（`append` 会拼接到字符串/数组末尾）。 */
function applyPatch(target: unknown, op: string, pointer: string, value: unknown): void {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return; // `p:""` + `add` 是整条消息，走 message 分支

  if (op === 'append') {
    const existing = readPath(target, segments);
    if (typeof existing === 'string' && typeof value === 'string') {
      writePath(target, segments, existing + value);
      return;
    }
    if (Array.isArray(existing) && typeof value === 'string') {
      existing.push(value);
      return;
    }
  }
  writePath(target, segments, value);
}

/** 从消息对象里取正文 / 思考文本。 */
function textOf(message: Json): { text: string; thoughts: string } {
  const content = (message['content'] ?? {}) as Json;
  const parts = Array.isArray(content['parts']) ? (content['parts'] as unknown[]) : [];
  const text = parts
    .filter((part): part is string => typeof part === 'string')
    .join('');
  const thoughts = Array.isArray(content['thoughts'])
    ? (content['thoughts'] as unknown[])
        .map((item) => {
          const rec = (item ?? {}) as Json;
          return typeof rec['summary'] === 'string' ? rec['summary'] : '';
        })
        .join('')
    : '';
  return { text, thoughts };
}

/**
 * 解析一整段 ChatGPT SSE 文本。
 *
 * @param raw 捕获到的原始流（可能中间夹杂别的响应，这里只认能解析的 `data:`）
 */
export function extractChatgptSse(raw: string): ChatgptSseResult {
  const result: ChatgptSseResult = {
    answer: '',
    thinking: '',
    finished: false,
    conversationId: '',
  };

  /** 消息 id → 消息对象（后续帧会增量更新同一条）。 */
  const messages = new Map<string, Json>();
  /* ⚠️ `current` 存的是**包装层** `{ message }`（不是 message 本身）：
   * 补丁指针是 `/message/status` 这种**以 message 为根**的路径（2026-10-19 实测夹具）。 */
  let current: Json | null = null;
  let currentId = '';

  for (const frame of splitSseFrames(raw)) {
    const data = frame.data;
    if (!data) continue;
    if (data.includes('[DONE]')) {
      result.finished = true;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      continue; // 半截帧 / 非 JSON（如 `"v1"` 这种已被 JSON.parse 吃掉）
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const rec = parsed as Json;

    // ① 元数据帧
    if (typeof rec['type'] === 'string') {
      if (rec['type'] === 'message_marker' && typeof rec['conversation_id'] === 'string') {
        result.conversationId = rec['conversation_id'];
      }
      continue;
    }

    // ② 整条消息
    const wrapped = (rec['v'] ?? null) as Json | null;
    if (rec['p'] === undefined && wrapped && typeof wrapped === 'object' && wrapped['message']) {
      const message = wrapped['message'] as Json;
      const id = String(message['id'] ?? '');
      if (id) {
        messages.set(id, message);
        current = wrapped as Json;
        currentId = id;
      }
      continue;
    }

    // ③ 补丁（相对**当前消息**）
    if (typeof rec['p'] === 'string' && rec['o'] !== undefined) {
      if (!current) continue;
      const op = String(rec['o']);
      const pointer = rec['p'];
      if (pointer === '' && op === 'add' && rec['v'] && typeof rec['v'] === 'object') {
        // 极端情况：根替换
        const message = ((rec['v'] as Json)['message'] ?? null) as Json | null;
        if (message) {
          const id = String(message['id'] ?? currentId);
          messages.set(id, message);
          current = rec['v'] as Json;
          currentId = id;
        }
        continue;
      }
      applyPatch(current, op, pointer, rec['v']);
    }
  }

  // 取**最后一条助手消息**（按插入顺序，Map 保序）
  let answer = '';
  let thinking = '';
  let lastAssistantFinished = false;
  for (const [, message] of messages) {
    const author = (message['author'] ?? {}) as Json;
    if (author['role'] !== 'assistant') continue;
    const { text, thoughts } = textOf(message);
    if (text) answer = text;
    if (thoughts) thinking = thoughts;
    /* ⚠️⚠️ 只有 **content_type === "text"** 的助手消息才算「说完了」
     * （2026-10-21 实测：`model_editable_context` 那条 assistant 消息也带
     *  `finished_successfully` + `end_turn: true` → 早退 → 正文只拿到开头 6 个字 ✗）。 */
    const contentType = String((message['content'] as Json | undefined)?.['content_type'] ?? '');
    if (
      contentType === 'text' &&
      message['status'] === 'finished_successfully' &&
      message['end_turn'] === true
    ) {
      lastAssistantFinished = true;
    }
  }

  result.answer = answer;
  result.thinking = thinking;
  if (lastAssistantFinished) result.finished = true;
  return result;
}
