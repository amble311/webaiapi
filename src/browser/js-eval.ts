/**
 * 页面脚本求值辅助。
 *
 * ## ⚠️⚠️ 存在的唯一理由：Playwright Node 与 Python 的一处**不兼容**
 *
 * `page.evaluate(x)` 的语义在两个语言里不一样：
 *
 * | 传入 | Python | Node |
 * |---|---|---|
 * | `"() => ({a:1})"` | **自动调用**该函数 → `{a:1}` | 当作**表达式**求值 → **`undefined`** |
 * | `"(() => ({a:1}))()"` | `{a:1}` | `{a:1}` ✅ |
 * | `() => ({a:1})`（真函数） | `{a:1}` | `{a:1}` ✅ |
 *
 * 实测（Playwright 1.64 / Node 24）：
 * ```
 * evaluate('() => ({a: 1})')            -> undefined
 * evaluate('(() => ({a: 1}))()')        -> {"a":1}
 * evaluate(() => ({a: 1}))              -> {"a":1}
 * ```
 *
 * 这是从 Python 移植时**最危险的一个陷阱**：整条链路上所有 DOM/SSE 操作都会
 * 静默拿到 `undefined`，**不抛异常、不打日志**。表现是「服务起来了、
 * 请求也返回 200，但永远没有正文 / 永远探测不出登录态」——
 * 排查时几乎不可能想到是「函数没被调用」。
 *
 * 因此本文件强制：**凡是要在页面里执行的函数表达式，都必须经 {@link iife} 包装**。
 */
import type { Page } from 'playwright';

/**
 * 把「函数表达式字符串」包装成可求值的 IIFE 表达式。
 *
 * 输入 `() => { return 1; }` → 输出 `(() => { return 1; })()`。
 *
 * ⚠️ 必须保留外层括号：箭头函数直接加 `()` 在 `=>` 与 `{` 之间会被解析错
 * （`() => {}()` 会被当成「返回 undefined 的函数」而不是「调用」）。
 */
export function iife(expression: string): string {
  return `(${expression})()`;
}

/**
 * 在页面里执行函数表达式并取回结果。
 *
 * 语义等价于 Python 的 `page.evaluate("() => {...}")`。
 */
export function evaluateFn<T>(page: Page, fnExpression: string): Promise<T> {
  return page.evaluate(iife(fnExpression)) as Promise<T>;
}
