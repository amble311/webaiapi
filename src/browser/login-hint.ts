/**
 * 登录引导：**注入到网页里的横幅 + 按钮** + **「登录是否完成」的判据**。
 *
 * ## 为什么要把引导注入页面（2026-10-16 用户反馈）
 * 原来 `webaiapi login` 的引导全打在终端上，流程里要塞两次回车：
 * 开浏览器前「准备好登录了吗？按 Enter」、登录完「是否登录完成？按 Enter」。
 * 而登录期间**每个 API 请求都打一行**「✓ 记录样本请求: GET …」把终端刷满 ——
 * 用户此时盯着的是**浏览器**，"回终端按一下回车" 这句话本身就看不见了。
 *
 * Playwright 本来就能注入页面（我们早在用 `addInitScript` 注入 `STEALTH_JS` /
 * `SSE_CAPTURE_JS`），所以把引导**放到用户正在看的地方**：
 *
 * - 页面上一条固定悬浮横幅：写明「在这里登录 → 登录成功自动继续 → 不必回终端」；
 * - 横幅上带**按钮**（用户 2026-10-16 建议）：`✓ 我已登录，继续` / `↻ 重开登录页` / `✕ 取消`，
 *   点击后经 **HTML 属性**（见 {@link LOGIN_HINT_ACTION_ATTR}）把动作回传给 Node 侧；
 *   按钮**不能替代**自动检测 —— 自动检测零操作、优先；按钮只是「检测不到时不想回终端」的兜底。
 *
 * ## ⚠️ 三条硬约束（单测钉住了）
 * 1. **样式只能走 CSSOM**：站点的 `Content-Security-Policy` 会拦 `<style>` 与 `style="…"`，
 *    但**不拦 CSSOM**（`el.style.xxx = …`）；
 * 2. **`pointer-events` 分层**：横幅容器 `none`（它悬浮在登录表单上方，绝不能吃鼠标事件），
 *    **按钮自己设 `auto`**（否则点不动）；
 * 3. **动作白名单**：页面回传的动作只认 `done` / `reload` / `cancel`，
 *    其余一律忽略 —— 不给平台页面留下「往我们的进程里塞任意指令」的口子。
 */
import type { AuthRecord } from './credentials.js';
import { identityStrength } from './platforms.js';

/** 横幅元素的 id（注入、更新、移除三处共用）。 */
export const LOGIN_HINT_ELEMENT_ID = '__webaiapi_login_hint';

/**
 * 页面 → Node 的动作回传通道：**HTML 属性**（不是全局函数）。
 *
 * ## ⚠️ 为什么不用 Playwright 的 `exposeBinding`（2026-10-16 实测改掉）
 * 用户报「登录的滑块验证始终过不了」。探针实测（headless，逐项打印）：
 *
 * | | 注册 binding 前 | 注册 binding 后 |
 * |---|---|---|
 * | 页面里的可疑全局 | 无 | **`__playwright__binding__`、`__playwright__binding__controller__`** |
 * | 可枚举（`for…in` 可见） | — | **是** |
 *
 * 反爬脚本 `for (const k in window)` 一抓就露 —— 那是**我们给按钮加的功能带来的指纹**。
 * 现在按钮只写一个 DOM 属性，Node 侧在 2s 一次的刷新循环里**顺带读取并清除**，
 * 页面里不留任何函数、不注册任何全局。
 */
export const LOGIN_HINT_ACTION_ATTR = 'data-webaiapi-action';

/**
 * 横幅语气：
 * - `wait`     等登录中（三个按钮：我已登录继续 / 重开登录页 / 取消）
 * - `done`     已检测到登录、正在保存（无按钮）
 * - `captured` 凭证已落盘，**等用户点「完成」再关浏览器**（2026-10-16 用户要求：
 *              好让他在客户端把模型参数设置好）
 */
export type LoginHintTone = 'wait' | 'done' | 'captured';

/** 页面按钮能回传的动作（**白名单**）。 */
export type LoginHintAction = 'done' | 'reload' | 'cancel' | 'finish';

/** 动作是否在白名单内（导出便于单测与 Node 侧共用同一份判据）。 */
export function isLoginHintAction(value: unknown): value is LoginHintAction {
  return value === 'done' || value === 'reload' || value === 'cancel' || value === 'finish';
}

