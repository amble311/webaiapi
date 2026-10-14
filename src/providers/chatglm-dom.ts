/**
 * ChatGLM 页面侧脚本（`page.evaluate()` 执行的 JS）—— 小的那些。
 *
 * 从 `legacy-python/src/providers/chatglm_browser.py` 的 `page.evaluate("""...""")`
 * 字符串**原样抽出**并集中放这里，好处：Provider 类只剩控制流；这些脚本可单独审阅
 * （它们是「页面当前处于什么状态」的唯一真相）。
 *
 * ⚠️ 字符串里的 `\\n` / `\\.` 是**给浏览器看的转义**（等价于 Python 的 `\\n`），
 * 改动时请保持「反斜杠+n」两字符写法。
 * ⚠️ 读 DOM 得到的正文**绝不作为最终答案**（Markdown 渲染会破坏内容）。
 * 正文一律来自 SSE；DOM 只用于「诊断 / 兜底 / 等待循环的活性判断」。
 *
 * 大脚本在 `chatglm-dom-extract.ts`。
 */

/** 探测是否**已登录**（访客不算登录）。 */
export const PROBE_LOGGED_IN_JS = `() => {
    const nameEl = document.querySelector(
        '.sidebar-user-name, .userInfoBar, [class*="sidebar-user-name"], ' +
        '[class*="userInfoBar"], [class*="user-name"], [class*="userName"]'
    );
    const raw = nameEl ? (nameEl.innerText || '').replace(/\\n/g, ' ').trim() : '';
    const name = (raw.split(/\\s+/)[0] || '');
    let has_user_el = false;
    for (const sel of ['.user-info', '.avatar', '[class*="user-info"]',
                       '[class*="avatar"]', '[class*="user"]']) {
        for (const el of document.querySelectorAll(sel)) {
            if (el.offsetParent !== null &&
                el.getBoundingClientRect().height > 0) {
                has_user_el = true;
                break;
            }
        }
        if (has_user_el) break;
    }
    return { name: name, raw: raw.slice(0, 40), has_user_el: has_user_el };
}`;

/** 思考阶段检测（5 种策略，任一命中即「仍在思考」）。 */
export const DETECT_THINKING_JS = `() => {
    const thinkingEl = document.querySelector('.advance-thinking');
    if (thinkingEl && !thinkingEl.classList.contains('collapse')) return true;

    const statusEls = document.querySelectorAll(
        '.advance-thinking-status, .advance-thinking-status_inner, ' +
        '.advance-thinking-done, .advance-thinking-done_text, ' +
        '[class*="thinking-status"], [class*="thinking-done"]'
    );
    for (const el of statusEls) {
        if (el.offsetHeight <= 0) continue;
        const t = (el.innerText || '').trim();
        if (/构思回复|分析请求|思考中|正在思考|thinking/i.test(t)) {
            if (!/思考结束|已深度思考|思考完成|ended|complete/i.test(t)) return true;
        }
    }

    const ansEls = document.querySelectorAll(
        '.answer-content-wrap:not(.text-advance-thinking-content), .answer-content'
    );
    for (const el of ansEls) {
        if (el.offsetHeight <= 0) continue;
        const t = (el.innerText || '').trim();
        if (/^构思回复|^分析请求|^跳过思考/.test(t)) return true;
        if (/\\n构思回复[:：]|\\n分析请求[:：]/.test(t)) return true;
    }

    const stopSelectors = [
        'button[aria-label*="stop" i]', 'button[aria-label*="停止"]',
        'button[class*="stop-generat"]', '[class*="stop-generat"]',
    ];
    for (const sel of stopSelectors) {
        try {
            const el = document.querySelector(sel);
            if (el && el.offsetHeight > 0 && !el.disabled) return true;
        } catch(e) {}
    }

    const loadingEls = document.querySelectorAll(
        '.search-loading-container, .loading-text, [class*="search-loading"]'
    );
    for (const el of loadingEls) {
        if (el.offsetHeight > 0) return true;
    }
    return false;
}`;

/** 完成检测（DOM 兜底；权威信号是 SSE 的 `status == "finish"`）。 */
export const DETECT_COMPLETION_JS = `() => {
    const regenEls = document.querySelectorAll(
        '.regenerate.canuse, i.regenerate.canuse, .shim.regenerate.canuse'
    );
    for (const el of regenEls) {
        if (el.offsetHeight > 0 && el.offsetWidth > 0) return true;
    }

    const containerEls = document.querySelectorAll('.regenerate-part-container');
    for (const el of containerEls) {
        if (el.offsetHeight > 0 && el.offsetWidth > 0) return true;
    }

    return false;
}`;

