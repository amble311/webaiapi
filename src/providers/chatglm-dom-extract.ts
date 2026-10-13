/**
 * ChatGLM 页面侧的**正文兜底提取**脚本（大脚本，单独成文件）。
 *
 * ⚠️ 只在「完全没有 SSE 捕获」时才调用 —— SSE 捕获存在但 `type=text` 为空
 * 说明模型还在 think 阶段，此时 DOM 的 `.answer` 里装的正是**思考正文**，
 * 取它会把思考过程当成回答流给客户端（实测客户端先收到 3751 字符思考、然后停住）。
 *
 * 里面的过滤规则全是踩出来的：
 * - `_isThinkingContent` / `_finalize`：思考过程与最终答案渲染在同一节点内，
 *   必须取「思考结束 / 跳过思考」锚点**之后**的正文，否则会把用户提问回显 + 思考一起当答案。
 * - `allowNoAnchor=true`（用于 `.answer` 这类纯答案容器）：**并非每次回复都有思考块**
 *   （实测有回复无「思考结束」），旧逻辑会一直返回空串 → 表现为「等待 90s 后空回复」。
 * - `_isBusyNotice`：并发/限流提示不是 AI 回复，必须丢弃，否则会被当成答案返回。
 * - `_isLandingPage`：落地页强特征只有「今天，有什么新想法」与纯页脚。
 */

