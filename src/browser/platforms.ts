/**
 * 平台注册表 —— **「一个平台」的全部声明集中在这里**。
 *
 * ## 为什么要有这个文件
 * 移植前，关于「平台」的信息散在 `credentials.ts` 的**三张并行 Record**
 * （`PLATFORM_API_PATTERNS` / `PLATFORM_LOGIN_URLS` / `PLATFORM_NAMES`）里，
 * 加上 `extractAccountInfoSync` 里一个**按平台名分支的 switch**。要加一个平台，
 * 得记住改 4 个地方 —— 漏掉任何一处都**不报错**，只是该平台在某个菜单/某条
 * 日志里显示成原始 id、或者身份提取静默退化（最难查的一类问题）。
 *
 * 现在：**加平台 = 在 {@link PLATFORM_LIST} 里加一条**。其余代码全部按这张表迭代。
 *
 * ## 依赖方向
 * `platforms.ts` → `credentials.ts`（单向）。凭证的**类型与读写**留在
 * `credentials.ts`，平台元数据与**身份提取**在这里。
 * 反过来不让 `credentials.ts` 依赖本文件，就避免了两者循环 import
 * —— 这也是 `extractAccountInfoSync` 从 `credentials.ts` **搬过来**的原因。
 *
 * ## `providerImplemented` 与 `PLATFORM_MODEL_NAMES` 的关系
 * 「能不能对话」取决于是否真的实现了 Provider（`controllers/router.ts` 的
 * `PROVIDER_FACTORIES`）。本文件用 {@link PlatformSpec.providerImplemented} 声明，
 * `router.ts` 的 `PLATFORM_MODEL_NAMES` 由它派生 —— **单一真相**。
 * 为防止两边写岔，有单测逐条核对（`test/browser/platforms.test.ts`）：
 * 声明为 true 的平台必须真有工厂，反之亦然。
 */
import {
  decodeJwt,
  getCookieValue,
  type AccountInfo,
  type AuthRecord,
  type PlatformApiPattern,
} from './credentials.js';

export type { PlatformApiPattern };

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 一个平台的完整声明。 */
export interface PlatformSpec {
  /** 平台 id（= 模型名 = 凭证目录名，如 `chatglm`）。 */
  id: string;
  /** 中文显示名（菜单 / 日志 / `/status` 用）。 */
  displayName: string;
  /** 登录入口（`webapi login` 会打开它）。 */
  loginUrl: string;
  /**
   * Web UI 内部 API 的匹配特征（用于从被抓请求里认出哪个含认证信息）。
   * 缺失时只捕获 Cookie（见 `AuthCapture` 的告警分支）。
   */
  apiPattern?: PlatformApiPattern;
  /**
   * 是否已实现对话 Provider。
   *
   * `false` 表示**只能捕获凭证、暂不能对话** —— 这是给未来平台留的位置：
   * 先把登录/身份提取接通（这样 `webapi login` 菜单里就能看到它），
   * 等 Provider 写好再把本字段翻成 `true` 即可。
   */
  providerImplemented: boolean;
  /**
   * 从已捕获的凭证里提取账号身份。
   *
   * ⚠️ 必须是**纯函数**（只依赖入参），因为 `router` 会在判断辅助通道
   * 能否启用时反复调用它比较身份。
   *
   * 约定：至少产出 `identifier`（用于唯一标识「这是同一个人」），
   * 尽量产出 `label`（人类可读，如用户名/邮箱）。两者都可能缺，
   * 由 {@link extractAccountInfoSync} 统一兜底。
   */
  extractIdentity: (auth: AuthRecord) => AccountInfo;
}

/* ------------------------------------------------------------------ */
/* 身份提取（各平台）                                                   */
/* ------------------------------------------------------------------ */

/** 宽松取字符串（`unknown` → `string`，保持与原实现一致）。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** ChatGLM：bearer 是 JWT，含 `sub`（用户名）与 `uid`。 */
function extractChatglm(auth: AuthRecord): AccountInfo {
  const info: AccountInfo = {};
  const cookies = auth.cookies;

  const payload = decodeJwt(str(auth.bearer));
  if (Object.keys(payload).length > 0) {
    const username = str(payload['sub']);
    const uid = str(payload['uid']);
    if (username) info['label'] = username;
    if (uid) info['identifier'] = uid;
    info['token_type'] = 'jwt';
  }
  if (!info['identifier']) {
    const uid = getCookieValue(cookies, 'chatglm_user_id');
    if (uid) info['identifier'] = uid;
  }

  return info;
}

