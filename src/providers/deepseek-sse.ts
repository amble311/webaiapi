/**
 * DeepSeek 的 SSE 解析 —— `/api/v0/chat/completion`（走 **XHR**，不是 fetch）。
 *
 * ## 协议（2026-10-16 实测抓到完整回合，9 个事件）
 *
 * ```
 * event: ready            data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
 * event: update_session   data: {"updated_at":1792152471.33}
 * （无 event）             data: {"v":{"response":{…完整对象…,"fragments":[…]}}}   ← 初始快照
 * （无 event）             data: {"v":{"p":"response/fragments/-1/content","o":"APPEND","v":"收到"}}
 * （无 event）             data: {"v":{"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},
 *                                                                     {"p":"quasi_status","v":"FINISHED"}]}}
 * （无 event）             data: {"v":{"p":"response/status","o":"SET","v":"FINISHED"}}   ← 完成
 * event: title            data: {"content":"收到收到"}
 * event: close            data: {"click_behavior":"none","auto_resume":false}            ← 流关闭
 * ```
 *
 * 即：**JSON-Patch 风格的增量**。⚠️ 数据帧实测有**三种**形态（缺一不可）：
 * 1. **快照**：`{"v":{"response":{…,"fragments":[…]}}}`；
 * 2. **补丁**：`{"p":<JSON 指针>,"o":"APPEND"|"SET"|"BATCH","v":<值>}`；
 * 3. **裸增量**：`{"v":"了解"}` —— 等价于 APPEND 到最后一个片段。
 *    ⚠️ 长回答里**绝大多数文本**都走这种帧（实测 2.4KB 的流里 77 帧是它），
 *    漏掉它会把整段回答丢成开头的几个字（2026-10-16 实测：2410 字节 → 4 字符）。
 *
 * 补丁帧的语义：
 * - `o=APPEND` + `p=response/fragments/-1/content` → 把文本**追加**到最后一个片段；
 * - `o=SET`    + `p=response/status` → 值为 `FINISHED` 表示生成结束；
 * - `o=BATCH`  → 里面是一组子 patch（token 用量、`quasi_status` 等）。
 *
 * ⚠️ 与 chatglm 那套「整段快照 vs 细粒度增量」是**同一类问题**，但它显式给了操作符，
 * 所以这里不需要猜：按操作符重建即可（`APPEND` 追加、快照替换）。
 * ⚠️ 抓包可能**从流中间开始**（页面复用连接/我们注入得晚）→ 没有快照时也要能从 APPEND
 * 里攒出正文，所以片段数组为空时会按需创建。
 */

/** 事件块（`event:` / `data:`）。 */
interface SseEvent {
  event: string;
  data: string;
}

/** 正文片段（快照里的 `response.fragments[]` 元素）。 */
interface Fragment {
  type?: string;
  content?: string;
  [key: string]: unknown;
}

/** 解析结果。 */
export interface DeepseekSseResult {
  /** 面向用户的正文（`type=RESPONSE` 的片段）。 */
  answer: string;
  /** 思考过程（`type=THINK` 的片段；开启深度思考时才有内容）。 */
  thinking: string;
  /** 是否已结束（`status=FINISHED` 或收到 `event: close`）。 */
  finished: boolean;
  /** 平台模型类型（`default` / `thinking` 等）。 */
  modelType: string;
  /** 本轮回复的消息 id（调试用）。 */
  messageId: number;
  /** 累计 token 用量（平台自己报的，未必等于 OpenAI 口径）。 */
  usageTokens: number;
}

/** 逐事件切分 SSE 文本（容忍多行 `data:` 与多余空行）。 */
export function iterSseEvents(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  if (!raw) return out;

  // 归一化换行；事件之间用空行分隔
  for (const block of raw.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!event && dataLines.length === 0) continue;
    out.push({ event, data: dataLines.join('\n') });
  }
  return out;
}

/** 片段类型：`RESPONSE` 是正文，`THINK` 是思考；未知类型按正文处理（保守，宁可多给内容）。 */
function isThinkFragment(fragment: Fragment): boolean {
  return String(fragment.type ?? '').toUpperCase().includes('THINK');
}

function joinFragments(fragments: ReadonlyArray<Fragment>, kind: 'answer' | 'think'): string {
  const parts = fragments.filter((f) => (kind === 'think' ? isThinkFragment(f) : !isThinkFragment(f)));
  return parts.map((f) => String(f.content ?? '')).join('');
}

/** 解析状态（在 patch 之间保持）。 */
interface ParseState {
  fragments: Fragment[];
  finished: boolean;
  modelType: string;
  messageId: number;
  usageTokens: number;
}

/** 把一段文本追加到「最后一个片段」（没有片段就创建一个）。 */
function appendToLastFragment(state: ParseState, text: string): void {
  if (state.fragments.length === 0) state.fragments.push({ type: 'RESPONSE', content: '' });
  const last = state.fragments[state.fragments.length - 1];
  if (!last) return;
  last.content = `${String(last.content ?? '')}${text}`;
}

