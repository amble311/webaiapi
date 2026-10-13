/**
 * ChatGLM 的 SSE 原始流解析 —— `legacy-python/src/providers/chatglm_browser.py`
 * 顶部的纯函数部分（第 38~207 行）。
 *
 * 拆出来的原因：这是整个项目**信息保真度的命门**（正文只能来自这里，不能读 DOM），
 * 而它又是纯字符串处理 —— 独立成文件后可以完全不启动浏览器就写单测。
 *
 * ⚠️ 改动本文件前请先读 `docs/hard-constraints.md` 的「`text` / `think` 载荷的语义」。
 */
import { logger } from '../log/logger.js';
import { rawDecodeJson } from '../tools/parse.js';

/* ------------------------------------------------------------------ */
/* 主轮全局（供路由层的降级解析使用）                                   */
/* ------------------------------------------------------------------ */

/**
 * 最近一轮的 SSE 原始数据。
 *
 * 路由层要从「主轮回答」里恢复工具调用（`parse_source` / reparse 输入），
 * 所以主通道每轮结束后会把结果登记在这里。
 *
 * ⚠️ **只有主通道能写**（见 `ChatGLMBrowserProvider.ownsGlobals`）：
 * 辅助通道（后台预压缩）可能与主对话**同时**跑完，若它也写，
 * 主轮的 reparse 就会拿到压缩请求的报文 → 转换出完全错误的工具调用。
 * 辅助通道自己的产出通过 stream 的 chunk 直接返回给调用方，不需要全局。
 */
export interface LastRawSse {
  /** 本轮 SSE 原始报文里提取出的正文（未经 Markdown 渲染，内容保真）。 */
  text: string;
  /** 本轮 SSE 里的「思考」文本。 */
  think: string;
  /** 从 SSE 原文里直接解析出的 tool_calls（目前留空，由路由层填充）。 */
  toolCalls: unknown[];
}

const lastRawSse: LastRawSse = { text: '', think: '', toolCalls: [] };

/** 登记主轮 SSE 结果（仅主通道调用）。 */
export function setLastRawSse(patch: Partial<LastRawSse>): void {
  if (patch.text !== undefined) lastRawSse.text = patch.text;
  if (patch.think !== undefined) lastRawSse.think = patch.think;
  if (patch.toolCalls !== undefined) lastRawSse.toolCalls = patch.toolCalls;
}

/** 读取主轮 SSE 结果。 */
export function getLastRawSse(): Readonly<LastRawSse> {
  return lastRawSse;
}

/** 清空主轮 SSE 结果（测试/诊断用）。 */
export function resetLastRawSse(): void {
  lastRawSse.text = '';
  lastRawSse.think = '';
  lastRawSse.toolCalls = [];
}

/* ------------------------------------------------------------------ */
/* 报文解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 SSE 原始报文中迭代出所有 JSON 对象。
 *
 * ⚠️ ChatGLM 会把多个 JSON 对象**直接拼接**在同一行（中间没有换行分隔），
 * 所以**不能**「按行 `JSON.parse`」，必须从任意位置连续往后扫。
 * 解析失败时只前进一个字符（跳过噪声），与 Python 的 `raw_decode` 循环等价。
 */
export function* iterSseJson(raw: string): Generator<Record<string, unknown>> {
  if (!raw) return;

  let i = 0;
  const n = raw.length;

  while (i < n) {
    const j = raw.indexOf('{', i);
    if (j < 0) break;

    const decoded = rawDecodeJson(raw, j);
    if (!decoded) {
      i = j + 1;
      continue;
    }

    const value = decoded.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      yield value as Record<string, unknown>;
    }
    i = decoded.end;
  }
}

/** `extractSseAll` 的结果。 */
export interface SseExtractResult {
  /** 正文（`type=text`，**取最长、绝不累积**）。 */
  answer: string;
  /** 思考（`type=think`，按 `logic_id` 累积）。 */
  think: string;
  /** 是否收到权威完成信号（`status === "finish"`）。 */
  finished: boolean;
  /**
   * **ChatGLM 平台内部**工具调用的计数（如 `{search: 387, finish: 2}`）。
   * 用于发现「模型跑偏去用网页端自带的联网搜索」。
   */
  platformTools: Record<string, number>;
}