/**
 * 页面**最后一条** `.answer` 是否就是平台并发/限流提示。
 *
 * ⚠️ 只看 `.answer`，**不看 body**：`document.body.innerText` 里还包含我们自己发出去的
 * 提示词（历史被拍平后一起发过去）。一旦某轮出现过限流提示，这段文字就会随历史进入
 * 后续每一轮的 prompt → 用 body 判断会**永久误判**为限流，把正常请求一律掐掉。
 */
export const PAGE_SHOWS_BUSY_JS = `() => {
    const els = document.querySelectorAll('.answer');
    if (!els.length) return false;
    const t = (els[els.length - 1].innerText || '').trim();
    if (!t || t.length > 120) return false;
    return /请等待其他对话生成完毕|本次回答已被终止|还有对话正在生成|正在生成其他回答|请求过于频繁|过于频繁|请稍后再试/.test(t);
}`;

/**
 * 读取平台限制提示**原文**（回传给客户端用）。
 *
 * 只截取「关键词 + 紧跟的短尾」并在第一个句号/换行处截断 ——
 * 不要用 `[^\\n]*` 贪婪匹配整行：页面上一行里可能跟随着我们自己的提示词
 * （曾抓到「请求过于频繁，请稍后再试。…请稍等 1~2 分钟后重试。现在输出工具调用…」）。
 */
export const READ_BUSY_NOTICE_JS = `() => {
    const els = document.querySelectorAll('.answer');
    const src = els.length
        ? (els[els.length - 1].innerText || '')
        : (document.body.innerText || '');
    const m = src.match(/(请求过于频繁|请等待其他对话生成完毕|还有对话正在生成|正在生成其他回答)([^\\n]{0,20})/);
    if (!m) return '';
    return (m[1] + (m[2] || '')).split(/[。\\n]/)[0].trim();
}`;

/** 页面是否存在聊天输入框（判断页面是否处于可聊天状态）。 */
export const HAS_INPUT_BOX_JS = `() => {
    if (document.querySelector('textarea')) return true;
    if (document.querySelector('[contenteditable="true"]')) return true;
    return false;
}`;

/** 统计当前对话轮数（校验消息是否真正发出）。 */
export const COUNT_CONVERSATION_ITEMS_JS =
  `() => document.querySelectorAll('.conversation-list-outer .item.conversation-item').length`;

/** 读取输入框当前文本长度（-1 表示没找到输入框）。 */
export const INPUT_VALUE_LEN_JS = `() => {
    const t = document.querySelector('textarea');
    if (t) return (t.value || '').length;
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return (ce.innerText || '').length;
    return -1;
}`;

/** 输入框是否已被清空（ChatGLM 提交成功后会清空输入框）。 */
export const IS_INPUT_CLEARED_JS = `() => {
    const t = document.querySelector('textarea');
    if (t) return (t.value || '').trim() === '';
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return (ce.innerText || '').trim() === '';
    return false;
}`;

/** 清空输入框（发送前）。 */
export const CLEAR_INPUT_JS = `() => {
    const t = document.querySelector('textarea');
    if (t) { t.value = ''; }
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) { ce.innerHTML = ''; }
}`;

/**
 * 关闭遮挡浮层的第 1 步：点掉浮层内可见的关闭按钮。
 *
 * ChatGLM 基于 Element UI，页面会偶发出现遮罩层（loading/公告弹窗），
 * 导致 Playwright 点击输入框或发送按钮时被拦截
 * （报错 "subtree intercepts pointer events"），消息因此发不出去。
 */
export const DISMISS_OVERLAY_CLOSE_JS = `() => {
    const sels = [
        '.el-dialog__headerbtn', '.el-dialog__close',
        '.el-message-box__headerbtn', '.el-message-box__close',
    ];
    let n = 0;
    for (const s of sels) {
        document.querySelectorAll(s).forEach(el => {
            try { el.click(); n++; } catch (e) {}
        });
    }
    return n;
}`;

/** 第 2 步：统计仍然可见的遮挡浮层数量（>0 时按 Esc）。 */
export const DISMISS_OVERLAY_BLOCKING_JS = `() => {
    let n = 0;
    document.querySelectorAll('.el-overlay, .el-overlay-dialog').forEach(el => {
        const st = getComputedStyle(el);
        if (st.display !== 'none' && st.visibility !== 'hidden' &&
            el.getBoundingClientRect().height > 0) n++;
    });
    return n;
}`;