/** Kimi：JWT 可能在 bearer，也可能在 `kimi-auth` cookie 里。 */
function extractKimi(auth: AuthRecord): AccountInfo {
  const info: AccountInfo = {};
  const cookies = auth.cookies;

  const bearerPayload = decodeJwt(str(auth.bearer));
  const payload =
    Object.keys(bearerPayload).length > 0
      ? bearerPayload
      : decodeJwt(getCookieValue(cookies, 'kimi-auth'));

  if (Object.keys(payload).length > 0) {
    const ssid = str(payload['ssid']);
    const deviceId = str(payload['device_id']);
    const jti = str(payload['jti']);
    if (ssid) {
      info['identifier'] = ssid;
      info['label'] = `ssid:${ssid.slice(0, 12)}`;
    }
    if (deviceId) info['device_id'] = deviceId;
    if (jti) info['jti'] = jti;
    info['token_type'] = 'jwt';
  }

  return info;
}

/** DeepSeek：优先 `ds_session_id` cookie，退回 bearer 前缀。 */
function extractDeepseek(auth: AuthRecord): AccountInfo {
  const info: AccountInfo = {};
  const bearer = str(auth.bearer);

  const sessionId = getCookieValue(auth.cookies, 'ds_session_id');
  if (sessionId) {
    info['identifier'] = sessionId;
    info['label'] = `session:${sessionId.slice(0, 12)}`;
  } else if (bearer) {
    info['identifier'] = bearer.slice(0, 16);
    info['label'] = `token:${bearer.slice(0, 8)}...`;
  }

  return info;
}

/**
 * 通义千问 / 豆包：**待验证** —— 从 cookies 里找含 `user` / `uid`（豆包还含
 * `session`）的字段。长度 ≥ 64 的值跳过，避免把 JWT 整串当身份显示。
 */
function extractCookieScan(auth: AuthRecord, kind: 'qianwen' | 'doubao'): AccountInfo {
  const info: AccountInfo = {};

  for (const c of auth.cookies ?? []) {
    const name = c?.name ?? '';
    const lower = name.toLowerCase();
    const hit =
      kind === 'qianwen'
        ? lower.includes('user') || lower.includes('uid')
        : lower.includes('user') || lower.includes('uid') || lower.includes('session');
    if (!hit) continue;

    const value = c?.value ?? '';
    if (value && value.length < 64) {
      info['identifier'] = value;
      info['label'] = `${name}:${value.slice(0, 12)}`;
      break;
    }
  }

  return info;
}

/** 智谱清言（z.ai）：JWT 用 `id` / `email`，不是标准的 `sub` / `uid`。 */
function extractZhipu(auth: AuthRecord): AccountInfo {
  const info: AccountInfo = {};

  const payload = decodeJwt(str(auth.bearer));
  if (Object.keys(payload).length > 0) {
    const uid =
      str(payload['id']) ||
      str(payload['uid']) ||
      str(payload['user_id']) ||
      str(payload['sub']);
    const email = str(payload['email']);
    const name = str(payload['name']);

    if (name) {
      info['name'] = name;
      info['label'] = name;
    } else if (email) {
      info['email'] = email;
      info['label'] = email;
    }
    if (uid) info['identifier'] = uid;
    info['token_type'] = 'jwt';
  }

  return info;
}