export interface LoginHintContent {
  title: string;
  tips: ReadonlyArray<string>;
  tone?: LoginHintTone;
}

/**
 * 生成「注入/更新登录横幅」的页面函数表达式（配合 `iife()` 使用）。
 *
 * 幂等：元素已存在就重建内容（`addInitScript` 会在每次导航后重新执行，必须幂等）。
 */
export function loginHintJs(content: LoginHintContent): string {
  const cfg = JSON.stringify({
    id: LOGIN_HINT_ELEMENT_ID,
    actionAttr: LOGIN_HINT_ACTION_ATTR,
    title: content.title,
    tips: [...content.tips],
    tone: content.tone ?? 'wait',
  });

  return `() => {
    /* ⚠️ 只注入**顶层文档**：Playwright 的 addInitScript 对**子 frame 也生效**，
     * 而微信扫码登录的二维码是个 iframe —— 横幅被同时注入进去后，
     * position:fixed 相对那个小视口渲染，就成了压在二维码上的一小条
     * （2026-10-16 用户截图）。子 frame 里什么都不做。 */
    if (window.top !== window.self) return '';

    const cfg = ${cfg};

    /* 读走并**立即清除**页面按钮的动作：一次 evaluate 同时完成「刷新横幅 + 取动作」，
     * 既省一次往返，也保证同一个点击不会被处理两次。 */
    const readAction = () => {
        try {
            const root = document.documentElement;
            if (!root) return '';
            const a = String(root.getAttribute(cfg.actionAttr) || '');
            if (a) root.removeAttribute(cfg.actionAttr);
            return a;
        } catch (e) {
            return '';
        }
    };

    const draw = () => {
        try {
            let el = document.getElementById(cfg.id);
            if (!el) {
                el = document.createElement('div');
                el.id = cfg.id;
                (document.body || document.documentElement).appendChild(el);
            }

            /* ⚠️ 只走 CSSOM：见本文件头部关于 CSP 的说明（不许 setAttribute('style', …)） */
            const s = el.style;
            s.position = 'fixed';
            s.zIndex = '2147483000';
            s.top = '0';
            /* ⚠️ 居中**不能用 left:50% + transform**：固定定位元素宽度是 shrink-to-fit，
             *    设了 left 就等于把可用宽度砍成一半（实测：文字被挤成 4 行、横幅高 245px）。
             *    用 left:0 + right:0 + margin:auto + width:fit-content 才是「按内容宽度居中」。 */
            s.left = '0';
            s.right = '0';
            s.margin = '0 auto';
            s.width = 'fit-content';
            s.maxWidth = '92vw';
            s.padding = '8px 16px';
            s.borderRadius = '0 0 10px 10px';
            s.background = cfg.tone === 'done' ? 'rgba(14,122,60,.95)' : 'rgba(20,20,20,.93)';
            s.color = '#fff';
            s.font = '14px/1.55 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
            s.textAlign = 'center';
            s.boxShadow = '0 4px 18px rgba(0,0,0,.38)';
            /* ⚠️ 容器绝不吃鼠标事件（横幅底下就是登录表单）；按钮自己再开 auto */
            s.pointerEvents = 'none';
            s.userSelect = 'none';

            /* 用 DOM API 重建内容（不碰 innerHTML，避免与 CSP/站点脚本纠缠） */
            while (el.firstChild) el.removeChild(el.firstChild);

            const title = document.createElement('div');
            title.textContent = cfg.title;
            title.style.fontWeight = '700';
            title.style.fontSize = '15px';
            el.appendChild(title);

            if (cfg.tips.length > 0) {
                const tips = document.createElement('div');
                tips.textContent = cfg.tips.join('\\n');
                tips.style.whiteSpace = 'pre-line';
                tips.style.opacity = '0.92';
                el.appendChild(tips);
            }

            /* 按钮组按语气决定：
             * - wait     ：让用户推动登录流程（也可回终端按回车）
             * - done     ：正在保存，不需要按钮
             * - captured ：凭证已落盘，只留「完成」——用户确认后在客户端设参数、
             *              点它才关浏览器（2026-10-16 用户要求） */
            const actions =
                cfg.tone === 'captured'
                    ? [{ action: 'finish', label: '✓ 完成（关闭浏览器）', primary: true }]
                    : cfg.tone === 'done'
                      ? []
                      : [
                            { action: 'done', label: '✓ 我已登录，继续', primary: true },
                            { action: 'reload', label: '↻ 重开登录页', primary: false },
                            { action: 'cancel', label: '✕ 取消', primary: false },
                        ];
            if (actions.length > 0) {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.gap = '8px';
                row.style.justifyContent = 'center';
                row.style.marginTop = '6px';

                actions.forEach((a) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = a.label;
                    b.setAttribute('data-webaiapi-action', a.action);
                    /* ⚠️ 容器是 pointer-events:none；按钮必须自己开 auto，否则点不动 */
                    b.style.pointerEvents = 'auto';
                    b.style.cursor = 'pointer';
                    b.style.font = '13px/1.4 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
                    b.style.padding = '4px 12px';
                    b.style.borderRadius = '6px';
                    b.style.border = a.primary ? '0' : '1px solid rgba(255,255,255,.5)';
                    b.style.background = a.primary ? 'rgba(255,255,255,.95)' : 'transparent';
                    b.style.color = a.primary ? '#111' : '#fff';
                    b.onclick = () => {
                        b.disabled = true;
                        b.textContent = '处理中…';
                        /* ⚠️ 不回传函数、不注册全局：只写一个属性，Node 侧轮询时读走并清除。
                         * （Playwright 的绑定通道会往页面留可枚举指纹，见 LOGIN_HINT_ACTION_ATTR） */
                        try {
                            document.documentElement.setAttribute(cfg.actionAttr, a.action);
                        } catch (e) {
                            /* 写属性失败时静默：终端按回车仍然可用 */
                        }
                    };
                    row.appendChild(b);
                });
                el.appendChild(row);
            }
        } catch (e) {
            /* 站点结构意外时静默：终端进度与自动检测仍然可用 */
        }
        return true;
    };

    /* ⚠️ 注入脚本可能在 DOM 就绪**之前**执行（addInitScript 的常态）：
     * 那时 document.body / documentElement 还是 null，直接 appendChild 会抛异常、
     * 横幅根本不出现（2026-10-16 探针实测）。所以推迟到 DOMContentLoaded。 */
    if (document.body || document.documentElement) {
        draw();
    } else {
        document.addEventListener('DOMContentLoaded', draw, { once: true });
    }

    return readAction();
  }`;
}