/** 应用一个 JSON-Patch 风格的操作（`{p,o,v}`）。`basePath` 供 BATCH 内部相对路径用。 */
function applyPatch(state: ParseState, patch: unknown, basePath = ''): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  const rec = patch as Record<string, unknown>;

  const rawPath = String(rec['p'] ?? '');
  const path = basePath && !rawPath.includes('/') ? `${basePath}/${rawPath}` : rawPath;
  /* ⚠️ BATCH 里的子 patch **没有 `o` 字段**（实测：`{"p":"accumulated_token_usage","v":41}`）
   * → 缺省按「赋值」处理，否则 token 用量/完成标志全丢。 */
  const op = String(rec['o'] ?? '').toUpperCase() || 'SET';
  const value = rec['v'];

  if (op === 'BATCH') {
    if (Array.isArray(value)) for (const sub of value) applyPatch(state, sub, path);
    return;
  }

  if (op === 'APPEND') {
    // ⚠️ 实测：正文增量固定是 `response/fragments/-1/content`
    if (path.endsWith('/fragments/-1/content') && typeof value === 'string') {
      appendToLastFragment(state, value);
      return;
    }
    // 追加一个新片段（防御：未来可能带 type 的对象）
    if (path.endsWith('/fragments') && value && typeof value === 'object') {
      state.fragments.push(value as Fragment);
      return;
    }
    if (path.endsWith('/content') && typeof value === 'string') {
      appendToLastFragment(state, value);
    }
    return;
  }

  if (op === 'SET' || op === 'REPLACE') {
    // 完成信号：`response/status=FINISHED`；BATCH 里还有 `quasi_status=FINISHED`（两个都要认）
    if ((path === 'response/status' || path === 'response/quasi_status') && String(value) === 'FINISHED') {
      state.finished = true;
      return;
    }
    if (path === 'response/accumulated_token_usage' && typeof value === 'number') {
      state.usageTokens = value;
    }
  }
}

/** 应用一个快照（`{"v":{"response":{…}}}`）。 */
function applySnapshot(state: ParseState, response: Record<string, unknown>): void {
  const fragments = response['fragments'];
  if (Array.isArray(fragments)) {
    state.fragments = fragments.map((f) => (f && typeof f === 'object' ? (f as Fragment) : { content: String(f ?? '') }));
  }
  if (typeof response['message_id'] === 'number') state.messageId = response['message_id'];
  /* ⚠️ 快照里的 `model` 实测是**空串**，不能拿它覆盖 `event: ready` 给的 `model_type` */
  const model = String(response['model'] ?? '') || String(response['model_type'] ?? '');
  if (model) state.modelType = model;
  if (typeof response['accumulated_token_usage'] === 'number') {
    state.usageTokens = response['accumulated_token_usage'];
  }
  if (String(response['status'] ?? '') === 'FINISHED') state.finished = true;
}

/**
 * 解析整段 SSE 文本 → `{answer, thinking, finished, …}`。
 *
 * 幂等、无副作用、永不抛 —— provider 在等待循环里会反复调用它（每次拿到新的累积文本）。
 */
export function extractDeepseekSse(raw: string): DeepseekSseResult {
  const state: ParseState = {
    fragments: [],
    finished: false,
    modelType: '',
    messageId: 0,
    usageTokens: 0,
  };

  for (const evt of iterSseEvents(raw)) {
    if (evt.event === 'close') {
      state.finished = true;
      continue;
    }
    if (evt.event === 'ready') {
      try {
        const ready = JSON.parse(evt.data) as Record<string, unknown>;
        if (typeof ready['response_message_id'] === 'number') state.messageId = ready['response_message_id'];
        if (typeof ready['model_type'] === 'string') state.modelType = ready['model_type'];
      } catch {
        // 忽略
      }
      continue;
    }
    // title / update_session / 其它事件都不影响正文
    if (evt.event) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const rec = payload as Record<string, unknown>;

    /* ⚠️ 两种帧的包装**不一样**（实测，写错过一次）：
     * - 快照帧：`{"v":{"response":{…}}}`（外层多了个 `v`）
     * - 补丁帧：`{"p":"…","o":"APPEND"|"SET"|"BATCH","v":<值>}` ← **顶层**，没有外包装 */
    if ('p' in rec || 'o' in rec) {
      applyPatch(state, rec);
      continue;
    }

    const wrapped = rec['v'];

    /* ⚠️⚠️ **帧形态三：裸增量** `{"v":"了解"}`（实测 2026-10-16 漏掉它导致丢答案）。
     * 长回答里绝大多数文本都走这种帧 —— 它等价于
     * `{"p":"response/fragments/-1/content","o":"APPEND","v":…}`（追加到最后一个片段）。
     * 漏掉它的后果：2410 字节的流只解析出 4 个字符（快照的「我需要」+ 第一帧的「先」），
     * 页面 DOM 上却是 169 字的完整回答（用户实测报「回复没有获取完全」）。 */
    if (typeof wrapped === 'string') {
      appendToLastFragment(state, wrapped);
      continue;
    }

    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
      const snapshot = (wrapped as Record<string, unknown>)['response'];
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        applySnapshot(state, snapshot as Record<string, unknown>);
      }
    }
  }

  return {
    answer: joinFragments(state.fragments, 'answer'),
    thinking: joinFragments(state.fragments, 'think'),
    finished: state.finished,
    modelType: state.modelType,
    messageId: state.messageId,
    usageTokens: state.usageTokens,
  };
}