/** 第 3 步兜底：让残留遮罩不再拦截指针事件。 */
export const DISMISS_OVERLAY_FALLBACK_JS = `() => {
    document.querySelectorAll('.el-overlay, .el-overlay-dialog').forEach(el => {
        const st = getComputedStyle(el);
        if (st.display !== 'none') {
            el.style.pointerEvents = 'none';
        }
    });
}`;

/** 清空页面上的 SSE 捕获缓冲（每轮请求前调用）。 */
export const RESET_SSE_JS = `() => { if (window.__glmSSEReset) window.__glmSSEReset(); }`;

/** 读取页面捕获到的 SSE 原始文本。 */
export const SSE_GET_JS = `() => (window.__glmSSEGet ? window.__glmSSEGet() : null)`;

/**
 * 侦察：读取页面捕获到的**平台请求体**。
 *
 * 目的：判断「能否把客户端工具定义交给平台、用它的原生函数调用通道承载客户端工具」。
 * 见 `SSE_CAPTURE_JS` 的说明与 `docs/migration-status.md`。
 */
export const REQUEST_BODIES_GET_JS = `() => (window.__glmSSEBodiesGet ? window.__glmSSEBodiesGet() : null)`;

/**
 * 侦察：找出页面上与「联网搜索 / 深度思考 / 工具」有关的开关控件。
 *
 * ## 为什么要找它们（2026-10-14 实测）
 * 平台自己发出去的 ask 请求体里有 `meta_data.is_networking`（默认 **true**）、
 * `chat_mode: "deep_thinking"`、`reasoning_effort: "max"`：
 * 前者让模型不停去调平台自带的联网搜索（`search` 单轮刷 57 次），
 * 后者让每回合要「想」90~200s。这两个都是**页面 UI 状态**，
 * 只有点到对应开关才能在发请求前改掉它们。
 *
 * 因此先把候选控件与本地存储键 dump 出来（`logs/chatglm_page_toggles.txt`），
 * 拿到稳定选择器后再实现「发送前关掉它们」。
 */
/**
 * 发送前设置页面开关：**关掉「联网搜索」**、**把「思考强度」降到「快速」**。
 *
 * ## 为什么（2026-10-14 实测）
 * 平台 ask 请求体里默认是 `is_networking: true` + `chat_mode: deep_thinking` +
 * `reasoning_effort: max`：
 * - 联网开着 → 模型把「bash 怎么删带空格的目录」当检索问题，单轮刷 57 次 `search`，耗 210s；
 * - 极致思考 → 每回合「想」90~200s。
 * 两个都是**页面 UI 状态**，所以在发送前点掉它们（探针给出选择器：
 * `.search-btn`、`.item-think` → `.think-mode-item`）。
 *
 * 幂等：已经是目标状态就不点（返回 `changed:false`）。
 * 注意：这里用页面内 `el.click()`（不受 Playwright 可见性检查影响），
 * 因为「思考强度」子菜单是 popper —— 渲染在 DOM 里但默认隐藏。
 */
export const APPLY_CHAT_PREFS_JS = `() => {
    const clip = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, n || 80);
    const popper = (el) => {
        try {
            const p = el.closest('[class*="popper"], [class*="dropdown"], [class*="submenu"], [class*="menu"]');
            return p ? clip(p.className, 60) : '';
        } catch (e) { return ''; }
    };
    const snapItem = (el, i) => ({
        i: i,
        text: clip(el.innerText, 30),
        cls: clip(el.className, 60),
        visible: !!(el.offsetWidth || el.offsetHeight),
        popper: popper(el),
    });
    const snap = () => ({
        searchBtn: (() => {
            const b = document.querySelector('.search-btn') ||
                document.querySelector('.operation-btn[class*="search"]');
            return b ? { cls: clip(b.className, 120), html: clip(b.innerHTML, 80),
                         parentCls: clip((b.parentElement || {}).className, 80) } : null;
        })(),
        thinkEntry: (() => {
            const e = document.querySelector('.item-think');
            return e ? { cls: clip(e.className, 60), text: clip(e.innerText, 30),
                         visible: !!(e.offsetWidth || e.offsetHeight) } : null;
        })(),
        items: Array.prototype.slice.call(document.querySelectorAll('.think-mode-item')).map(snapItem),
    });

    const out = { notes: [], before: snap(), clicked: [], after: null };
    const click = (el) => { try { el.click(); return true; } catch (e) { return false; } };
    const on = (el) => /active|selected|is-checked|checked|open/i.test(String(el.className || ''));

    // ---- 1) 联网搜索：⚠️ 2026-10-14 实测**不改** ----
    // .search-btn 点击只会弹出模型下拉（el-dropdown/model-select-item），
    // 而平台请求体里的 is_networking 始终为 true —— 它不是页面上可切的开关
    // （更像「允许联网」的能力位）。文档见 docs/native-parity.md 阶段 3。

    // ---- 2) 思考强度：逐个「快速」项都点一次（可能有多个 popper，其中一个是真菜单）----
    try {
        const items = Array.prototype.slice.call(document.querySelectorAll('.think-mode-item'));
        items.forEach((el, i) => {
            if (!/快速/.test(el.innerText || '')) return;
            const entry = document.querySelector('.item-think');
            if (entry) {
                try {
                    entry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                    entry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                } catch (e) {}
            }
            out.clicked.push('fast#' + i + ':onBefore=' + on(el) + ':clicked=' + click(el));
        });
    } catch (e) { out.notes.push('think:' + e); }

    out.after = snap();
    return out;
}`;

