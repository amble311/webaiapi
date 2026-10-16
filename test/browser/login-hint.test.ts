/**
 * 登录引导（`src/browser/login-hint.ts`）—— 2026-10-16 用户反馈后的改造。
 *
 * 反馈原话：登录交互太差，要在终端按回车，而终端打印内容太多，
 * 提醒按回车的字都看不见了；问 Playwright 能不能注入网页来引导。
 *
 * 改造要点（这里钉住）：
 * 1. 引导横幅**注入到页面里**（用户盯着浏览器，不是终端）；
 * 2. 登录完成靠**自动检测**（凭证里出现真实身份），回车只是逃生口；
 * 3. 横幅样式只能走 **CSSOM**（CSP 会拦 `<style>` 与 `style="…"`）；
 * 4. 横幅必须 `pointer-events: none`（否则挡住登录表单的点击）。
 */
import { describe, expect, it } from 'vitest';

import {
  LOGIN_HINT_ACTION_ATTR,
  LOGIN_HINT_ELEMENT_ID,
  isGuestCredential,
  isLoginHintAction,
  loginHintContent,
  loginHintJs,
  looksLoggedIn,
  removeLoginHintJs,
} from '../../src/browser/login-hint.js';

/** 造一个 JWT（payload 是 base64url，与 `decodeJwt` 的口径一致）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

describe('looksLoggedIn —— 「登录是否完成」的判据', () => {
  it('⭐ chatglm：抓到 JWT（登录后才有的 authorization 头）→ 已登录', () => {
    const jwt = fakeJwt({ sub: '洛小北', uid: '699925cdfe32a09ac872e10a' });
    expect(looksLoggedIn('chatglm', { bearer: jwt })).toBe(true);
  });

  it('⚠️ chatglm：只有 chatglm_user_id cookie（游客也有）→ 不算登录', () => {
    // 这个 cookie 游客就带着；只看 identifier 会在用户还没登录时就提前收尾
    expect(
      looksLoggedIn('chatglm', {
        cookies: [{ name: 'chatglm_user_id', value: 'guest-uid' }] as never,
      }),
    ).toBe(false);
  });

  it('chatglm：什么都没有 → 未登录', () => {
    expect(looksLoggedIn('chatglm', {})).toBe(false);
  });

  it('其他平台：拿到 bearer 就算（identify 走 bearer 前缀）', () => {
    expect(looksLoggedIn('deepseek', { bearer: 'abc123def456ghi789' })).toBe(true);
    expect(looksLoggedIn('deepseek', {})).toBe(false);
  });
});

describe('loginHintJs —— 注入页面的引导横幅', () => {
  const js = loginHintJs({
    title: '请在此页面登录 ChatGLM',
    tips: ['① 在这个页面完成登录', '② 登录成功后本页会自动继续'],
  });

  it('带上固定 id（注入/更新/移除三处共用，必须幂等）', () => {
    expect(js).toContain(LOGIN_HINT_ELEMENT_ID);
    expect(js).toContain('getElementById');
    expect(js).toContain('appendChild');
  });

  it('⭐ 样式只走 CSSOM —— 绝不出现 style=" 或 <style>（CSP 会拦）', () => {
    expect(js).toContain('el.style');
    expect(js).toContain('s.position');
    expect(js).not.toContain('style="');
    expect(js).not.toContain('<style');
  });

  it('⭐ pointer-events: none —— 横幅底下就是登录表单，不能挡点击', () => {
    expect(js).toContain("s.pointerEvents = 'none'");
  });

  it('文案进得去（标题 + 逐行提示）', () => {
    expect(js).toContain('请在此页面登录 ChatGLM');
    expect(js).toContain('② 登录成功后本页会自动继续');
  });

  it('removeLoginHintJs 能移除它', () => {
    expect(removeLoginHintJs()).toContain(LOGIN_HINT_ELEMENT_ID);
    expect(removeLoginHintJs()).toContain('removeChild');
  });
});

describe('loginHintContent —— 文案', () => {
  it('等待中：说清「在哪登录 / 会自动继续 / 不必回终端按回车」', () => {
    const content = loginHintContent({
      platformName: 'ChatGLM',
      elapsedSeconds: 12,
      timeoutSeconds: 600,
    });
    const all = [content.title, ...content.tips].join('\n');

    expect(content.tone).toBe('wait');
    expect(all).toContain('ChatGLM');
    expect(all).toContain('会自动继续');
    // 要指向页面上的按钮（用户 2026-10-16 澄清：用页面按钮取代终端那两次回车）
    // ⚠️ 按钮**文字**在 loginHintJs 的 actions 里（下面「页面按钮」那一组断言），
    //    这里只断言文案把用户引向按钮 —— 两处刻意分开，避免文案改了还要改两遍。
    expect(all).toContain('点下面的按钮');
    expect(all).toContain('回终端按回车');
    expect(all).toContain('600s');
  });

  it('⭐ 标题带「已等待 Ns」：横幅每 2s 重画，用户能看出程序在等他', () => {
    const early = loginHintContent({ platformName: 'ChatGLM', elapsedSeconds: 1, timeoutSeconds: 600 });
    const later = loginHintContent({ platformName: 'ChatGLM', elapsedSeconds: 42, timeoutSeconds: 600 });

    // 刚打开时不显示（避免「已等待 0s」这种噪音）
    expect(early.title).not.toContain('已等待');
    expect(later.title).toContain('已等待 42s');
    expect(later.title).toContain('ChatGLM');
  });

  it('第二个账号时追加「先退出登录」的提醒', () => {
    const withWarn = loginHintContent({
      platformName: 'ChatGLM',
      elapsedSeconds: 0,
      timeoutSeconds: 600,
      warnExistingSession: true,
    });
    const without = loginHintContent({
      platformName: 'ChatGLM',
      elapsedSeconds: 0,
      timeoutSeconds: 600,
    });

    expect([withWarn.title, ...withWarn.tips].join()).toContain('退出登录');
    expect([without.title, ...without.tips].join()).not.toContain('退出登录');
  });

  it('检测到登录后：改成绿色「正在保存凭证」，并提示别关浏览器', () => {
    const content = loginHintContent({
      platformName: 'ChatGLM',
      elapsedSeconds: 30,
      timeoutSeconds: 600,
      tone: 'done',
    });
    expect(content.tone).toBe('done');
    expect(content.title).toContain('已检测到登录');
    expect(content.tips.join()).toContain('不要关闭浏览器');
  });
});

/**
 * ⭐ 2026-10-16 事故回归：chatglm 给**任何访客**都发匿名 JWT，
 * 「有 JWT = 已登录」的判据会让「用户什么都没做」也判定成功 ——
 * 那天就把两份真实账号的凭证覆盖成了游客凭证（靠 `.bak` 才救回来）。
 * 下面的 JWT 形状是**从事故现场两份文件里实测抓下来的**。
 */
