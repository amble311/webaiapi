/**
 * 工具协议注入与消息拍平 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * 网页版模型没有原生 function calling，只能靠「把工具说明写成文本注入提示词，
 * 再解析模型输出的 XML 标签」来模拟 OpenAI 的 tool_calls 协议。
 *
 * ⚠️ 提示词里的每一条强指令都对应一次真实事故（注释里标了日期），
 * 删任何一条前请先看 `docs/hard-constraints.md`。
 */
import { logger } from '../log/logger.js';
import type { ChatMessage, MessageDict, ToolDefinition } from '../types/message.js';
import {
  messageToDict,
  toolNameOf,
  toolParamNames,
  toolRequiredParams,
} from '../types/message.js';
import { detectToolNames, createToolMaps, type ToolMaps } from './names.js';

/** 工具调用的 XML 标签。 */
export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/** 匹配 `<tool_call>...</tool_call>` 块。 */
export const TOOL_CALL_PATTERN = new RegExp(
  `${escapeLiteral(TOOL_CALL_OPEN)}\\s*(.*?)\\s*${escapeLiteral(TOOL_CALL_CLOSE)}`,
  'su',
);

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 工具说明在提示词中的最大长度。
 *
 * 客户端的工具说明常常很长（含 Usage/Examples），全部注入会吃掉输入框额度，
 * 且**提示词越长模型越容易「只描述不调用」**。截断成一句话足够选对工具。
 */
export const TOOL_DESC_MAX_LEN = 80;

/** 对话中展示的已知路径上限。 */
const MAX_DISPLAY_PATHS = 15;

export interface FormatToolsOptions {
  /** 用户项目/工作目录（用于防止模型编造路径）。 */
  workspacePath?: string;
  /** 对话中已出现过的真实文件路径。 */
  knownFilePaths?: readonly string[];
}

/**
 * 把 OpenAI `tools` 定义渲染成注入用的文本块。
 *
 * 返回的文本会被追加到系统提示里，告诉模型用 `<tool_call>` 标签输出调用。
 *
 * 工具列表用**紧凑格式**：`名称(必填*,可选)：说明`。
 * 27 个工具实测从 11,892 字符降到 3,462 字符（-71%）。
 */
