import type { FastifyReply, FastifyRequest } from 'fastify';

import { describe, expect, it } from 'vitest';

import {
  ApiKeyManager,
  extractApiKey,
  getApiKeyManager,
  makeApiKeyHook,
} from '../../src/server/middleware/api-key.js';

/**
 * API Key 中间件。
 *
 * ⚠️ 核心语义：**「一个密钥都没配」= 认证功能整体关闭**，此时必须忽略请求里
 * 带的任何 Key。OpenAI 兼容客户端几乎总会带 `Authorization` 头（不少还强制
 * 要求填非空值）—— 旧实现在这里 401，导致服务端日志说「认证已禁用」、
 * 客户端却收到「API Key 无效或已过期」，两边各说各话（实测 xzh 就死在这）。
 */

function req(headers: Record<string, string>, url = '/v1/chat/completions'): FastifyRequest {
  return { url, headers } as unknown as FastifyRequest;
}

describe('extractApiKey', () => {
  it('Authorization: Bearer 优先', () => {
    expect(extractApiKey(req({ authorization: 'Bearer abc123' }))).toBe('abc123');
  });

  it('其次 x-api-key', () => {
    expect(extractApiKey(req({ 'x-api-key': 'xyz' }))).toBe('xyz');
  });

  it('Bearer 后面为空不算传了 Key', () => {
    expect(extractApiKey(req({ authorization: 'Bearer ' }))).toBeNull();
    expect(extractApiKey(req({ authorization: 'Bearer' }))).toBeNull();
  });

  it('什么都没有 → null', () => {
    expect(extractApiKey(req({}))).toBeNull();
  });
});

describe('ApiKeyManager：认证关闭（一个密钥都没配）', () => {
  it('⭐ 此时忽略请求里带的任何 Key（这是「禁用」应有的含义）', () => {
    const mgr = new ApiKeyManager();
    expect(mgr.count).toBe(0);

    expect(mgr.isValid(undefined)).toBe(true);
    expect(mgr.isValid(null)).toBe(true);
    expect(mgr.isValid('')).toBe(true);
    // ⭐ 旧实现在这里返回 false → 401「API Key 无效」
    expect(mgr.isValid('client-填的占位符')).toBe(true);
  });

  it('required=true 时即使没配密钥也不放行（配置自相矛盾要暴露出来）', () => {
    const mgr = new ApiKeyManager();
    mgr.required = true;
    expect(mgr.isValid(null)).toBe(false);
    expect(mgr.isValid('随便填的')).toBe(false);
  });
});

describe('ApiKeyManager：配置了密钥（真认证）', () => {
  it('正确密钥放行；错误密钥一定 401（即使 required=false）', () => {
    const mgr = new ApiKeyManager();
    mgr.addKey('secret-1');

    expect(mgr.isValid('secret-1')).toBe(true);
    expect(mgr.isValid('wrong')).toBe(false);
    expect(mgr.isValid(null)).toBe(true); // 没传且不强制 → 放行
  });

  it('required=true：没传密钥 → 401', () => {
    const mgr = new ApiKeyManager();
    mgr.addKey('secret-1');
    mgr.required = true;

    expect(mgr.isValid(null)).toBe(false);
    expect(mgr.isValid('secret-1')).toBe(true);
  });

  it('addKey 会 trim，空串不加入', () => {
    const mgr = new ApiKeyManager();
    mgr.addKey('  k1  ');
    mgr.addKey('   ');
    expect(mgr.count).toBe(1);
    expect(mgr.isValid('k1')).toBe(true);
  });
});

describe('makeApiKeyHook（Fastify 钩子）', () => {
  it('⭐ 认证关闭时，带任何 Key 的请求都放行', async () => {
    const mgr = getApiKeyManager();
    expect(mgr.count).toBe(0); // 前提：测试进程没配密钥

    const hook = makeApiKeyHook(new Set(['/health']));
    await expect(
      hook(req({ authorization: 'Bearer 占位符' }), {} as FastifyReply),
    ).resolves.toBeUndefined();
  });

  it('豁免路径不校验', async () => {
    const hook = makeApiKeyHook(new Set(['/health']));
    await expect(hook(req({}, '/health'), {} as FastifyReply)).resolves.toBeUndefined();
  });

  it('配了密钥后：错误密钥被拒（抛 AuthenticationError），正确密钥放行', async () => {
    const mgr = getApiKeyManager();
    mgr.addKey('test-secret');
    try {
      const hook = makeApiKeyHook(new Set(['/health']));

      await expect(
        hook(req({ authorization: 'Bearer wrong' }), {} as FastifyReply),
      ).rejects.toThrow(/API Key 无效/);

      await expect(
        hook(req({ authorization: 'Bearer test-secret' }), {} as FastifyReply),
      ).resolves.toBeUndefined();
    } finally {
      mgr.removeKey('test-secret'); // 还原单例状态，避免影响其它用例
    }
  });
});