describe('游客 token 不能算登录（isGuestCredential）', () => {
  const guestJwt = fakeJwt({
    sub: '2d114a0b74564173af6b35e448298e2f',
    uid: '6ad2050622a1887d45d94414',
    is_guest: true,
    mode: 1,
    type: 'access',
  });
  const realJwt = fakeJwt({ sub: '洛小北', uid: '6a683998b020eb21d4825166', type: 'access' });

  it('⭐ 游客 JWT（is_guest=true，sub 是 32 位哈希）→ 判为游客、且不算登录', () => {
    expect(isGuestCredential('chatglm', { bearer: guestJwt })).toBe(true);
    expect(looksLoggedIn('chatglm', { bearer: guestJwt })).toBe(false);
  });

  it('老式游客 token（没有 is_guest 字段，sub 仍是 32 位哈希）→ 也算游客', () => {
    const oldStyle = fakeJwt({ sub: '0d808cbbddf941abbc4c432378b225fd', uid: '6ad204a2539ec40c8b7a8cdb' });
    expect(isGuestCredential('chatglm', { bearer: oldStyle })).toBe(true);
    expect(looksLoggedIn('chatglm', { bearer: oldStyle })).toBe(false);
  });

  it('⭐ 真实账号 JWT（无 is_guest 字段，sub 是用户名）→ 不算游客、判为已登录', () => {
    expect(isGuestCredential('chatglm', { bearer: realJwt })).toBe(false);
    expect(looksLoggedIn('chatglm', { bearer: realJwt })).toBe(true);
  });

  it('没有 token 时不是「游客」（交给 looksLoggedIn 判未登录）', () => {
    expect(isGuestCredential('chatglm', {})).toBe(false);
    expect(looksLoggedIn('chatglm', {})).toBe(false);
  });

  it('其他平台没有这个概念 → 恒 false（不误伤）', () => {
    expect(isGuestCredential('deepseek', { bearer: guestJwt })).toBe(false);
  });
});

