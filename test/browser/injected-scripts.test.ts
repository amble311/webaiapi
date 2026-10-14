import { describe, expect, it } from 'vitest';

import { SSE_CAPTURE_JS } from '../../src/browser/sse-capture.js';
import { STEALTH_JS } from '../../src/browser/stealth.js';

/**
 * 这两个脚本都是从 Python 版**逐字节抽取**的（见 docs/migration-status.md），
 * 不应该被随意改写。这里只做「关键能力还在不在」的体检 ——
 * 一旦有人误删/误改，能立刻发现，而不是等到线上出现「正文乱码」才察觉。
 *
 * ⚠️ `SSE_CAPTURE_JS` 自 2026-10-14 起**不再是逐字节一致**：为侦察「平台请求体是否接受
 * 客户端工具定义」，追加了请求体捕获（`__glmSSEBodiesGet`）。`STEALTH_JS` 仍然一致。
 */
describe('SSE_CAPTURE_JS', () => {
  it('非空且是立即执行函数', () => {
    expect(SSE_CAPTURE_JS.length).toBeGreaterThan(1000);
    expect(SSE_CAPTURE_JS.trimStart().startsWith('(() =>')).toBe(true);
  });

  it('暴露页面侧接口 __glmSSE / Reset / Get', () => {
    expect(SSE_CAPTURE_JS).toContain('window.__glmSSEHooked');
    expect(SSE_CAPTURE_JS).toContain('window.__glmSSE = _blank()');
    expect(SSE_CAPTURE_JS).toContain('window.__glmSSEReset');
    expect(SSE_CAPTURE_JS).toContain('window.__glmSSEGet');
  });

  it('同时 hook fetch 与 XMLHttpRequest', () => {
    expect(SSE_CAPTURE_JS).toContain('window.fetch');
    expect(SSE_CAPTURE_JS).toContain('XMLHttpRequest.prototype.open');
    expect(SSE_CAPTURE_JS).toContain('XMLHttpRequest.prototype.send');
  });

  it('只抓「可能承载对话内容」的请求，避免把静态资源也缓存下来', () => {
    expect(SSE_CAPTURE_JS).toContain('_looksLikeStream');
    expect(SSE_CAPTURE_JS).toContain('event-stream');
    expect(SSE_CAPTURE_JS).toContain('TextDecoder');
  });

  it('⭐ 侦察能力：同时抓「请求体」（判断平台是否接受客户端工具定义）', () => {
    // 2026-10-14：要回答「能否用平台原生函数调用通道承载客户端工具」，
    // 必须看到页面自己发出去的请求体长什么样。
    expect(SSE_CAPTURE_JS).toContain('window.__glmSSEBodiesGet');
    expect(SSE_CAPTURE_JS).toContain('_record');
    expect(SSE_CAPTURE_JS).toContain('init.body');
    expect(SSE_CAPTURE_JS).toContain('getRequestHeader');
    expect(SSE_CAPTURE_JS).toContain('reqs');
  });
});

describe('STEALTH_JS', () => {
  it('非空且是立即执行函数', () => {
    expect(STEALTH_JS.length).toBeGreaterThan(5000);
    expect(STEALTH_JS.trimStart().startsWith('(() =>')).toBe(true);
  });

  it('包含常见的反检测面（webdriver / plugins / languages / chrome 等）', () => {
    for (const needle of ['webdriver', 'plugins', 'languages', 'navigator']) {
      expect(STEALTH_JS).toContain(needle);
    }
  });
});