/** 生成「移除登录横幅」的页面函数表达式。 */
export function removeLoginHintJs(): string {
  return `() => {
    const el = document.getElementById('${LOGIN_HINT_ELEMENT_ID}');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return true;
  }`;
}

/**
 * 凭证是不是**游客（未登录）**身份。
 *
 * ## ⚠️ 2026-10-16 实测事故（本函数的由来）
 * chatglm 会给**任何访客**下发一个匿名 JWT：页面一加载就带着它去调
 * `chatglm.cn/chatglm/user-api/user/info`。于是只看「有没有 JWT」的判据**立刻**判定
 * 「登录完成」—— 用户什么都没做，流程却把**游客凭证覆盖到了真实账号文件上**
 * （`default.json` 与 `用户_bFa15b.json` 两份都被覆盖，各自靠 `.bak` 才救回来）。
 *
 * 平台自己标了字段（实测抓下两份 token 对比）：
 *
 * | token 类型 | `is_guest` | `mode` | `sub` |
 * |---|---|---|---|
 * | 游客 | **`true`** | `1` | 32 位十六进制哈希 |
 * | 真实账号 | 字段**不存在** | 无 | 用户名（如 `洛小北`、`用户_bFa15b`） |
 *
 * 所以：有 `is_guest === true` 即为游客；老 token 没有该字段时退回看 `sub`
 * （游客是 32 位十六进制哈希，真实账号是用户名）。
 */
export function isGuestCredential(platform: string, auth: AuthRecord): boolean {
  /* 委托给 `platforms.ts::identityStrength`（单一事实来源）：
   * `session` 就是「只有匿名会话/设备 cookie」这一类 —— chatglm 的游客 JWT 也归在它里面。 */
  try {
    return identityStrength(platform, auth) === 'session';
  } catch {
    return false;
  }
}