export const PROBE_CHAT_TOGGLES_JS = `() => {
    const clip = (s, n) => String(s == null ? '' : s).slice(0, n || 60);
    const attr = (el, name) => { try { return String(el.getAttribute(name) || ''); } catch (e) { return ''; } };
    const rec = (el) => ({
        tag: (el.tagName || '').toLowerCase(),
        cls: clip(el.className, 80),
        text: clip((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(), 60),
        aria: clip(attr(el, 'aria-label'), 40),
        role: clip(attr(el, 'role'), 20),
        checked: clip(attr(el, 'aria-checked') || attr(el, 'data-checked'), 10),
        title: clip(attr(el, 'title'), 40),
        visible: !!(el.offsetWidth || el.offsetHeight),
    });

    const out = { url: location.href, controls: [], storage: {}, matched: [] };
    const sel = [
        '.el-switch', '[role="switch"]', '[aria-checked]',
        'button', '[role="button"]',
        '[class*="switch"]', '[class*="net"]', '[class*="search"]',
        '[class*="tool"]', '[class*="mode"]', '[class*="deep"]', '[class*="think"]'
    ].join(',');

    document.querySelectorAll(sel).forEach((el) => {
        if (out.controls.length >= 120) return;
        const r = rec(el);
        if (!r.visible && !r.text) return;
        out.controls.push(r);
        if (/联网|搜索|工具|深度|思考|模式|模型|net|search|tool|deep|think|mode/i.test(r.text + ' ' + r.aria + ' ' + r.cls)) {
            out.matched.push(r);
        }
    });

    const dump = (store, prefix) => {
        try {
            for (const k of Object.keys(store)) {
                if (Object.keys(out.storage).length >= 60) return;
                out.storage[prefix + k] = clip(store.getItem(k), 120);
            }
        } catch (e) {}
    };
    dump(window.localStorage, 'local:');
    dump(window.sessionStorage, 'sess:');

    return out;
}`;

/** 诊断：判定平台限制时的依据（`.answer` 条数 + 最后一条内容 + URL）。 */
export const BUSY_NOTICE_DIAG_JS = `() => {
    const els = document.querySelectorAll('.answer');
    return {
        n: els.length,
        tail: els.length ? (els[els.length - 1].innerText || '').slice(0, 200) : '',
        url: location.href,
    };
}`;

/**
 * 零产出诊断：区分「模型没答」与「答了但选择器/锚点没匹配上」。
 */
export const ZERO_OUTPUT_DIAG_JS = `() => {
    const ansEls = document.querySelectorAll('.answer');
    const lastAns = ansEls.length ? (ansEls[ansEls.length-1].innerText || '') : null;
    const conv = document.querySelectorAll('.session-block .conversation-container');
    const lastConv = conv.length ? (conv[conv.length-1].innerText || '') : null;
    return {
        url: location.href,
        answerCount: ansEls.length,
        answerLen: lastAns === null ? -1 : lastAns.length,
        answerHead: lastAns === null ? '' : lastAns.slice(0, 300),
        convLen: lastConv === null ? -1 : lastConv.length,
        convHead: lastConv === null ? '' : lastConv.slice(0, 300),
        regenerate: document.querySelectorAll('.regenerate.canuse').length,
    };
}`;

/** 输入框与发送按钮的选择器（按优先级）。 */
export const INPUT_SELECTORS: ReadonlyArray<string> = [
  'textarea.scroll-display-none',
  'textarea[class*="scroll-display-none"]',
  'textarea',
  '[contenteditable="true"]',
];

/** 发送按钮选择器（Enter 不生效时点击）。 */
export const SEND_BUTTON_SELECTORS: ReadonlyArray<string> = [
  'button[class*="send"]',
  '[class*="send-btn"]',
  '[class*="sendBtn"]',
  'div[class*="enter"]:not([class*="input"])',
  'button[type="submit"]',
];
