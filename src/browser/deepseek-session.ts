/**
 * DeepSeek 会话工具（**browser 层**，登录流程与 provider 共用）。
 *
 * 从 `providers/deepseek.ts` 抽出来的原因（2026-10-17）：`login` 在「选中已有账号」时
 * 要先用保存的凭证试探登录态 —— 那是 browser 层的事，不该反向依赖 providers。
 * provider 仍然从本模块导入并**再导出**（测试与外部调用不用改）。
 */

/**
 * 「**启动前**种 token」的注入脚本内容（`context.addInitScript`）。
 *
 * ⚠️ 网页端的存储格式实测是 `{"value":"<bearer>","__version":"0"}`；
 * 页面启动时读它 → 必须在应用初始化**之前**写好，运行中写会被应用清掉。
 *
 * ⚠️⚠️ **只在页面没有任何 token 时才写**（2026-10-16 实测事故）：
 * deepseek 会**轮换 token**（`/api/v0/users/current` 的响应里就带 `token` 字段），
 * 页面 localStorage 里那份是**应用自己刷新出来的、更新的** token，与凭证文件里的不同属正常。
 * 无条件覆盖会让页面进不去 / 没有输入框（用户报「模型突然不可用」）。
 */
export function initTokenJs(token: string, force = false): string {
  /* `force` 用在哪（2026-10-17 实测）：**同一个 context 切换账号**时（主通道在两个账号间
   * 轮换 / 故障转移）—— 旧账号的注入脚本先跑、已经把 token 写进去了，
   * 「只在没有 token 时写」的新脚本会直接返回 → **新账号继续用旧账号的 token** ✗。
   * 所以「给另一个账号装脚本」时传 force=true（脚本按注册顺序执行，后装的覆盖先装的）。 */
  return `(() => {
  try {
    const cur = localStorage.getItem('userToken') || '';
    // 同一账号的普通重载：页面已有 token（可能是应用刷新出的更新版本）→ 绝不覆盖
    if (!${force ? 'true' : 'false'} && cur.length > 2) return;
    localStorage.setItem('userToken', JSON.stringify({ value: ${JSON.stringify(token)}, __version: '0' }));
  } catch (e) {}
})()`;
}

/**
 * 页面登录态分类（**纯函数**，便于单测）。
 *
 * | 返回 | 含义 | 处理 |
 * |---|---|---|
 * | `ok` | 页面有自己的 token 且 API 认 | 正常继续 |
 * | `expired` | 跳到 `/sign_in`、没有 token，或 API 明确拒绝（含 40002 Missing Token） | 补种一次；仍失效就报错停止 |
 * | `unknown` | 请求本身失败（网络/WAF），判断不了 | **不拦**（避免网络抖动误杀整个账号） |
 */
export function classifyLoginState(input: {
  path: string;
  hasToken: boolean;
  code: number | null;
}): 'ok' | 'expired' | 'unknown' {
  if (String(input.path || '').includes('sign_in')) return 'expired';
  if (!input.hasToken) return 'expired';
  if (input.code === 0) return 'ok';
  if (input.code === null) return 'unknown';
  return 'expired';
}

/** 页面内探测登录态 + 顺手取平台刷新出的新 token（不抛错，失败返回 code=null）。 */
export function probeSessionJs(): string {
  return `async () => {
  let token = '';
  try {
    const raw = JSON.parse(localStorage.getItem('userToken') || '{}');
    token = String((raw && raw.value) || '');
  } catch (e) {}
  const path = String(location.pathname || '');
  if (!token) return { path, hasToken: false, code: null, token: '' };
  try {
    /* ⚠️ 页面内 fetch 不会自动带 Authorization（应用的封装才会加头）。 */
    const r = await fetch('/api/v0/users/current', {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!r.ok) return { path, hasToken: true, code: -1, token: '' };
    const d = await r.json();
    const biz = (d && d.data && d.data.biz_data) || {};
    return {
      path,
      hasToken: true,
      code: typeof d.code === 'number' ? d.code : -1,
      token: String(biz.token || ''),
    };
  } catch (e) {
    return { path, hasToken: true, code: null, token: '' };
  }
}`;
}
