/**
 * SSE 原始流捕获脚本（浏览器注入用）。
 *
 * 为什么必须抓 SSE 而不是只用 DOM `innerText`：平台把回答按 Markdown 渲染后输出，
 * `innerText` 的信息已被破坏（下划线被当加粗吞掉、半角引号变全角、NBSP 混入、
 * 还夹着用户自己的提问）。写文件场景下这些破坏是致命的 —— 写进去的代码是坏的。
 *
 * 因此在页面层 hook `fetch` / `XMLHttpRequest`，把**未经渲染的 SSE 原文**
 * 缓存到 `window.__glmSSE`，由 Node 侧读取解析。
 *
 * ⚠️ 与原实现（已删除的 Python 版）的差异：**本文件不再逐字节一致** —— 2026-10-14
 * 为了侦察「网页平台自己的请求体是否接受客户端工具定义」（决定能否用平台原生函数调用
 * 通道承载客户端工具）追加了**请求体捕获**。页面侧接口因此多了一个：
 *
 * 页面侧接口：
 * - `window.__glmSSEReset()`       —— 开新对话前清空（同时清请求体记录）
 * - `window.__glmSSEGet()`         —— 取 `{ text, xhrText, done, urls, rawCount }`
 * - `window.__glmSSEBodiesGet()`   —— 取捕获到的平台**请求体**列表（侦察用，最多 20 条）
 *
 * 修改本脚本后请同步 `test/browser/injected-scripts.test.ts` 的体检断言。
 */
