/**
 * 模型目录与配置建议（`/v1/models` 与 `webaiapi model` 共用）。
 *
 * 为什么要测：清单里出现**实际不能用的模型**是最坑的 —— OpenAI 兼容客户端先拉列表
 * 再让用户挑，挑到不能用的就是一次失败请求。所以「来源 + 去重 + 顺序」都要钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  buildModelCatalog,
  formatModelReport,
  type PlatformModelReport,
} from '../../src/controllers/model-catalog.js';

describe('buildModelCatalog', () => {
  it('三类来源按顺序合并：配置 → 已登录平台 → 别名', () => {
    const catalog = buildModelCatalog({
      configModels: ['mix'],
      platformModels: ['chatglm', 'deepseek'],
      aliasModels: ['glm-4', 'glm-3'],
      providerOfModel: (m) => (m.startsWith('glm') ? 'chatglm' : undefined),
    });
    expect(catalog.map((e) => e.id)).toEqual(['mix', 'chatglm', 'deepseek', 'glm-4', 'glm-3']);
    expect(catalog[0]).toEqual({ id: 'mix', provider: 'mix', source: 'config' });
    expect(catalog[1]).toEqual({ id: 'chatglm', provider: 'chatglm', source: 'platform' });
    expect(catalog[3]).toEqual({ id: 'glm-4', provider: 'chatglm', source: 'alias' });
  });

  it('配置支持 `model:platform` 形式（挑定平台的展示模型）', () => {
    const catalog = buildModelCatalog({
      configModels: ['mix', 'fast:chatglm'],
      platformModels: [],
      aliasModels: [],
    });
    expect(catalog).toEqual([
      { id: 'mix', provider: 'mix', source: 'config' },
      { id: 'fast', provider: 'chatglm', source: 'config' },
    ]);
  });

  it('同名去重（先到先得，不重复出现在列表里）', () => {
    const catalog = buildModelCatalog({
      configModels: ['mix', 'chatglm'],
      platformModels: ['chatglm'],
      aliasModels: ['mix', 'glm-4'],
      providerOfModel: () => 'chatglm',
    });
    expect(catalog.map((e) => e.id)).toEqual(['mix', 'chatglm', 'glm-4']);
  });

  it('空输入 → 空列表（不崩）', () => {
    expect(buildModelCatalog({ configModels: [], platformModels: [], aliasModels: [] })).toEqual([]);
  });
});

describe('formatModelReport', () => {
  const platforms: PlatformModelReport[] = [
    {
      id: 'chatglm',
      displayName: 'ChatGLM (智谱)',
      accounts: [
        { id: 'default', label: '洛小北' },
        { id: 'acc2', label: '用户_bFa15b' },
      ],
      chatCapable: true,
      auxCapable: true,
    },
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      accounts: [{ id: 'c4aacdd2', label: '徐崇夏' }],
      chatCapable: false,
      auxCapable: true,
    },
    { id: 'kimi', displayName: 'Kimi', accounts: [], chatCapable: false, auxCapable: false },
  ];

  const report = formatModelReport({
    catalog: [
      { id: 'mix', provider: 'mix', source: 'config' },
      { id: 'chatglm', provider: 'chatglm', source: 'platform' },
      { id: 'deepseek', provider: 'deepseek', source: 'platform' },
      { id: 'glm-4', provider: 'chatglm', source: 'alias' },
    ],
    platforms,
    baseUrl: 'http://127.0.0.1:8631/v1',
    apiKeyRequired: false,
    defaultModel: 'mix',
  });

  it('列出全部模型 id，并区分来源', () => {
    for (const id of ['mix', 'chatglm', 'deepseek', 'glm-4']) expect(report).toContain(id);
    expect(report).toContain('已登录平台');
    expect(report).toContain('别名');
  });

  it('⭐ 未实现对话能力的平台必须明确标注（别让客户端挑到不能用的）', () => {
    expect(report).toContain('尚未实现对话能力');
    expect(report).toContain('deepseek');
  });

  it('平台状态带上账号数与身份，未登录的标出来', () => {
    expect(report).toContain('default=洛小北');
    expect(report).toContain('c4aacdd2=徐崇夏');
    expect(report).toContain('未登录'); // kimi
  });

  it('⭐ 配置建议含 base_url / 模型名 / API Key 策略', () => {
    expect(report).toContain('http://127.0.0.1:8631/v1');
    expect(report).toContain('模型名');
    expect(report).toContain('API Key');
    // ⚠️ 刻意**不**展示「上下文长度」：我们不对客户端宣称窗口大小
    // （真实行为是历史压缩 + 64K 字符提示词上限，见 hard-constraints）
    expect(report).not.toContain('上下文长度');
    expect(report).not.toContain('CONTEXT_LENGTH');
  });

  it('多账号时提示「辅助通道会自动启用」', () => {
    expect(report).toContain('辅助通道');
    expect(report).toContain('并行');
  });

  it('没有任何账号时给出明确下一步', () => {
    const empty = formatModelReport({
      catalog: [],
      platforms: [{ id: 'chatglm', displayName: 'x', accounts: [], chatCapable: true, auxCapable: true }],
        baseUrl: 'http://127.0.0.1:8631/v1',
      apiKeyRequired: false,
      defaultModel: 'mix',
    });
    expect(empty).toContain('webaiapi login');
  });
});