/**
 * 从 SSE 原始报文里一次性提取（正文, 思考, 是否完成, 平台内部工具计数）。
 *
 * ## 报文形态（实测）
 *
 * ```
 * data: {"id":"...","conversation_id":"...","status":"init","parts":[
 *          {"role":"assistant","content":[
 *             {"type":"think","think":"..."},
 *             {"type":"text","text":"<tool_call>\n{\"name\": ...}"}
 *          ]}]}
 * ```
 *
 * ## 四条关键事实（2026-09-27 首测、2026-09-29 修正）
 *
 * 1. `type=text` / `type=think` 的载荷**并不总是**「每事件都带全文」，
 *    实测是两种形态混在一起、按 `logic_id`（一轮回答）组织：
 *    - **增量片段**：一轮内逐字推送的小片段（实测 1~60 字符，共数百条）；
 *    - **累积快照**：该轮结束时再推一条**携带本轮全文**的片段。
 *    判据：一轮结束时 `拼接总长 == 2 × 最长片段`（快照恰好等于所有增量之和）。
 *    因此：
 *    - 轮次**正常结束**（快照已到）时「取最长」与「拼接」结果一致；
 *    - 轮次**被掐断**（空闲/硬超时，快照没来）时「取最长」只拿到一个中途片段
 *      （实测 最长 1787 / 拼接 11097，思考内容丢 84%，且长度再也不增长）。
 *    本函数对 `think` 按 `logic_id` 累积（是快照就替换、是增量就追加），
 *    两种形态都能拿到本轮全文。
 * 2. **`status == "finish"` 是权威完成信号**：整轮结束时推送一条
 *    `status="finish"`（最后一条）。页面 DOM 的「重新生成」按钮检测在 ChatGLM
 *    改版后已不可靠，完成判定应以本信号为主。
 * 3. 该文本未经 Markdown 渲染，引号/下划线/空格都不会丢，
 *    是「写文件 / 改代码」**唯一可用的内容来源**。
 * 4. ⚠️ `text` **仍按「取最长」处理，不做累积拼接**：触发联网搜索时模型会
 *    **整段改写**回答（先给草稿、再换成最终答案），累积拼接会得到
 *    「草稿 + 最终答案」的乱码（2026-09-27 22:17 事故）。
 *    `think` 不做改写，累积是安全的。
 */
export function extractSseAll(raw: string): SseExtractResult {
  let answer = '';
  let finished = false;

  /** `logic_id` → 该轮已累积的思考文本。 */
  const thinkGroups = new Map<string, string>();
  /** 保持出现顺序（Python 用 list 记录 key 顺序）。 */
  const thinkOrder: string[] = [];
  const platformTools: Record<string, number> = {};

  for (const obj of iterSseJson(raw)) {
    if (obj['status'] === 'finish') finished = true;

    const parts = obj['parts'];
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const partRec = part as Record<string, unknown>;

      const lid =
        (typeof partRec['logic_id'] === 'string' && partRec['logic_id']) ||
        (typeof obj['id'] === 'string' ? obj['id'] : '') ||
        '';

      const contents = partRec['content'];
      if (!Array.isArray(contents)) continue;

      for (const item of contents) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Record<string, unknown>;
        const ctype = c['type'];

        if (ctype === 'text') {
          const s = typeof c['text'] === 'string' ? c['text'] : '';
          // ⚠️ 取最长，绝不累积（见上方事实 4）
          if (s.length > answer.length) answer = s;
          continue;
        }

        if (ctype === 'think') {
          const s = typeof c['think'] === 'string' ? c['think'] : '';
          if (!s) continue;

          const prev = thinkGroups.get(lid);
          if (prev === undefined) {
            thinkGroups.set(lid, s);
            thinkOrder.push(lid);
          } else if (s.startsWith(prev)) {
            thinkGroups.set(lid, s); // 累积快照 → 替换
          } else if (!prev.startsWith(s)) {
            thinkGroups.set(lid, prev + s); // 增量片段 → 追加
          }
          // else：新片段是已累积内容的前缀（重复下发）→ 忽略
          continue;
        }

        if (ctype === 'tool_calls') {
          const tc = c['tool_calls'];
          const name =
            tc && typeof tc === 'object' && !Array.isArray(tc)
              ? (tc as Record<string, unknown>)['name']
              : undefined;
          if (typeof name === 'string' && name) {
            platformTools[name] = (platformTools[name] ?? 0) + 1;
          }
        }
      }
    }
  }

  const think = thinkOrder.map((lid) => thinkGroups.get(lid) ?? '').join('\n\n');

  return { answer, think, finished, platformTools };
}