export function formatToolsAsText(
  tools: ReadonlyArray<ToolDefinition>,
  options: FormatToolsOptions = {},
): string {
  if (tools.length === 0) return '';

  const { workspacePath = '', knownFilePaths } = options;

  // 检测客户端实际工具名（仅用于提示词里的示例，映射表由 createToolMaps 单独提供）
  const detected = detectToolNames(tools);
  if (Object.keys(detected).length > 0) {
    logger.info({ detected }, '[tool_calls] 检测到客户端工具名映射');
  }

  const writeName = detected['write'] ?? 'Write';
  const editName = detected['edit'] ?? 'SearchReplace';

  const lines: string[] = [
    '# 工具调用协议',
    '',
    '需要读取/创建/修改文件或执行命令时，**必须输出工具调用**，不要只用文字描述应该做什么。',
    '',
    `格式（${TOOL_CALL_OPEN} 与 ${TOOL_CALL_CLOSE} 内不要空行，JSON 必须单行）：`,
    TOOL_CALL_OPEN,
    '{"name": "工具名", "arguments": {"参数名": "参数值"}}',
    TOOL_CALL_CLOSE,
    '',
    '规则：',
    `- 修改已有文件用 ${editName}，创建新文件用 ${writeName}；可用工具见下方列表`,
    '- 工具名与参数名必须严格照抄下方列表中的真实名称',
    '- **禁止输出占位符**（如 `<工具名>`、`<参数名>`、`<参数值>`、`参数1`、`值1`），必须替换成真实值',
    '- file_path 必须使用真实绝对路径，不要编造',
    // ⚠️ 2026-09-27：ChatGLM 网页端模型会看到页面自带工具（search/open/click/find），
    //    误判「没有 read_file 等文件工具」→ 放弃调用工具、只输出分析文字。
    //    必须显式声明工具清单的唯一性。
    `- **本次对话可用的工具只有下方列出的这 ${tools.length} 个**，它们是真实可用的，请直接调用`,
    '- 忽略运行环境自带的其他工具（如 search / open / click / find / browser 等），' +
      '它们不可用，禁止调用；也不要因为「缺少文件工具」而只用文字描述',
    // ⚠️ 2026-09-27 22:0x：模型反复调网页端自带 search，拿回一堆与本地项目无关的知识，
    //    把整轮对话耗光，最后只能输出「我从未真正读到过本项目代码」。
    '- **禁止联网搜索**：这是本地代码工程任务，联网搜索结果与本任务无关。' +
      '若你已经搜索过，请**忽略所有搜索结果**，改为用下方工具直接读取本地文件',
    '- **第一步必须调用下方工具**（如 list_dir / read_file / search_content）读取本地文件：' +
      '不要先输出计划、不要先解释、也不要用文字描述「我准备做什么」',
    // ⚠️ 2026-09-28 20:54：模型凭空认为「工具轮数已达上限（8/8）」，
    //    交了一份「需先补读 X、待下一轮执行」的计划书当最终回答 —— 纯文本回复会让客户端直接结束回合。
    '- **本次会话没有工具调用轮数上限**：需要更多文件内容就继续调用读取工具' +
      '（可一次并行读多个），累了也不要停',
    '- **禁止用计划代替动作**：不要回答「需先补读 X 文件」「待下一轮执行」' +
      '「工具轮数已达上限」「我下一步会…」——想读就直接读、想改就直接改，' +
      '用真实的工具调用推进任务',
    '- 只有**任务全部完成**后才输出总结文字；没做完就继续调用工具，' +
      '也不要把计划清单写进项目文件里',
    '',
  ];

  if (workspacePath) {
    lines.push(`当前项目目录：\`${workspacePath}\``);
  }
  if (knownFilePaths && knownFilePaths.length > 0) {
    const display = knownFilePaths.slice(0, MAX_DISPLAY_PATHS);
    lines.push(`对话中已出现的真实路径：${display.map((p) => `\`${p}\``).join(', ')}`);
    if (knownFilePaths.length > MAX_DISPLAY_PATHS) {
      lines.push(`（另有 ${knownFilePaths.length - MAX_DISPLAY_PATHS} 个路径已省略）`);
    }
  }
  lines.push('');

  // ===== 工具列表：紧凑格式 =====
  lines.push('## 可用工具（格式：名称(参数)：说明；参数带 * 为必填）');
  for (const tool of tools) {
    const name = toolNameOf(tool) || 'unknown';
    const description = (tool?.function?.description ?? '').trim();
    const props = tool?.function?.parameters?.properties ?? {};
    const required = toolRequiredParams(tool);

    const propNames = Object.keys(props);
    const reqNames = propNames.filter((p) => required.includes(p));
    const optNames = propNames.filter((p) => !required.includes(p));
    const paramsDesc = [...reqNames.map((p) => `${p}*`), ...optNames].join(', ');

    // 说明压成一行（去换行取首句）并截断
    let oneLine = description.split(/\s+/).filter(Boolean).join(' ');
    if (oneLine.length > TOOL_DESC_MAX_LEN) {
      oneLine = `${oneLine.slice(0, TOOL_DESC_MAX_LEN - 1)}…`;
    }

    lines.push(`- ${name}(${paramsDesc})：${oneLine}`);
  }

  return lines.join('\n');
}

/** `formatToolsAsText` + 映射表的组合结果。 */
export interface ToolProtocol {
  /** 要注入提示词的文本。 */
  text: string;
  /** 本请求专用的映射表（替代 Python 版的全局变量）。 */
  maps: ToolMaps;
}

/**
 * 一次算出「注入文本 + 映射表」。
 *
 * 路由层应该用这个函数而不是分别调用 `formatToolsAsText` / `createToolMaps`，
 * 避免映射表与提示词里的工具列表不一致。
 */
export function buildToolProtocol(
  tools: ReadonlyArray<ToolDefinition>,
  options: FormatToolsOptions = {},
): ToolProtocol {
  return {
    text: formatToolsAsText(tools, options),
    maps: createToolMaps(tools),
  };
}

/** 工具结果截断上限（Read 类例外，保留全文）。 */
const TOOL_RESULT_MAX = 5000;
/** assistant 文本截断上限。 */
const ASSISTANT_TEXT_MAX = 3000;
/** 工具调用参数截断上限。 */
const TOOL_ARGS_MAX = 3000;
/** function 角色结果截断上限。 */
const FUNCTION_RESULT_MAX = 3000;

/** Read 类工具名（结果保留全文，AI 需要完整内容才能正确生成替换片段）。 */
const READ_TOOL_NAMES = new Set(['read', 'readfile', 'get_file_content']);

/**
 * 把所有消息拍平成一段文本（等价于 `format_messages_as_text`）。
 *
 * 目的：让网页版模型在**一次提示**里看到完整对话上下文。
 *
 * 截断策略（这里是**唯一会丢内容**的地方）：
 * - tool_call 参数 > 3000 字符 → 截断
 * - assistant 文本 > 3000 字符 → 截断
 * - tool 结果 > 5000 字符 → 截断（Read 类例外，保留全文）
 */
export function formatMessagesAsText(messages: ReadonlyArray<ChatMessage | MessageDict>): string {
  const parts: string[] = [];

  for (const raw of messages) {
    const m = messageToDict(raw as ChatMessage);
    const role = m.role;
    let content = m.content ?? '';

    if (role === 'system') {
      parts.push(`[System]\n${asText(content)}`);
      continue;
    }

    if (role === 'user') {
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        for (const item of content) {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>;
            if (rec['type'] === 'text') textParts.push(String(rec['text'] ?? ''));
            else if (rec['type'] === 'image_url') textParts.push('[Image provided]');
          } else if (typeof item === 'string') {
            textParts.push(item);
          }
        }
        parts.push(`[User]\n${textParts.join(' ')}`);
      } else {
        parts.push(`[User]\n${asText(content)}`);
      }
      continue;
    }

    if (role === 'assistant') {
      let text = asText(content);
      const toolCalls = m.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          const name = tc.function?.name ?? '';
          let args: unknown = tc.function?.arguments ?? '';
          if (args && typeof args === 'object') args = JSON.stringify(args);
          let argsStr = String(args);
          if (argsStr.length > TOOL_ARGS_MAX) {
            argsStr = `${argsStr.slice(0, TOOL_ARGS_MAX)}... [参数已截断]`;
          }
          text += `\n${TOOL_CALL_OPEN}\n{"name": "${name}", "arguments": ${argsStr}}\n${TOOL_CALL_CLOSE}`;
        }
      }
      if (text.length > ASSISTANT_TEXT_MAX) {
        text = `${text.slice(0, ASSISTANT_TEXT_MAX)}... [回复已截断]`;
      }
      parts.push(`[Assistant]\n${text}`);
      continue;
    }

    if (role === 'tool') {
      let text = asText(content);
      const name = m.name ?? '';
      const lowerName = name.toLowerCase();

      if (!READ_TOOL_NAMES.has(lowerName) && text.length > TOOL_RESULT_MAX) {
        text = `${text.slice(0, TOOL_RESULT_MAX)}\n... [工具结果已截断，原始长度 ${text.length} 字符]`;
      }

      // 写入成功后提示 AI 别重复 Read / 覆盖
      if (['write_file', 'edit_file'].includes(lowerName) && text.toLowerCase().includes('success')) {
        text +=
          '\n\n[系统提示：文件已完整更新。如需进一步修改，请基于最新内容使用 SearchReplace，不要再用 write_file 覆盖。]';
      }

      // 替换失败时提示换用整文件写入
      if (
        ['searchreplace', 'edit_file', 'str_replace'].includes(lowerName) &&
        (text.toLowerCase().includes('fail') ||
          text.toLowerCase().includes('error') ||
          text.toLowerCase().includes('not found'))
      ) {
        text +=
          '\n\n[系统提示：SearchReplace 失败，可能是缩进或空格不匹配。建议改用 write_file 写入完整文件内容，而不是用 SearchReplace 修改局部。]';
      }

      parts.push(`[Tool Result: ${name} (id=${m.tool_call_id ?? ''})]\n${text}`);
      continue;
    }

    if (role === 'function') {
      let text = asText(content);
      if (text.length > FUNCTION_RESULT_MAX) {
        text = `${text.slice(0, FUNCTION_RESULT_MAX)}\n... [函数结果已截断，原始长度 ${text.length} 字符]`;
      }
      parts.push(`[Function Result: ${m.name ?? ''}]\n${text}`);
    }
  }

  return parts.join('\n\n');
}

/** 把 content（字符串或数组）压成纯文本。 */
function asText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          if (rec['type'] === 'image_url') return '[Image provided]';
          return String(rec['text'] ?? '');
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

/** 便捷：取工具的参数名列表（供 reparse 提示词等使用）。 */
export { toolParamNames };
