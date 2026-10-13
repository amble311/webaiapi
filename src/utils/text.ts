/**
 * 文本工具 —— 合并 `legacy-python/src/providers/browser_utils.py` 与
 * `playwright_manager.compute_incremental`（Python 里这两个函数**在两处重复**，
 * TS 版只保留这一份）。
 */
import { logger } from '../log/logger.js';

/**
 * 清洗 AI 回复文本。
 *
 * - 去除首尾空白（保留换行）
 * - 过滤零宽字符与不可见控制字符
 * - 移除 Unicode 替换字符 U+FFFD（编码错误时出现）
 */
export function sanitizeMessage(text: unknown): string {
  if (typeof text !== 'string') return '';

  let out = text.trim();
  out = out.replace(/[\u200b-\u200f\u2028-\u202e\ufeff]/g, '');
  out = out.replace(/\ufffd/g, '');
  return out;
}

/**
 * 计算增量文本（**按长度切后缀**）。
 *
 * ⚠️ 不用于 ChatGLM 正文：SSE 载荷本身已提供权威的增量/快照语义
 * （见 `docs/hard-constraints.md`「text / think 载荷的语义」）。
 * 这里保留是为了给「非 SSE 来源」的兜底路径用，以及在文档里作为对照。
 */
export function computeIncremental(
  lastText: string,
  currentText: string,
): string | undefined {
  if (!currentText || !lastText) {
    return currentText ? currentText : undefined;
  }
  // 当前文本比上次短 → 可能被截断或清空了，直接返回全量
  if (currentText.length < lastText.length) return currentText;
  return currentText.slice(lastText.length);
}

/**
 * 截断过长文本并附加说明（Python 的 `truncate_message`，原本只在已删除的平台
 * Provider 里用；这里保留一个显式版本供调试脚本使用）。
 */
export function truncateMessage(text: string, maxLength = 15000): string {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length <= maxLength) return text;

  logger.warn(`AI 回复过长 (${text.length} 字符)，已截断至 ${maxLength} 个字符`);
  return `${text.slice(0, maxLength)}\n\n[webaiapi: ... (truncated, ${text.length - maxLength} chars removed)]`;
}
