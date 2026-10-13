/**
 * DOM 工件清理与标签修复 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * 这些函数专门对付「ChatGLM 把 `<tool_call>` 当 HTML 元素消费掉」造成的破坏：
 * 标签残缺、插入 `<span data-allow-html>`、智能引号、NBSP 等。
 */

/**
 * 清理工具调用值里由 ChatGLM markdown 渲染产生的 HTML 标签。
 *
 * 只移除**明显是 DOM 渲染产物**的标签（`<span>` / `<div>` / `<br>`），
 * 不动 `<script>` / `<style>` 这类可能属于用户代码内容的标签。
 */
export function cleanDomHtml(text: string): string {
  let out = text;

  // ChatGLM 特有的 span（含 data-allow-html 属性）
  out = out.replace(/<span\s+data-allow-html[^>]*>/g, '');
  out = out.replace(/<\/?span[^>]*>/g, '');
  out = out.replace(/<\/?div[^>]*>/g, '');
  out = out.replace(/<br\s*\/?>/g, '\\n');

  // 残留的非断空格
  out = out.replace(/\u00a0/g, ' ');

  return out;
}

/**
 * 修复 DOM 渲染导致的 tool_call 标签破碎（等价于 `_normalize_tool_call_tags`）。
 *
 * 实际日志中出现过的破碎形态：
 * - `<ttool_call>` → `<tool_call>`（多余 t）
 * - `</ttool_call>` → `</tool_call>`
 * - `<t \n ool_call>` → `<tool_call>`（跨行截断）
 * - `<tool \n _call>` → `<tool_call>`
 * - ChatGLM 还会插入 `<arg_key>` / `<arg_value>` 包裹参数
 */
export function normalizeToolCallTags(text: string): string {
  let out = text;

  // 移除 ChatGLM 插入的 <arg_key> / <arg_value> / <arg_*> 标签
  out = out.replace(/<\/?arg_\w+\s*>/g, '');

  out = out.replace(/<t+ool_call\s*>/g, '<tool_call>');
  out = out.replace(/<\/t+ool_call\s*>/g, '</tool_call>');
  out = out.replace(/<t\s*\n\s*ool_call\s*>/g, '<tool_call>');
  out = out.replace(/<tool\s*\n\s*_call\s*>/g, '<tool_call>');

  return out;
}

/**
 * 清理解析后残留在正文中的（空）工具调用标签。
 *
 * JSON 已被移除，但 `<tool_call>` / `</tool_call>` 可能还留在剩余文本里，
 * 会让 assistant 的 content 出现空的工具调用标签。
 */
export function stripLeftoverToolTags(text: string): string {
  if (!text) return '';

  let out = text;

  // 1) 成对的空标签块（中间只有空白）
  out = out.replace(
    /<\s*\/?\s*(?:t+ool_call)\s*>\s*<\s*\/?\s*(?:t+ool_call)\s*>/gi,
    '',
  );
  // 2) 任意残留的单个标签
  out = out.replace(/<\s*\/?\s*t+ool_call\s*>/gi, '');
  // 3) 粘连写法（缺少开头 "<" / 结尾 ">"）
  out = out.replace(/(?<![<\w])t+ool_call\s*>/g, '');
  out = out.replace(/<\s*\/?\s*t+ool_call(?![>\w])/gi, '');

  // 折叠多余空行
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
