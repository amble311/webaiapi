/**
 * DeepSeek provider 的可测部分 + 两处实测踩坑的回归。
 *
 * ⚠️ 其余环节（页面登录态、发送、流式读流）只能**真机验证**（已验：
 * 登录态 true、2 个分片、1.6s 收到「收到收到」）。这里钉住两件容易复发的事：
 * ① XHR 捕获必须按 URL 过滤；② provider 注册与模型名。
 */
import { describe, expect, it } from 'vitest';

import { SSE_CAPTURE_JS } from '../../src/browser/sse-capture.js';
import { PLATFORMS_WITH_PROVIDER } from '../../src/browser/platforms.js';
import {
  classifyLoginState,
  isExpiryStillValid,
  initTokenJs,
  guardDeepseekPrompt,
  DeepSeekBrowserProvider,
} from '../../src/providers/deepseek.js';

describe('DeepSeekBrowserProvider', () => {
  it('模型名就是 `deepseek`（不加 -chat / -reasoner 后缀）', () => {
    const p = new DeepSeekBrowserProvider({ accountId: 'acc1' });
    expect(p.models).toEqual(['deepseek']);
    expect(p.platform).toBe('deepseek-browser');
    expect(p.getAccountId()).toBe('acc1');
  });

  it('deepseek 已声明实现对话能力（与工厂表一致，见 platforms 的一致性断言）', () => {
    expect(PLATFORMS_WITH_PROVIDER).toContain('deepseek');
  });

  it('提示词守卫：正常长度原样返回，超长保留**末尾**', () => {
    expect(guardDeepseekPrompt('短提示')).toBe('短提示');
    const long = 'A'.repeat(100) + 'B'.repeat(64_005);
    const out = guardDeepseekPrompt(long);
    expect(out.length).toBe(64_000);
    expect(out.endsWith('B')).toBe(true);
  });
});

/**
 * ⭐ 2026-10-16 实测踩坑：`sse-capture.ts` 的 **XHR 分支原来不过滤 URL**，
 * 任意 XHR（设置轮询/埋点）都会覆盖 `xhrText` —— deepseek 的 completion 流就是这样
 * 被一个 95 字节的小请求盖掉（chatglm 走 fetch，所以一直没暴露）。
 */
describe('XHR 流捕获必须按 URL 过滤', () => {
  it('⭐ xhrText 只在「像流」的 URL 上累积（有 isStream 守卫）', () => {
    expect(SSE_CAPTURE_JS).toContain('isStream');
    expect(SSE_CAPTURE_JS).toContain('_looksLikeStream');
    // 守卫必须在赋值之前：`if (isStream) {` 与 xhrText 赋值同段
    const idx = SSE_CAPTURE_JS.indexOf('if (isStream) {');
    const assign = SSE_CAPTURE_JS.indexOf('xhrText = t');
    expect(idx).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(idx);
  });

  it('deepseek 的 completion 能命中「像流」判定（chat|completion 关键字）', () => {
    // 判定式 `/（chat|conversation|assistant|generate|completion|message|sse|stream）/i`
    const url = 'https://chat.deepseek.com/api/v0/chat/completion';
    expect(/(chat|conversation|assistant|generate|completion|message|sse|stream)/i.test(url)).toBe(
      true,
    );
  });
});

/**
 * ⭐ 2026-10-16 实测事故：token 注入脚本**无条件覆盖** localStorage →
 * 把 deepseek 应用自己刷新出的（更新的）token 打死 → 每次导航后页面进不去 /
 * 找不到输入框（用户报「模型突然不可用」，日志里是反复的
 * 「页面 token 与凭证不一致 → 重新注入启动脚本并重载」）。
 *
 * deepseek 会**轮换 token**（`/api/v0/users/current` 的响应里就有 `token` 字段），
 * 页面那份与凭证文件里的不同**属正常**。所以：只在页面**没有任何** token 时才种。
 * 真机探针已验：空 storage → 写入 ✓；已有轮换 token → 原样保留 ✓。
 */
describe('token 注入脚本（只种不覆盖）', () => {
  const js = initTokenJs('TOKEN_ABC');

  it('⭐ 带「已有 token 就直接返回」的守卫', () => {
    expect(js).toContain("localStorage.getItem('userToken')");
    expect(js).toContain('if (cur.length > 2) return');
  });

  it('凭证 token 被内联进脚本（首次引导用）', () => {
    expect(js).toContain('TOKEN_ABC');
    expect(js).toContain('__version');
  });

  it('脚本是 IIFE（可以直接喂给 addInitScript）', () => {
    expect(js.trim().startsWith('(() =>')).toBe(true);
    expect(js.trim().endsWith(')()')).toBe(true);
  });
});

/**
 * ⭐ 登录态分类（2026-10-17 用户要求：「进入平台时」与「回复异常时」都要判断是否登录成功）。
 *
 * 判据来自实测：会话被作废时页面**跳到 `/sign_in`**、`localStorage.userToken` 被清成
 * `{"value":null}`，而用旧 token 打 API 仍 200 —— 所以必须看「页面 token + 路径 + API 判定」三者。
 */
describe('classifyLoginState', () => {
  it('⭐ 跳到 /sign_in → expired（最常见的失效形态）', () => {
    expect(classifyLoginState({ path: '/sign_in', hasToken: false, code: null })).toBe('expired');
    // 即使 token 还在、路径到了 sign_in，也算失效
    expect(classifyLoginState({ path: '/sign_in?x=1', hasToken: true, code: 0 })).toBe('expired');
  });

  it('页面没有 token → expired（新 context / 被清空）', () => {
    expect(classifyLoginState({ path: '/', hasToken: false, code: null })).toBe('expired');
  });

  it('页面有 token 且 API 认（code=0）→ ok', () => {
    expect(classifyLoginState({ path: '/a/chat/s/x', hasToken: true, code: 0 })).toBe('ok');
  });

  it('API 明确拒绝（如 40002 Missing Token / 401）→ expired', () => {
    expect(classifyLoginState({ path: '/', hasToken: true, code: 40002 })).toBe('expired');
    expect(classifyLoginState({ path: '/', hasToken: true, code: -1 })).toBe('expired');
  });

  it('⭐ 请求本身失败（code=null，网络/WAF）→ unknown（**不拦**，避免抖动误杀账号）', () => {
    expect(classifyLoginState({ path: '/', hasToken: true, code: null })).toBe('unknown');
  });
});

/**
 * ⭐ 「已判定失效」标记的语义（2026-10-17 用户反馈：没有输入框时不该一直重试）。
 *
 * 标记**绑定到当时的 bearer**：凭证没变 → 继续快速失败；用户重登（bearer 变了）→ 自动解除。
 */
describe('isExpiryStillValid', () => {
  it('⭐ 凭证没变 → 仍然失效（后续请求快速失败，不再重跑导航）', () => {
    expect(isExpiryStillValid('BEARER_A', 'BEARER_A')).toBe(true);
  });

  it('⭐ 凭证变了（重新登录）→ 自动解除，允许重新尝试', () => {
    expect(isExpiryStillValid('BEARER_A', 'BEARER_B')).toBe(false);
  });

  it('没有标记 → false（正常尝试）', () => {
    expect(isExpiryStillValid(null, 'BEARER_A')).toBe(false);
  });
});