/** 未登记平台的兜底：只能拿 bearer 前缀当身份。 */
function extractGeneric(auth: AuthRecord): AccountInfo {
  const info: AccountInfo = {};
  const bearer = str(auth.bearer);

  if (bearer) {
    info['identifier'] = bearer.slice(0, 16);
    info['label'] = `token:${bearer.slice(0, 8)}...`;
  } else {
    info['identifier'] = 'unknown';
  }

  return info;
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 全部已知平台，**数组顺序 = 菜单顺序 = `mix` 的优先级顺序**。
 *
 * ⚠️ 加新平台时：写完 Provider 再把 `providerImplemented` 翻成 `true`，
 * 并在 `controllers/router.ts` 的 `PROVIDER_FACTORIES` 里加一行。
 * 两处不一致会被 `test/browser/platforms.test.ts` 挡住。
 */
export const PLATFORM_LIST: readonly PlatformSpec[] = [
  {
    id: 'chatglm',
    displayName: 'ChatGLM (智谱)',
    loginUrl: 'https://chatglm.cn/main/chat?lang=zh',
    apiPattern: {
      urlPattern: 'chatglm.cn/chatglm/backend-api/',
      authHeader: 'authorization',
      authPrefix: '',
    },
    providerImplemented: true,
    extractIdentity: extractChatglm,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    loginUrl: 'https://chat.deepseek.com/',
    apiPattern: {
      urlPattern: 'chat.deepseek.com/api/v0/chat/',
      authHeader: 'authorization',
      authPrefix: 'Bearer ',
    },
    providerImplemented: false,
    extractIdentity: extractDeepseek,
  },
  {
    id: 'qianwen',
    displayName: '通义千问',
    loginUrl: 'https://www.qianwen.com/',
    apiPattern: {
      urlPattern: 'chat2-api.qianwen.com/api/v2/chat',
      authHeader: 'x-xsrf-token',
      authPrefix: '',
    },
    providerImplemented: false,
    extractIdentity: (auth) => extractCookieScan(auth, 'qianwen'),
  },
  {
    id: 'kimi',
    displayName: 'Kimi (月之暗面)',
    loginUrl: 'https://www.kimi.com/',
    apiPattern: { urlPattern: 'kimi.com', authHeader: 'authorization', authPrefix: 'Bearer ' },
    providerImplemented: false,
    extractIdentity: extractKimi,
  },
  {
    id: 'doubao',
    displayName: '豆包 (Doubao)',
    loginUrl: 'https://www.doubao.com/',
    apiPattern: { urlPattern: 'doubao.com', authHeader: '', authPrefix: '', cookieOnly: true },
    providerImplemented: false,
    extractIdentity: (auth) => extractCookieScan(auth, 'doubao'),
  },
  {
    id: 'zhipu',
    displayName: '智谱清言 (GLM)',
    loginUrl: 'https://chat.z.ai/',
    apiPattern: { urlPattern: 'z.ai', authHeader: 'authorization', authPrefix: '' },
    providerImplemented: false,
    extractIdentity: extractZhipu,
  },
];

/** 按 id 索引的平台表（查表用）。 */
export const PLATFORMS: Record<string, PlatformSpec> = Object.fromEntries(
  PLATFORM_LIST.map((spec) => [spec.id, spec]),
);

/** 全部平台 id（按 {@link PLATFORM_LIST} 顺序）。 */
export const PLATFORM_IDS: string[] = PLATFORM_LIST.map((spec) => spec.id);

/** 已实现对话 Provider 的平台 id。 */
export const PLATFORMS_WITH_PROVIDER: string[] = PLATFORM_LIST.filter(
  (spec) => spec.providerImplemented,
).map((spec) => spec.id);

/** 取平台显示名（未登记的平台原样返回 id）。 */
export function platformDisplayName(platform: string): string {
  return PLATFORMS[platform]?.displayName ?? platform;
}

/** 平台是否已登记（有登录入口）。 */
export function isKnownPlatform(platform: string): boolean {
  return Boolean(PLATFORMS[platform]);
}

/* ------------------------------------------------------------------ */
/* 向后兼容的视图                                                      */
/* ------------------------------------------------------------------ */
/*                                                                     */
/* 这三张表从 `credentials.ts` 搬来。保留同名的“视图”导出，是因为          */
/* `index.ts`（库入口）已经对外导出了它们，改名会破坏使用者。              */
/* 内部代码请直接用 {@link PLATFORMS} —— 视图只是给外部用的。             */

/** 平台 → 内部 API 特征（只有配置了的平台才有键）。 */
export const PLATFORM_API_PATTERNS: Record<string, PlatformApiPattern> = Object.fromEntries(
  // 类型谓词是必需的：否则 `Object.fromEntries` 会推断出
  // `Record<string, PlatformApiPattern | undefined>`，与声明不符
  PLATFORM_LIST.filter(
    (spec): spec is PlatformSpec & { apiPattern: PlatformApiPattern } => Boolean(spec.apiPattern),
  ).map((spec) => [spec.id, spec.apiPattern]),
);

/** 平台 → 登录入口。 */
export const PLATFORM_LOGIN_URLS: Record<string, string> = Object.fromEntries(
  PLATFORM_LIST.map((spec) => [spec.id, spec.loginUrl]),
);

/** 平台 → 中文显示名。 */
export const PLATFORM_NAMES: Record<string, string> = Object.fromEntries(
  PLATFORM_LIST.map((spec) => [spec.id, spec.displayName]),
);

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从凭证里提取账号身份（**按平台分派 + 统一兜底**）。
 *
 * 兜底规则（对所有平台生效，顺序不能改）：
 * 1. 平台提取器没给出 `identifier` → 用 bearer 前 16 位；连 bearer 都没有 → `'unknown'`；
 * 2. 仍没有 `label` → 用 `identifier` 前 12 位。
 *
 * 这两条保证任何凭证都能得到一个**稳定可比对**的 identifier ——
 * `router` 判断「两个账号文件是不是同一个人」全靠它。
 */
export function extractAccountInfoSync(platform: string, auth: AuthRecord): AccountInfo {
  const spec = PLATFORMS[platform];
  const info = spec ? spec.extractIdentity(auth) : extractGeneric(auth);

  if (!info['identifier']) {
    const bearer = str(auth.bearer);
    if (bearer) {
      info['identifier'] = bearer.slice(0, 16);
      info['label'] = `token:${bearer.slice(0, 8)}...`;
    } else {
      info['identifier'] = 'unknown';
    }
  }
  if (!info['label']) {
    info['label'] = (info['identifier'] ?? '').slice(0, 12);
  }

  return info;
}