/**
 * 页面按钮（2026-10-16 用户建议）：把操作放到页面上，而不是让用户回终端。
 *
 * ⚠️ 两个必须守住的点：
 * 1. `pointer-events` **分层** —— 容器 `none`（不挡登录表单），按钮 `auto`（点得动）；
 * 2. 动作走 `exposeBinding` 回传 + **白名单**校验（不给平台页面留任意指令通道）。
 */
describe('页面按钮', () => {
  const js = loginHintJs({
    title: '请在此页面登录 ChatGLM',
    tips: ['① 在这里登录'],
  });

  it('三个按钮都在，且带 data 属性便于识别', () => {
    expect(js).toContain('data-webaiapi-action');
    expect(js).toContain("'done'");
    expect(js).toContain("'reload'");
    expect(js).toContain("'cancel'");
    expect(js).toContain('✓ 我已登录，继续');
    expect(js).toContain('↻ 重开登录页');
    expect(js).toContain('✕ 取消');
  });

  it('⭐ pointer-events 分层：容器 none（不挡表单）+ 按钮 auto（点得动）', () => {
    expect(js).toContain("s.pointerEvents = 'none'");
    expect(js).toContain("b.style.pointerEvents = 'auto'");
  });

  it('⭐ 点击只写 HTML 属性回传（**不用 exposeBinding** —— 它会留下可枚举指纹）', () => {
    expect(LOGIN_HINT_ACTION_ATTR).toContain('webaiapi');
    expect(js).toContain('setAttribute(cfg.actionAttr');
    // 读走即清除：同一个点击不会被处理两次
    expect(js).toContain('removeAttribute(cfg.actionAttr)');
    // ⚠️ 2026-10-16 实测：exposeBinding 会往页面塞 __playwright__binding__
    //    （可枚举、for…in 可见）→ 反爬一眼看到。这条断言防止有人"改回去"。
    expect(js).not.toContain('__playwright__binding__');
    expect(js).not.toContain('exposeBinding');
  });

  it('⭐ 只在顶层文档注入（微信二维码是 iframe，注进去会压住二维码）', () => {
    expect(js).toContain('window.top !== window.self');
  });

  it('检测到登录后不再渲染按钮（此时只需等保存完成）', () => {
    expect(js).toContain("cfg.tone !== 'done'");
  });

  it('按钮点完就置灰（防连点）', () => {
    expect(js).toContain('b.disabled = true');
    expect(js).toContain('处理中');
  });

  it('⭐ 动作白名单：只认 done/reload/cancel', () => {
    expect(isLoginHintAction('done')).toBe(true);
    expect(isLoginHintAction('reload')).toBe(true);
    expect(isLoginHintAction('cancel')).toBe(true);
    // 其余一律拒绝 —— 平台页面上那个全局函数不能被当成任意指令通道
    expect(isLoginHintAction('rm')).toBe(false);
    expect(isLoginHintAction('')).toBe(false);
    expect(isLoginHintAction(null)).toBe(false);
    expect(isLoginHintAction(42)).toBe(false);
  });
});