/** DOM 兜底正文提取（含思考剔除、噪声剔除、锚点截取）。 */
export const EXTRACT_RESPONSE_JS = `() => {
function _isThinkingContent(text) {
    if (!text) return false;
    if (/^构思回复|^分析请求|^跳过思考/.test(text)) return true;
    if (/\\n构思回复[:：]|\\n分析请求[:：]/.test(text)) return true;
    if (/^思考结束$/.test(text.trim())) return true;
    return false;
}

function _cleanResponseText(text) {
    if (!text) return text;
    let cleaned = text;
    cleaned = cleaned.replace(/^ChatGLM\\s*/, '');
    cleaned = cleaned.replace(/(^|\\n)思考结束(?!\\S)/g, '');
    cleaned = cleaned.replace(/(^|\\n)(思考中[^\\n]*|跳过思考|构思回复[:：][^\\n]*|分析请求[:：][^\\n]*)(?=\\n|$)/g, '\\n');
    cleaned = cleaned.trim();
    return cleaned;
}

// 并发/限流提示不是 AI 回复，必须丢弃。
// ⚠️ 长文本里出现这些词通常只是「提到了它」（历史里带过的限制提示会被拍平进提示词；
//    对话列表兜底拿到的 raw 里还含用户自己的提问）→ 长度设上限，避免误杀真实回答。
function _isBusyNotice(text) {
    if (!text) return false;
    if (text.length > 200) return false;
    return /请等待其他对话生成完毕|本次回答已被终止|还有对话正在生成|正在生成其他回答|请求过于频繁|过于频繁|请稍后再试/.test(text);
}

// 未开始对话的欢迎/落地页内容。只用「真实对话中绝不会出现」的强特征。
function _isLandingPage(text) {
    if (!text) return false;
    if (/今天，有什么新想法/.test(text)) return true;
    if (/^\\s*(内容由AI生成，请仔细甄别\\s*)+$/.test(text)) return true;
    return false;
}

// 逐行剔除页面边框噪声（侧边栏、页脚、推荐问题、品牌文案等）
const _DROP_EXACT = new Set([
    '用户协议', '隐私政策', '开源模型', '停止对话', '回答中',
    '新对话', '学习搭子', 'AI画图', 'AI阅读', 'AI生视频',
    'AgentMore', '云知识库', '智能体', '最近对话',
    '和我聊聊天吧', 'GLM-Flash极致', '内容由AI生成，请仔细甄别', '|',
]);
function _isNoiseLine(line) {
    if (_DROP_EXACT.has(line)) return true;
    if (/^用户_/.test(line)) return true;              // 用户名标签
    if (/^积分\\s*[\\d.]+$/.test(line)) return true;     // 积分显示
    if (/^\\d{4} ChatGLM/.test(line)) return true;       // 版权年
    if (/^京(ICP备|公网安备)/.test(line)) return true;   // 备案号
    if (/^GLM-?Flash(模型)?(极致)?$/.test(line)) return true;
    if (/^[\\d.]+-Flash模型上线$/.test(line)) return true;
    if (/^\\d+个来源$/.test(line)) return true;
    if (/^\\d+\\+?\\d*等于几？$/.test(line)) return true; // 推荐追问
    // 引用来源域名（如 thepaper.cn / khanacademy.org）
    if (/^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(com|cn|org|net|io|edu|gov|co)(\\.[a-z]{2})?$/i.test(line) && line.indexOf('.') > 0) return true;
    return false;
}
function _stripChrome(text) {
    if (!text) return '';
    const out = [];
    for (const raw of text.split('\\n')) {
        const line = raw.trim();
        if (!line) { out.push(''); continue; }
        if (_isNoiseLine(line)) continue;
        out.push(raw);
    }
    return out.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}

// 最终整理：优先取最后一个「思考结束 / 跳过思考」锚点之后的正文。
// ChatGLM 的思考过程与最终答案渲染在同一节点内，锚点之前的内容
// （用户提问回显、思考、搜索过程）都不是答案。
//
// allowNoAnchor=true 时（用于 .answer 这类**纯答案容器**）：
// 若整段都没有锚点，且不含任何思考/搜索痕迹，则整段视为答案。
// 必要性：并非每次回复都有思考块（实测有回复无「思考结束」），
// 此时旧逻辑会一直返回空串 → 表现为「等待 90s 后空回复」。
function _finalize(text, allowNoAnchor) {
    if (!text) return '';
    let t = String(text);
    let idx = -1, alen = 0;
    for (const a of ['思考结束', '跳过思考']) {
        const i = t.lastIndexOf(a);
        if (i > idx) { idx = i; alen = a.length; }
    }
    if (idx < 0) {
        if (!allowNoAnchor) return '';
        if (/思考中|搜索中|正在查询|构思回复|分析请求/.test(t)) return '';
    } else {
        t = t.slice(idx + alen);
    }
    t = _cleanResponseText(t);
    t = _stripChrome(t);
    return t;
}

// 取匹配集合中的最后一个元素（最新一次回答）
function _lastText(sel) {
    const els = document.querySelectorAll(sel);
    if (!els.length) return '';
    return (els[els.length - 1].innerText || '').trim();
}

// 按优先级尝试各答案容器（ChatGLM 实际结构为 .answer）
const _SELECTORS = [
    '.answer',
    '.answer-content',
    '.answer-content-wrap',
    '.markdown-body',
];
for (const sel of _SELECTORS) {
    const raw = _lastText(sel);
    if (!raw) continue;
    if (_isLandingPage(raw)) continue;
    // 并发限制提示不是答案，直接丢弃（否则会被当成回复返回）
    if (_isBusyNotice(raw)) continue;
    // 这些是纯答案容器，允许「无思考块」时整段作为答案
    const fin = _finalize(raw, true);
    if (fin && !_isBusyNotice(fin)) return fin;
}

// 兜底：整个对话列表（含用户提问与推荐追问，必须依赖锚点）
const convEls = document.querySelectorAll('.session-block .conversation-container');
if (convEls.length) {
    const el = convEls[convEls.length - 1];
    const listEl = el.querySelector('.conversation-list-outer');
    const raw = ((listEl || el).innerText || '');
    if (!_isLandingPage(raw) && !_isBusyNotice(raw)) {
        const fin = _finalize(raw, false);
        if (fin && !_isBusyNotice(fin)) return fin;
    }
}

return '';
}`;

/**
 * 整轮零产出时的**强制兜底**提取（再取一次 `.answer` 正文）。
 *
 * 仅当其中不含思考/搜索痕迹、也不是平台限制提示时才返回内容。
 */
export const FORCED_EXTRACT_JS = `() => {
    const els = document.querySelectorAll('.answer');
    if (!els.length) return '';
    let t = (els[els.length - 1].innerText || '');
    if (/思考中|搜索中|正在查询|构思回复|分析请求/.test(t)) return '';
    // 并发限制提示不是答案
    // 只有「短文本 + 命中关键词」才算平台限制提示（长文本是真实回答）
    if (t.length < 200 && /请等待其他对话生成完毕|本次回答已被终止|还有对话正在生成|请求过于频繁|请稍后再试/.test(t)) return '';
    t = t.replace(/^ChatGLM\\s*/, '');
    const lines = t.split('\\n').filter(l => {
        const s = l.trim();
        if (!s) return false;
        if (s === 'ChatGLM' || s === '思考结束' || s === '跳过思考') return false;
        if (/^\\d+个来源$/.test(s)) return false;
        return true;
    });
    return lines.join('\\n').trim();
}`;