export const SSE_CAPTURE_JS = `
(() => {
  if (window.__glmSSEHooked) return;
  window.__glmSSEHooked = true;

  // 单条请求体的截断长度：够装下最长提示词 + 其余字段
  const _BODY_MAX = 70000;
  const _REQ_MAX = 20;

  const _blank = () => ({ raws: [], xhrText: '', done: false, urls: [], reqs: [] });
  window.__glmSSE = _blank();
  window.__glmSSEReset = () => { window.__glmSSE = _blank(); };

  window.__glmSSEGet = () => {
    const s = window.__glmSSE || _blank();
    return {
      text: (s.raws || []).join(''),
      xhrText: s.xhrText || '',
      done: !!s.done,
      urls: s.urls || [],
      rawCount: (s.raws || []).length
    };
  };

  /** 侦察用：把请求体转成可读字符串（吞掉一切异常）。 */
  const _snip = (v) => {
    try {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') {
        return v.length > _BODY_MAX ? v.slice(0, _BODY_MAX) + '\\u2026[truncated]' : v;
      }
      if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) {
        return _snip(v.toString());
      }
      if (typeof FormData !== 'undefined' && v instanceof FormData) {
        const o = {};
        v.forEach((val, k) => { o[k] = (typeof val === 'string') ? val : '[blob]'; });
        return _snip(JSON.stringify(o));
      }
      if (typeof Blob !== 'undefined' && v instanceof Blob) {
        return '[Blob ' + v.size + ' bytes]';
      }
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) {
        return '[ArrayBuffer ' + v.byteLength + ' bytes]';
      }
      if (typeof v === 'object') {
        // ReadableStream / 其它不可序列化的体
        return _snip(JSON.stringify(v));
      }
      return String(v);
    } catch (e) {
      return '[unserializable]';
    }
  };

  /** 记一条请求（只留最近 _REQ_MAX 条）。 */
  const _record = (method, url, contentType, body) => {
    try {
      const reqs = window.__glmSSE.reqs;
      reqs.push({
        method: method || '',
        url: String(url || '').slice(0, 300),
        contentType: String(contentType || ''),
        body: _snip(body)
      });
      if (reqs.length > _REQ_MAX) reqs.splice(0, reqs.length - _REQ_MAX);
    } catch (e) {}
  };

  window.__glmSSEBodiesGet = () => {
    const s = window.__glmSSE || _blank();
    return s.reqs || [];
  };

  /** 从 fetch 的 init / Request 对象里取 content-type。 */
  const _headerOf = (headers, name) => {
    try {
      if (!headers) return '';
      if (typeof headers.get === 'function') return headers.get(name) || '';
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      return key ? String(headers[key]) : '';
    } catch (e) {
      return '';
    }
  };

  // 只关心「可能承载对话内容」的请求，避免把静态资源也抓下来
  const _looksLikeStream = (ct, url) => {
    try {
      /* ⚠️ 平台可设 window.__glmSSEUrlFilter（子串）：只记这个 URL 的流。
       * 2026-10-19 实测（ChatGPT）：页面同时推多个 backend-api 流，
       * 不过滤时正文会被后一个流覆盖 → 只拿到开头一两个字。 */
      const filter = window.__glmSSEUrlFilter;
      if (typeof filter === 'string' && filter.length > 0) {
        return String(url || '').indexOf(filter) >= 0;
      }
    } catch (e) {}
    ct = (ct || '').toLowerCase();
    url = url || '';
    if (ct.indexOf('event-stream') >= 0) return true;
    if (ct.indexOf('stream') >= 0) return true;
    return /(chat|conversation|assistant|generate|completion|message|sse|stream)/i.test(url);
  };

  // ---- 1) fetch 拦截 ----
  const _origFetch = window.fetch;
  if (_origFetch) {
    window.fetch = async function (...args) {
      // 侦察：**请求体**在 await 之前就得取（body 可能是流，响应回来就消费掉了）
      let reqUrl = '';
      try {
        reqUrl = (typeof args[0] === 'string') ? args[0]
               : (args[0] && args[0].url) ? args[0].url : '';
        if (_looksLikeStream('', reqUrl)) {
          const init = args[1] || {};
          const body = (init.body !== undefined && init.body !== null)
            ? init.body
            : (args[0] && typeof args[0] === 'object' ? args[0].body : null);
          _record(
            init.method || (args[0] && args[0].method) || 'GET',
            reqUrl,
            _headerOf(init.headers, 'content-type') || _headerOf(args[0] && args[0].headers, 'content-type'),
            body
          );
        }
      } catch (e) {}

      const resp = await _origFetch.apply(this, args);
      try {
        const url = reqUrl;
        const ct = (resp && resp.headers && resp.headers.get)
          ? (resp.headers.get('content-type') || '') : '';
        if (resp && resp.body && _looksLikeStream(ct, url)) {
          try { window.__glmSSE.urls.push(url.slice(0, 200)); } catch (e) {}
          const clone = resp.clone();
          const reader = clone.body.getReader();
          const dec = new TextDecoder('utf-8');
          (async () => {
            try {
              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                window.__glmSSE.raws.push(dec.decode(r.value, { stream: true }));
              }
            } catch (e) {
            } finally {
              window.__glmSSE.done = true;
            }
          })();
        }
      } catch (e) {}
      return resp;
    };
  }

  // ---- 2) XMLHttpRequest 拦截（部分接口走 XHR 流式）----
  try {
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { this.__glmURL = url || ''; this.__glmMethod = method || ''; } catch (e) {}
      return _origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      const self = this;
      // ⚠️ 必须按 URL 过滤：不过滤的话**任意 XHR**（设置轮询、埋点…）都会覆盖 xhrText，
      //    实测 deepseek 的 completion 流就是这样被一个 95 字节的小请求盖掉（2026-10-16）。
      let isStream = false;
      try { isStream = _looksLikeStream('', self.__glmURL); } catch (e) { isStream = false; }
      try {
        // 侦察：请求体
        if (isStream) {
          let ctype = '';
          try { ctype = self.getRequestHeader ? (self.getRequestHeader('content-type') || '') : ''; } catch (e) {}
          _record(self.__glmMethod || 'POST', self.__glmURL, ctype, args[0]);
        }
      } catch (e) {}
      if (isStream) {
        try {
          window.__glmSSE.urls.push(String(self.__glmURL || '').slice(0, 200));
        } catch (e) {}
        try {
          self.addEventListener('progress', () => {
            try {
              const t = self.responseText || '';
              if (t) window.__glmSSE.xhrText = t;
            } catch (e) {}
          });
          self.addEventListener('load', () => {
            try {
              const t = self.responseText || '';
              if (t) window.__glmSSE.xhrText = t;
            } catch (e) {}
          });
        } catch (e) {}
      }
      return _origSend.apply(self, args);
    };
  } catch (e) {}
})();
`;

/**
 * 重置捕获（开新对话 / 发新消息前调用）。
 *
 * ⚠️ 放在本文件是因为它操作的是本文件定义的 `window.__glmSSE*`；
 * `chatglm-dom.ts` 只是**转发导出**（保持既有 import 不动），
 * deepseek 等其它 provider 也直接从这里取，避免跨平台 import 平台专属文件。
 */
export const RESET_SSE_JS = `() => { if (window.__glmSSEReset) window.__glmSSEReset(); }`;

/** 读取页面捕获到的 SSE 原始文本（`{ text, xhrText, done, urls, rawCount }`）。 */
export const SSE_GET_JS = `() => (window.__glmSSEGet ? window.__glmSSEGet() : null)`;
