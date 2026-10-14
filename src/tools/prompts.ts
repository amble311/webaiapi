/**
 * 兜底轮的提示词 —— 原来是「两轮策略转换器」（`build_reparse_prompt`），
 * 2026-10-14 与「自驱动续跑」「工具名纠正轮」合并成**唯一一层**动作恢复轮
 * （见 `docs/native-parity.md`）。
 *
 * ⚠️ 关键踩坑（2026-09-2x）：工具名**必须取自客户端真实 tools**，绝不能硬编码
 * `Write` / `SearchReplace` / `Read`。实测客户端只提供 `list_dir`/`read_file`/`search_content`
 * 时，旧提示词却写着「工具名必须严格使用以下名称：read_file, Write, SearchReplace」，
 * 转换器照着输出 → 客户端没有这些工具 → 被 `filterUnknownToolCalls` 全部丢弃，
 * 表现为「转换成功但 IDE 不执行」。
 */
import type { ToolDefinition } from '../types/message.js';
import { toolNameOf, toolParamNames } from '../types/message.js';
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './protocol.js';

/* ==================================================================== */
/* 动作恢复轮（**唯一一层兜底**）                                      */
/* ==================================================================== */

/** 恢复轮里回放「上一轮回复」的长度上限。 */
export const RECOVERY_ANSWER_MAX_LEN = 4000;

export interface BuildActionRecoveryPromptOptions {
  /** 上一轮的回复/思考正文（可能为空 —— 整轮只输出了一段 `<tool_call>` 块）。 */
  answer?: string;
  /** 上一轮里「客户端没有这个工具」的调用名（空数组表示「压根没给出调用」）。 */
  invalidNames?: ReadonlyArray<string>;
  /** 上一轮这些调用的原文（`name(arguments)`），让模型看清自己原本想调什么。 */
  invalidCalls?: ReadonlyArray<string>;
  /** 「最近进展」文本（`formatRecentProgress()` 的产出）。 */
  recentProgress?: string;
  /** 当前工作目录；默认取 `process.cwd()`（对应 Python 的 `os.getcwd()`）。 */
  currentWorkingDir?: string;
}

/**
 * 构造**唯一一层**兜底的提示词：逼模型把「下一步」变成真实的工具调用。
 *
 * ## 为什么只有一层（2026-10-14 重构）
 * 原来有**三套**独立兜底，最坏会串起来跑 2~3 轮额外对话（每轮实测 30~98s）：
 * - 「两轮策略 reparse」：本轮没有任何工具调用 → 让模型把文字转成调用；
 * - 「自驱动续跑」：回答像计划书（只说不做）→ 再驱动一轮；
 * - 「工具名纠正轮」：调了客户端没有的工具（如平台自带的 `execute_sandbox_code`）→ 纠正。
 * 三者的**触发条件互斥、提示词高度重叠**，合并成一个 directive 提示词即可，
 * 且总成本封顶为**一轮**（见 `docs/native-parity.md` 的「取舍与代价」）。
 *
 * ⚠️ 与 `buildReparsePrompt` 同样的铁律：**工具名/参数名只能取自客户端真实 tools**，
 * 绝不在提示词里硬编码任何工具名。
 */
export function buildActionRecoveryPrompt(
  tools: ReadonlyArray<ToolDefinition>,
  options: BuildActionRecoveryPromptOptions = {},
): string {
  const {
    answer = '',
    invalidNames = [],
    invalidCalls = [],
    recentProgress = '',
    currentWorkingDir = process.cwd(),
  } = options;

  const names = [...new Set(invalidNames.map((n) => (n ?? '').trim()).filter(Boolean))];
  const namesText = names.map((n) => `\`${n}\``).join(', ');

  // 问题定性：调错名字 vs 压根没动手（两者的「必须做的事」是一样的）
  const problem = names.length
    ? `你调用了**本环境不存在的工具**：${namesText}。\n` +
      '那些名字属于网页平台自带的工具（代码沙箱 / 联网搜索之类），本地客户端**没有提供**，' +
      '调用无效 —— 那一轮什么都不会被执行。'
    : '你上一轮**没有给出可执行的工具调用**（只有文字/计划），这在当前环境下是无效回复。';

  // 工具清单只列名称与参数名（长描述会干扰这一轮）
  const toolLines = tools.map((tool) => {
    const name = toolNameOf(tool);
    const params = toolParamNames(tool).join(', ');
    const desc = tool?.function?.description ?? '';
    const shortDesc = desc.length > 60 ? `${desc.slice(0, 60)}...` : desc;
    return `- ${name}(${params}): ${shortDesc}`;
  });

  const trimmedAnswer = answer.trim();
  let shownAnswer = trimmedAnswer.slice(0, RECOVERY_ANSWER_MAX_LEN);
  if (trimmedAnswer.length > RECOVERY_ANSWER_MAX_LEN) {
    shownAnswer += '\n\n[... 内容已截断 ...]';
  }
  const answerBlock = shownAnswer ? `\n[你上一轮的回复]\n${shownAnswer}\n` : '';
  const callsBlock = invalidCalls.length > 0 ? `\n[你上一轮实际输出的调用]\n${invalidCalls.join('\n')}\n` : '';
  const progressBlock = recentProgress ? `\n# 最近进展（对话尾部）\n${recentProgress}\n` : '';

  return `你上一轮没有推进任务。${problem}

[现在必须做的事]
1. **只输出工具调用**（${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE}），不要任何解释、计划、清单、总结，
   也不要复述本段文字。
2. 把「下一步」换成下方清单里的**真实工具**：要执行代码/命令 → 用命令执行类工具；
   要读文件 → 用读取类工具；要改文件 → 用修改/写入类工具。
3. **禁止**输出清单以外的工具名${namesText ? `（尤其禁止 ${namesText}）` : ''}；
   **禁止占位符**（如「真实文件路径」「文件内容」「<...>」），file_path 用真实绝对路径。
4. 不需要再问、不要再确认——直接调用。
5. **不要重复已经执行过的同一条调用**（同工具 + 同参数）；
   如果事实上已经没有新动作可做，就只输出一行文字：\`任务已完成。\`

# 本次可用的真实工具（只有这些可用）
${toolLines.join('\n')}

# 当前工作目录
\`${currentWorkingDir}\`
${progressBlock}${answerBlock}${callsBlock}
现在输出工具调用：`;
}
