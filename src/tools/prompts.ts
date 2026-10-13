/**
 * 两轮策略的「转换器」提示词 —— `legacy-python/src/utils/tool_calls.py` 的 `build_reparse_prompt`。
 *
 * 场景：第一轮让模型自由回复（生成代码/文档），第二轮让它把回复**原样**转成工具调用。
 *
 * ⚠️ 关键踩坑（2026-09-2x）：工具名**必须取自客户端真实 tools**，绝不能硬编码
 * `Write` / `SearchReplace` / `Read`。实测客户端只提供 `list_dir`/`read_file`/`search_content`
 * 时，旧提示词却写着「工具名必须严格使用以下名称：read_file, Write, SearchReplace」，
 * 转换器照着输出 → 客户端没有这些工具 → 被 `filterUnknownToolCalls` 全部丢弃，
 * 表现为「转换成功但 IDE 不执行」。
 */
import type { ToolDefinition } from '../types/message.js';
import { toolNameOf, toolParamNames, toolRequiredParams } from '../types/message.js';
import { detectToolNames } from './names.js';
import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from './protocol.js';
import { PY_W_CHARS } from './repair.js';

/** 匹配「疑似文件路径」的正则（用 PY_W_CHARS 以支持中文文件名）。 */
const FILE_PATH_IN_TEXT = new RegExp(
  String.raw`[/~][${PY_W_CHARS}./-]+\.[${PY_W_CHARS}]{1,10}`,
  'gu',
);

/** 第一轮回复注入提示词时的截断长度。 */
export const REPARSE_INPUT_MAX_LEN = 8000;

/** 提示词里列出的真实路径上限。 */
const MAX_CONTEXT_PATHS = 10;

export interface BuildReparsePromptOptions {
  /** 原始用户请求（提供上下文）。 */
  userRequest?: string;
  /** 对话历史文本（用于提取真实文件路径）。 */
  conversationHistory?: string;
  /** 当前工作目录；默认取 `process.cwd()`（对应 Python 的 `os.getcwd()`）。 */
  currentWorkingDir?: string;
}

/**
 * 构造第二轮的「文本 → 工具调用」转换提示词。
 *
 * @param firstResponse 第一轮的文本回复
 * @param tools 客户端真实工具列表
 */
