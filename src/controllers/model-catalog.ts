/**
 * 模型目录与配置建议 —— `/v1/models` 与 `webaiapi model` **共用一份事实来源**。
 *
 * 为什么要抽出来（2026-10-16）：`/v1/models` 的拼装逻辑原本写在路由里，而新命令
 * `webaiapi model` 要展示同样的清单 + 配置建议。两处各写一遍必然会走散
 * （清单里有、实际不能用的模型是**最坑**的那种：OpenAI 兼容客户端先拉列表再让用户挑）。
 *
 * 清单来源与顺序（与 `/v1/models` 完全一致）：
 * 1. **配置的展示模型**（`AVAILABLE_MODELS`，默认 `mix`；支持 `model:platform` 形式）；
 * 2. **已捕获凭证的平台名**（动态：捕获了哪个平台就能直接调该平台名）；
 * 3. **Provider 登记的模型别名**（如 `glm-4` / `glm-3` → chatglm）。
 */

/** 模型来源（用来解释「这个 id 为什么在列表里」）。 */
export type ModelSource = 'config' | 'platform' | 'alias';

export interface ModelCatalogEntry {
  /** 模型 id（对客户端可见的那个）。 */
  id: string;
  /** 实际承载它的平台（`mix` 等聚合模型则是它自己的名字）。 */
  provider: string;
  source: ModelSource;
}

/** 构建模型目录（纯函数，可单测）。 */
export function buildModelCatalog(input: {
  configModels: readonly string[];
  platformModels: readonly string[];
  aliasModels: readonly string[];
  providerOfModel?: (model: string) => string | undefined;
}): ModelCatalogEntry[] {
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  const push = (id: string, provider: string, source: ModelSource): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, provider, source });
  };

  for (const raw of input.configModels) {
    // 支持 `model:platform` 形式（挑定平台的展示模型）
    const idx = raw.indexOf(':');
    const id = idx >= 0 ? raw.slice(0, idx) : raw;
    // 没有 `:platform` 后缀时尽力解析；`mix` 这类聚合模型就以自己为 provider
    const provider =
      idx >= 0 ? raw.slice(idx + 1) : (input.providerOfModel?.(id) ?? (id === 'mix' ? 'mix' : 'unknown'));
    push(id, provider, 'config');
  }
  for (const platform of input.platformModels) push(platform, platform, 'platform');
  for (const model of input.aliasModels) {
    push(model, input.providerOfModel?.(model) ?? 'unknown', 'alias');
  }

  return out;
}

/** 平台在 `webaiapi model` 里的展示信息。 */
export interface PlatformModelReport {
  id: string;
  displayName: string;
  /** 已捕获的账号（id + 身份标签）。 */
  accounts: ReadonlyArray<{ id: string; label: string }>;
  /** 是否实现了对话能力（`providerImplemented`）。 */
  chatCapable: boolean;
  /** 是否可作辅助通道（需要 provider 支持独立 context 页面）。 */
  auxCapable: boolean;
}

const SOURCE_LABEL: Record<ModelSource, string> = {
  config: '配置',
  platform: '已登录平台',
  alias: '别名',
};

/** 每个模型 id 的一句话说明（挑不出特别说明时给通用文案）。 */
function describeModel(entry: ModelCatalogEntry, chatCapable: Set<string>): string {
  if (entry.source === 'config' && entry.id === 'mix') {
    return '默认：按平台顺序自动故障转移（推荐）';
  }
  if (entry.source === 'platform') {
    return chatCapable.has(entry.id)
      ? `仅走 ${entry.provider}`
      : '⚠️ 尚未实现对话能力（只能捕获凭证）';
  }
  if (entry.source === 'alias') return `${entry.provider} 的模型别名`;
  return '';
}

/**
 * 生成 `webaiapi model` 的文本报告（纯函数，便于断言文案）。
 */
export function formatModelReport(input: {
  catalog: readonly ModelCatalogEntry[];
  platforms: readonly PlatformModelReport[];
  baseUrl: string;
  apiKeyRequired: boolean;
  defaultModel: string;
}): string {
  const lines: string[] = [];
  const chatCapable = new Set(
    input.platforms.filter((p) => p.chatCapable).map((p) => p.id),
  );

  lines.push('webaiapi 模型与配置建议');
  lines.push('─'.repeat(64));

  lines.push('');
  lines.push('【可用模型】');
  if (input.catalog.length === 0) {
    lines.push('  （暂无）先执行 `webaiapi login` 捕获一个平台的凭证');
  }
  const width = Math.max(8, ...input.catalog.map((e) => e.id.length));
  for (const entry of input.catalog) {
    const note = describeModel(entry, chatCapable);
    lines.push(
      `  ${entry.id.padEnd(width)}  ${SOURCE_LABEL[entry.source].padEnd(10)}  ` +
        `provider=${entry.provider.padEnd(9)} ${note}`.trimEnd(),
    );
  }

  lines.push('');
  lines.push('【平台状态】');
  for (const p of input.platforms) {
    const accounts = p.accounts.length
      ? `账号 ${p.accounts.length}（${p.accounts.map((a) => `${a.id}${a.label ? `=${a.label}` : ''}`).join(', ')}）`
      : '未登录';
    lines.push(
      `  ${p.id.padEnd(9)} ${p.displayName.padEnd(14)} ${accounts.padEnd(28)}` +
        `对话 ${p.chatCapable ? '✅' : '❌'}   辅助通道 ${p.auxCapable ? '✅' : '—'}`,
    );
  }

  lines.push('');
  lines.push('【配置建议】');
  lines.push(`  base_url      ${input.baseUrl}`);
  lines.push(`  模型名        ${input.defaultModel}（默认；也可直接写平台名锁定单平台）`);
  lines.push(
    `  API Key       ${input.apiKeyRequired ? '已启用（API_KEYS 里的值）' : '未启用（要启用：API_KEY_REQUIRED=true + API_KEYS=xxx）'}`,
  );
  lines.push('  工具调用      客户端照常传 tools；背后由注入的文本协议承载（无需特殊配置）');

  const notices: string[] = [];
  for (const p of input.platforms) {
    if (p.accounts.length > 0 && !p.chatCapable) {
      notices.push(`${p.id}：只捕获了凭证，**对话能力还没实现** —— 现在调它只能走故障转移`);
    }
  }
  if (input.platforms.some((p) => p.accounts.length >= 2)) {
    notices.push('同平台的第二个账号会自动作为**辅助通道**（压缩/转换与主对话并行）');
  } else if (input.platforms.some((p) => p.accounts.length === 1)) {
    notices.push('只有 1 个账号时压缩/转换与主对话**串行**（功能正常，只是慢）：再加一个 webaiapi login <平台>');
  }
  if (notices.length > 0) {
    lines.push('');
    lines.push('【提示】');
    for (const n of notices) lines.push(`  · ${n}`);
  }

  return lines.join('\n');
}
