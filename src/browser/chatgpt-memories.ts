/**
 * ChatGPT「记忆（Memory）」的查看与清理。
 *
 * ## 为什么需要它（2026-10-24 用户实测）
 *
 * 用户在设置里**关掉了「启用记忆」**，但仍然被旧记忆影响：
 * 「已保存的记忆」和开关是**两件事** —— 关开关只是**不再新增** ✗，
 * 旧的记忆条目**照旧作用于每一轮回答** ✓。
 *
 * 实测（2026-10-24）该账号关掉开关后仍有 **8 条**记忆在生效，其中：
 * - `用户要求记住数字"738291"` / `用户指定的暗号是"紫水晶"` —— 我们排障时的测试垃圾；
 * - `补充用户的玄猪/Auto.js 工作规范：…` —— 在 `btc` 项目里答出 `xzh` 内容的**元凶**。
 *
 * 所以提供一个显式命令：`webaiapi chatgpt-memories`（只列）/ `--clear`（全删）。
 * ⚠️ 这是**用户的个人数据**，默认只读；删必须显式加 `--clear`。
 */
import type { Page } from 'playwright';

import { getChannelPage, loadCookies } from './manager.js';
import { STEALTH_JS } from './stealth.js';
import { evaluateFn } from './js-eval.js';

/** 一条记忆。 */
export interface ChatgptMemory {
  id: string;
  content: string;
  status?: string;
  updatedAt?: string;
}

interface RawMemory {
  id?: unknown;
  content?: unknown;
  status?: unknown;
  updated_at?: unknown;
}

/** 页面内脚本：拿 accessToken（cookie 认证，取 session 里的 token）。 */
const SESSION_TOKEN_JS = `async () => {
  try {
    const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
    if (!r.ok) return '';
    const d = await r.json();
    return String((d && d.accessToken) || '');
  } catch (e) {
    return '';
  }
}`;

/** 打开/复用一个已登录的 chatgpt 页面。 */
async function openChatgptPage(accountId: string): Promise<Page | null> {
  const page = await getChannelPage(`chatgpt:${accountId}`, 'chatgpt', accountId);
  if (!page) return null;
  await loadCookies('chatgpt', accountId).catch(() => false);
  await page.context().addInitScript({ content: STEALTH_JS }).catch(() => undefined);
  if (!page.url().startsWith('https://chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
  }
  return page;
}

/** 取 accessToken（空串 = 未登录 / 页面还没就绪）。 */
async function readAccessToken(page: Page): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const token = await evaluateFn<string>(page, SESSION_TOKEN_JS).catch(() => '');
    if (token) return token;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return '';
}

/**
 * 列出该账号的全部记忆。
 *
 * @returns `null` = 取不到（未登录 / 网络 / 接口变更），调用方应提示用户而不是当成"没有记忆"
 */
export async function listChatgptMemories(accountId: string): Promise<ChatgptMemory[] | null> {
  const page = await openChatgptPage(accountId);
  if (!page) return null;
  const token = await readAccessToken(page);
  if (!token) return null;

  const result = await evaluateFn<{ ok: boolean; items?: RawMemory[] } | null>(
    page,
    `async () => {
  try {
    const r = await fetch('https://chatgpt.com/backend-api/memories?include_memory_entries=true', {
      headers: { authorization: 'Bearer ' + ${JSON.stringify(token)}, accept: 'application/json' },
      credentials: 'include',
    });
    if (!r.ok) return { ok: false };
    const body = await r.json();
    const list = (body && (body.memories || body.entries)) || [];
    return { ok: true, items: Array.isArray(list) ? list : [] };
  } catch (e) {
    return { ok: false };
  }
}`,
  ).catch(() => null);

  if (!result?.ok) return null;
  const raw: RawMemory[] = result.items ?? [];
  return raw.map((item) => ({
    id: String(item.id ?? ''),
    content: String(item.content ?? ''),
    status: item.status === undefined ? undefined : String(item.status),
    updatedAt: item.updated_at === undefined ? undefined : String(item.updated_at),
  }));
}

/**
 * 删除一条记忆。
 *
 * @returns 是否删除成功
 */
export async function deleteChatgptMemory(accountId: string, memoryId: string): Promise<boolean> {
  const page = await openChatgptPage(accountId);
  if (!page) return false;
  const token = await readAccessToken(page);
  if (!token) return false;

  return evaluateFn<boolean>(
    page,
    `async () => {
  try {
    const r = await fetch('https://chatgpt.com/backend-api/memories/' + ${JSON.stringify(memoryId)}, {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + ${JSON.stringify(token)}, accept: 'application/json' },
      credentials: 'include',
    });
    return r.ok || r.status === 204;
  } catch (e) {
    return false;
  }
}`,
  ).catch(() => false);
}