/**
 * 凭证里是否已经出现**真实登录身份**（= 登录完成）。
 *
 * 这是「自动继续、不用按回车」的判据 —— 复用 `router` 判断
 * 「两个账号是不是同一个人」时用的同一套身份提取，口径一致。
 *
 * ⚠️ chatglm 要同时满足两条：
 * 1. **看到 JWT**（`token_type === 'jwt'`）：它的身份提取会退到 `chatglm_user_id`
 *    cookie，而游客也有这个 cookie，只看 `identifier` 会误判；
 * 2. **不是游客 token**（见 {@link isGuestCredential}）—— 游客 JWT 同样满足第 1 条，
 *    这正是 2026-10-16 那次「什么都没做就捕获成功」的原因。
 */
export function looksLoggedIn(platform: string, auth: AuthRecord): boolean {
  if (!platform) return false;
  try {
    /* ⚠️ 判据是**身份来源**，不是「有没有 identifier」（见 `IdentityStrength` 的说明）：
     * deepseek 的游客也有 `ds_session_id` cookie，会被提取成 `session:<id>` 身份 ——
     * 只看 identifier 就会「什么都没做也判定登录成功」，还多出一个账号文件
     * （2026-10-16 实测：`session-<hash>.json` 就是这么来的）。 */
    const strength = identityStrength(platform, auth);
    return strength === 'user' || strength === 'token';
  } catch {
    return false;
  }
}

/**
 * 等待登录期间横幅上显示的内容（等 / 已检测到）。
 *
 * 抽成纯函数是为了让文案可测、也便于以后按平台微调。
 */
export function loginHintContent(options: {
  platformName: string;
  /** 已等待秒数（写进标题，让页面上的提示是"活的"）。 */
  elapsedSeconds: number;
  /** 超时秒数。 */
  timeoutSeconds: number;
  /** 已知该平台已有账号时给出退出登录的提醒。 */
  warnExistingSession?: boolean;
  tone?: LoginHintTone;
  /** `captured` 语气用：落盘的账号 id。 */
  accountId?: string;
  /** `captured` 语气用：账号身份（用户名/邮箱）。 */
  identity?: string;
  /** `captured` 语气用：建议客户端使用的模型名。 */
  modelHint?: string;
}): LoginHintContent {
  const { platformName, timeoutSeconds, warnExistingSession } = options;

  if (options.tone === 'done') {
    return {
      tone: 'done',
      title: '✓ 已检测到登录，正在保存凭证…',
      tips: ['请不要关闭浏览器'],
    };
  }

  if (options.tone === 'captured') {
    /* 凭证已经落盘（`login-flow` 先 saveAs 再调这里），所以这时用户可以放心去
     * 客户端配置；点「完成」我们才关浏览器 —— 之前是捕获完立刻关窗，
     * 用户还没看清账号/身份就没了（2026-10-16 用户要求改）。
     *
     * ⚠️ 横幅里**不要写 markdown**（字面显示星号）。 */
    const tips: string[] = [];
    if (options.accountId) {
      tips.push(
        `会话账号：${options.accountId}` +
          (options.identity ? `（身份 ${options.identity}）` : ''),
      );
    }
    if (options.modelHint) {
      tips.push(`在客户端里把模型名设为 ${options.modelHint}，其余参数按需设置`);
    }
    tips.push(`设置完成后点下面的「完成」我会关闭浏览器（也可在终端按一次回车）`);
    return {
      tone: 'captured',
      title: `✓ ${platformName} 登录凭证已捕获并保存`,
      tips,
    };
  }

  /* ⚠️ 横幅里**不要写 markdown**（`**粗体**` 会字面显示成星号）；
   *    文案也尽量短 —— 横幅越高压住的页面越多。 */
  const tips = [
    '① 在本页完成登录（扫码或账号密码都行）',
    `② 登录成功会自动继续；没追上就点下面的按钮，或回终端按回车（最多 ${timeoutSeconds}s）`,
  ];
  if (warnExistingSession) {
    tips.push('⚠️ 本机可能已有别的账号：请先在本页退出登录，再登录目标账号');
  }

  /* 标题带「已等待 Ns」：横幅每 2s 会重画一次，用户一眼能看出程序真的在等他，
   * 而不是"卡住了"（这是把提示放页面上的意义所在）。 */
  const waited = Math.max(0, Math.round(options.elapsedSeconds));
  const title =
    waited >= 3 ? `请在此页面登录 ${platformName}（已等待 ${waited}s）` : `请在此页面登录 ${platformName}`;

  return { tone: 'wait', title, tips };
}