export function buildReparsePrompt(
  firstResponse: string,
  tools: ReadonlyArray<ToolDefinition>,
  options: BuildReparsePromptOptions = {},
): string {
  const {
    userRequest = '',
    conversationHistory = '',
    currentWorkingDir = process.cwd(),
  } = options;

  // 只展示客户端**真实存在**的工具名，不设默认值
  const detected = detectToolNames(tools);
  const writeName = detected['write'] ?? '';
  const editName = detected['edit'] ?? '';

  const allNames = tools.map((t) => toolNameOf(t)).filter(Boolean);
  const namesText = allNames.length > 0 ? allNames.join(', ') : '（见下方可用工具）';

  // 文件类操作建议：只在客户端确实提供了对应工具时才给
  const fileOpRules: string[] = [];
  if (editName && writeName) {
    fileOpRules.push(
      `- **如果文件已存在（之前 Read 过），必须用 ${editName} 修改，不要用 ${writeName} 覆盖**`,
    );
    fileOpRules.push(`- 如果文件不存在，用 ${writeName} 创建`);
    fileOpRules.push(`- ${editName} 的 old_str 必须是文件中真实存在的代码片段`);
  }

  // 示例：只展示真实存在的工具 + 真实参数名
  const examples: string[] = [];
  if (writeName) {
    examples.push(
      `${TOOL_CALL_OPEN}\n` +
        `{"name": "${writeName}", "arguments": {"file_path": "<此处填写真实文件路径>", ` +
        `"content": "<此处填写真实文件内容>"}}\n` +
        TOOL_CALL_CLOSE,
    );
  }
  if (editName) {
    examples.push(
      `${TOOL_CALL_OPEN}\n` +
        `{"name": "${editName}", "arguments": {"file_path": "<此处填写真实文件路径>", ` +
        `"old_str": "<此处填写文件中已存在的原文>", "new_str": "<此处填写替换后的新文本>"}}\n` +
        TOOL_CALL_CLOSE,
    );
  }
  if (examples.length === 0 && tools.length > 0) {
    // 客户端没有写/改文件类工具（例如只有 list_dir / read_file / search_content）
    const first = tools[0] as ToolDefinition;
    const firstName = toolNameOf(first) || '工具名';
    const required = toolRequiredParams(first);
    const props = toolParamNames(first);

    const sampleArgs: Record<string, string> = {};
    for (const p of required.length > 0 ? required : props.slice(0, 2)) {
      sampleArgs[p] = `<${p} 的真实取值>`;
    }
    examples.push(
      `${TOOL_CALL_OPEN}\n` +
        `{"name": "${firstName}", "arguments": ${JSON.stringify(sampleArgs)}}\n` +
        TOOL_CALL_CLOSE,
    );
  }
  const examplesText = examples.join('\n\n');

  // 截断过长的第一轮回复（避免占用输入框额度）
  let truncated = firstResponse.slice(0, REPARSE_INPUT_MAX_LEN);
  if (firstResponse.length > REPARSE_INPUT_MAX_LEN) {
    truncated += '\n\n[... 内容已截断 ...]';
  }

  // 工具清单只列名称与参数名（长描述会干扰第二轮）
  const toolLines = tools.map((tool) => {
    const name = toolNameOf(tool);
    const params = toolParamNames(tool).join(', ');
    const desc = tool?.function?.description ?? '';
    const shortDesc = desc.length > 60 ? `${desc.slice(0, 60)}...` : desc;
    return `- ${name}(${params}): ${shortDesc}`;
  });
  const toolsSummary = toolLines.join('\n');

  // 从历史 / 请求 / 回复里收集真实路径，避免模型照抄占位路径
  const contextPaths = new Set<string>();

  if (conversationHistory) {
    for (const m of conversationHistory.matchAll(/"file_path"\s*:\s*"([^"]+)"/gu)) {
      const p = m[1] as string;
      if (p && !p.startsWith('http') && p.length < 200) contextPaths.add(p);
    }
    for (const m of conversationHistory.matchAll(FILE_PATH_IN_TEXT)) {
      const p = m[0];
      if (!p.startsWith('http') && p.length < 200) contextPaths.add(p);
    }
  }

  for (const src of [userRequest, firstResponse]) {
    for (const m of src.matchAll(FILE_PATH_IN_TEXT)) {
      const p = m[0];
      if (!p.startsWith('http') && p.length < 200) contextPaths.add(p);
    }
  }

  const contextPathsHint =
    contextPaths.size > 0
      ? '\n\n**对话中提到的真实文件路径**（必须使用这些路径，不要编造）：\n' +
        [...contextPaths]
          .sort()
          .slice(0, MAX_CONTEXT_PATHS)
          .map((p) => `  - ${p}`)
          .join('\n')
      : '';

  let workingDirHint = `\n\n**当前工作目录**：\`${currentWorkingDir}\`\n`;
  workingDirHint +=
    contextPaths.size > 0
      ? '**重要**：file_path 必须使用上述对话中提到的真实路径，不要编造路径。如果不确定路径，使用当前工作目录下的相对路径。'
      : '**重要**：如果对话中没有提到具体路径，使用当前工作目录下的相对路径或绝对路径。';

  return `你是一个工具调用转换器。请将以下AI回复内容转换为工具调用格式。

**严格要求**：
- 只输出 ${TOOL_CALL_OPEN}...${TOOL_CALL_CLOSE} 格式的工具调用
- 不要输出任何解释、描述或额外文字
- **绝对禁止输出占位符/示例文本**：不得出现「真实文件路径」「文件内容」「要替换的代码」「新代码」「<...>」等字样，这些只是格式说明，不是真实值
- **file_path 必须是具体的、真实存在的文件路径**（取自下方"对话中提到的真实文件路径"或"当前工作目录"）
- **content / old_str / new_str 必须来自 AI 回复中的真实内容**，不得编造
${fileOpRules.join('\n')}
- **工具名必须严格取自下方「可用工具」列表，本次只有：${namesText}**
- 不要输出列表之外的工具名（例如客户端没有 Write / SearchReplace 时绝不能输出它们）
${contextPathsHint}
${workingDirHint}

# 可用工具
${toolsSummary}

# 输出格式（仅示意 JSON 结构；尖括号 <> 内为需要你替换的说明，禁止原样输出尖括号内容）
${examplesText}

# 用户原始请求
${userRequest}

# AI的回复（需要转换为工具调用）
${truncated}

现在输出工具调用（file_path 必须是真实路径，禁止输出「真实文件路径」等占位符）：`;
}
