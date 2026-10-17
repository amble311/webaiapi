/**
 * 辅助通道的平台优先顺序（2026-10-16 用户要求「辅助通道优先在同一平台中」）。
 *
 * 背景：`getAuxCandidates()` 原来写死 `AUX_CHANNEL_PLATFORMS[0]`（chatglm）——
 * 主通道是 deepseek 且用户登录了两个 deepseek 账号时，辅助通道**永远**不会用同平台的
 * 第二个账号（会去 chatglm 找，找不到就让辅助任务与主对话串行）。
 */
import { describe, expect, it } from 'vitest';

import { ModelRouter, auxPlatformOrder, getModelRouter } from '../../src/controllers/router.js';
import { PLATFORM_MODEL_NAMES } from '../../src/controllers/router.js';

describe('auxPlatformOrder', () => {
  it('⭐ 主通道所在平台排第一（两个同平台账号 → 一个主、一个副）', () => {
    expect(auxPlatformOrder('deepseek', ['chatglm', 'deepseek'])).toEqual(['deepseek', 'chatglm']);
    expect(auxPlatformOrder('chatglm', ['chatglm', 'deepseek'])).toEqual(['chatglm', 'deepseek']);
    expect(auxPlatformOrder('deepseek', ['deepseek'])).toEqual(['deepseek']);
  });

  it('主平台未启用辅助通道 / 未知 / mix → 只按声明顺序兜底', () => {
    // deepseek 的 provider 还没实现 `channelKey`，暂时不在辅助通道名单里
    expect(auxPlatformOrder('deepseek', ['chatglm'])).toEqual(['chatglm']);
    expect(auxPlatformOrder(undefined, ['chatglm'])).toEqual(['chatglm']);
    expect(auxPlatformOrder(null, ['chatglm', 'deepseek'])).toEqual(['chatglm', 'deepseek']);
    expect(auxPlatformOrder('', ['chatglm'])).toEqual(['chatglm']);
  });

  it('不产生重复、不改动入参', () => {
    const platforms = ['chatglm', 'deepseek'] as readonly string[];
    const out = auxPlatformOrder('deepseek', platforms);
    expect(out).toEqual(['deepseek', 'chatglm']);
    expect(out.filter((p) => p === 'deepseek')).toHaveLength(1);
    expect(platforms).toEqual(['chatglm', 'deepseek']);
  });

  it('空名单 → 空（调用方回落主候选、串行执行）', () => {
    expect(auxPlatformOrder('chatglm', [])).toEqual([]);
    expect(auxPlatformOrder(undefined, [])).toEqual([]);
  });
});

/**
 * ⭐ 2026-10-16 实测事故：`registerProviders()` **写死只注册 chatglm** ——
 * deepseek 的 provider、工厂表、`providerImplemented: true` 三样都齐了，
 * 却永远不会被注册 → 客户端请求 `model=deepseek` 得到「模型 'deepseek' 不存在或不可用」。
 *
 * 这条断言遍历 `PLATFORM_MODEL_NAMES`（= `PLATFORMS_WITH_PROVIDER`），
 * 任何「声明已实现对话能力、却没真的注册 Provider」的平台都会让它立刻变红 ——
 * 上面那个 bug 之所以能溜到真机，就是因为没有这条。
 */
describe('provider 注册覆盖所有已实现平台', () => {
  it('⭐ 每个 providerImplemented 的平台都必须真的注册为 Provider', () => {
    const router = getModelRouter();
    const registered = router.getAllProviders();

    for (const platform of PLATFORM_MODEL_NAMES) {
      expect(registered.has(platform)).toBe(true);
    }
    // 至少要有 deepseek（chatglm 之外的那个平台就是它暴露出来的问题）
    expect(PLATFORM_MODEL_NAMES).toContain('deepseek');
  });

  it('注册的 Provider 声明了自己的模型名，且模型能被路由到该平台', () => {
    const router = getModelRouter();
    for (const [name, provider] of router.getAllProviders()) {
      expect(provider.getModels().length).toBeGreaterThan(0);
      for (const model of provider.getModels()) {
        expect(router.platformOfModel(model)).toBe(name);
      }
    }
  });

  it('工厂表与 providerImplemented 一致（声明了就必须有工厂）', () => {
    // 与上一组同一事实来源的另一种表述：运行时不会打「没有工厂，跳过」那句 warn
    const router = new ModelRouter();
    expect(router.getAllProviders().size).toBe(PLATFORM_MODEL_NAMES.length);
  });
});