/** `extractSseAll` 的兼容封装：只要正文与思考。 */
export function extractSseAnswer(raw: string): { answer: string; think: string } {
  const { answer, think } = extractSseAll(raw);
  return { answer, think };
}

/* ------------------------------------------------------------------ */
/* 异常判定 / 增量计算                                                 */
/* ------------------------------------------------------------------ */

/** 「浏览器/驱动连接已断开」类错误的特征串。 */
const CONNECTION_ERROR_MARKERS: ReadonlyArray<string> = [
  'connection closed',
  'connection is closed',
  'target closed',
  'target page, context or browser has been closed',
  'browser has been closed',
  'browser closed',
  'juggler',
  'protocol error',
  'pipe closed',
  'broken pipe',
];

/**
 * 异常是否属于「浏览器/驱动连接已断开」类（而不是业务/解析错误）。
 *
 * 命中时应当让共享浏览器实例失效并重建，否则会一直复用坏实例
 * （`isConnected()` 还没更新，不主动失效就只能重启服务）。
 */
export function isBrowserConnectionError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : '';
  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? '');
  const text = `${name}: ${message}`.toLowerCase();
  return CONNECTION_ERROR_MARKERS.some((m) => text.includes(m));
}

/**
 * 计算「安全的」增量文本。
 *
 * `computeIncremental` 只是按长度切后缀，在两个真实场景下会产出**乱码**：
 *
 * 1. **模型中途改写回答**（实测）：ChatGLM 的 `text` 字段并不是单调追加 ——
 *    触发联网搜索时，先输出一句 78 字符的「我先…」，搜索回来后把整段**换掉**
 *    成 2846 字符的最终答案。此时按长度切出来的是「从半句话中间开始」的碎片
 *    （实测客户端看到：``我先`.`requirements.txt`` 和 ``、`requirements.txt`` …）。
 * 2. DOM 兜底路径下，思考正文被最终答案**替换**（长度变小）。
 *
 * 规则：
 * - 前缀真的相同 → 切后缀（正常流式）；
 * - 新文本是旧文本的前缀（变短）→ 视为被替换，不出内容；
 * - 前缀不同（被改写）→ 交出**整段新文本**
 *   （宁可让客户端看到重复，也绝不能给半句话的碎片）。
 */
export function safeIncremental(
  lastText: string,
  currentText: string,
): string | undefined {
  if (!currentText) return undefined;
  if (!lastText) return currentText;
  if (currentText.startsWith(lastText)) return currentText.slice(lastText.length) || undefined;
  if (lastText.startsWith(currentText)) return undefined;
  return currentText;
}

/** 空白页/非平台域名的判定（供 `checkLoginStatus` 决定是否导航）。 */
export function isBlankOrForeignUrl(url: string, host: string): boolean {
  if (!url || url === 'about:blank') return true;
  return !url.includes(host);
}

/** 记一条 SSE 解析诊断日志（保持与原实现同样的可观测性）。 */
export function logSseSummary(raw: string, result: SseExtractResult): void {
  logger.info(
    `[chatglm] SSE 原始流捕获成功: 原始长度=${raw.length}, ` +
      `回答长度=${result.answer.length}, 思考长度=${result.think.length}, ` +
      `完成信号=${result.finished}, 平台内部工具=${JSON.stringify(result.platformTools)}`,
  );
}
