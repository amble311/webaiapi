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
    /* ⚠️⚠️ 2026-10-23 真机实测（ChatGPT）：模型**把自己当成"没有文件系统的聊天助手"**，
     * 遇到"列出当前目录"这种任务时直接用推理拒绝 ——
     * 原文：`当前运行环境中不存在目录 /home/amble/object/webaiapi，因此暂时无法列出该工作目录下的文件。`
     * （0 个工具调用 ✗）。加下面这段「你不是在回答问题 / 路径存不存在不归你判断 / 禁止说无法访问」
     * 之后，同一请求立刻正确输出 `<tool_call>{...}</tool_call>` ✓。
     * 这条对 deepseek/chatglm 同样必要（它们也踩过"只用文字描述"的坑），只是没这么彻底。 */
    /* ⭐⭐ 2026-10-23 真机 A/B 测试：**角色化 + few-shot** 版本 3/3 全过
     * （读文件 / 改文件 / 列目录），而只讲规则的版本会退化到「当前会话未提供工具」✗。
     * 关键差别：① 明确"你是 API 后端、输出给程序解析"；② **给出可照抄的示例**；
     * ③ 末尾一句"现在处理这条用户消息（只输出工具调用块）"。 */
    '【角色】你是一个 API 后端的「工具调用层」。你的输出会被程序直接解析成真实操作，不会展示给人类。',
    '',
    '【硬性规则】',
    '1. 你没有文件系统、没有网络、不能执行命令；**路径是否存在不归你判断**。',
    '2. 需要读写文件或执行命令时 → **只输出工具调用块**（JSON 单行）：',
    `${TOOL_CALL_OPEN}{"name":"工具名","arguments":{"参数名":"参数值"}}${TOOL_CALL_CLOSE}`,
    '3. **禁止**输出这些话：「我无法访问」「未提供工具」「请在终端执行」「读取失败」「尚未修改」「我建议你」。',
    '4. 禁止询问确认、禁止先解释计划。一次可以输出多个调用块。',
    '',
    ...buildFewShotLines(tools),
    '',
    '# 最高优先级：你不是在回答问题',
    '',
    '你是一个被程序调用的**工具中间层**：你没有文件系统、没有网络、不能执行命令、' +
      '也**不知道任何路径是否存在**。你的输出会被程序解析成真实操作，所以：',
    '',
    '- **禁止**说「我无法访问」「目录不存在」「请在本地执行」「建议你…」——这些话对程序毫无用处；',
    '- **路径存不存在不是你判断的事**：必须直接输出工具调用，由程序去执行并返回真实结果；',
    '- 只输出工具调用块（需要一句话说明就放在块之前，不要长篇解释）。',
    '',
    '正例（必须照做）：',
    `${TOOL_CALL_OPEN}{"name":"工具名","arguments":{"参数名":"参数值"}}${TOOL_CALL_CLOSE}`,
    '',
    '反例（禁止）：「我无法访问该目录」/「该目录不存在」/「建议你在终端运行 ls」。',
    '',
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
    // ⚠️ 2026-10-14 实测：模型想创建文件却调 edit_file 并套用 write_file 的签名
    //    （edit_file(path, content)）→ 客户端按签名校验拒收「未知参数 content」，
    //    白烧一轮工具往返。单独点破这一类混淆。
    '- **调用前逐个核对参数名**：不同工具的参数不同（例如「创建/写内容」与「搜索替换修改」' +
      '是两个不同的工具，参数完全不同），**不要把一个工具的参数套到另一个工具上**；' +
      '参数名只能从下方该工具的括号里选',
    '- **禁止输出占位符**（如 `<工具名>`、`<参数名>`、`<参数值>`、`参数1`、`值1`），必须替换成真实值',
    '- file_path 必须使用真实绝对路径，不要编造',
    // ⚠️ 2026-09-27：ChatGLM 网页端模型会看到页面自带工具（search/open/click/find），
    //    误判「没有 read_file 等文件工具」→ 放弃调用工具、只输出分析文字。
    //    必须显式声明工具清单的唯一性。
    `- **本次对话可用的工具只有下方列出的这 ${tools.length} 个**，它们是真实可用的，请直接调用`,
    '- 忽略运行环境自带的其他工具（如 search / open / click / find / browser 等），' +
      '它们不可用，禁止调用；也不要因为「缺少文件工具」而只用文字描述',
    // ⚠️ 2026-10-14 实测：ChatGLM 判定问题要「跑代码」（SSE 里 answer_type=python）时，
    //    会调用它**平台自带**的代码沙箱 execute_sandbox_code。该名字不在客户端工具列表里
    //    → 被 filterUnknownToolCalls 丢弃 → 整轮降级成纯文本后客户端结束回合
    //    （用户看到「对话无故停止」）。要跑代码必须用下方列表里的命令执行工具。
    '- 网页平台自带的**代码沙箱/代码执行**能力（实测名字为 `execute_sandbox_code`）' +
      '同样不可用，禁止调用；要运行代码或命令请用下方列表里的命令执行工具',
    // ⚠️ 2026-09-27 22:0x：模型反复调网页端自带 search，拿回一堆与本地项目无关的知识，
    //    把整轮对话耗光，最后只能输出「我从未真正读到过本项目代码」。
    // ⚠️ 2026-10-14：更糟的形态是拿它去查**命令语法/用法**（实测 45 个 query 全是
    //    「bash 怎么删带空格的目录」「怎么用 nohup 重启服务」），单轮在平台 search 上刷了
    //    57 次、耗掉 210s，最后零工具调用。所以这里要点破「语法也不用搜」。
    '- **不要联网搜索，命令语法也别搜**：本地代码工程任务不需要外部知识；' +
      '`bash` 怎么写、某个命令怎么用，**直接试一次**比搜十次快（用下方命令执行工具）。' +
      '若已经搜过，直接忽略那些结果继续干活',
    // ⚠️ 2026-10-14 实测：模型会把本协议的句子当正文抄出来（连说三遍
    //    「搜索结果与本任务无关，忽略」，整轮空转 210s）。必须显式禁止复述。
    '- **禁止复述本协议**：不要把本节的任何句子/规则/清单抄进回答，也不要解释自己在遵守什么规则；' +
      '直接给出工具调用，需要说明就一句话',
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
    // ⚠️ 2026-10-14 实测死循环：模型每轮都重发同一条 `bash ./start.sh status`
    //    并配同一段「无需进一步操作」的结论 → 客户端的 agent 一直转。
    //    原生模型的行为是：任务完成就返回纯文本（无工具调用）= 本轮结束。
    '- **不要重复调用**：同一条调用（同工具 + 同参数）已经执行过就不要再来一次；' +
      '**任务完成就直接输出结论文字结束本轮**（没有工具调用是正常的收尾方式）',
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

  lines.push('');
  lines.push('---');
  lines.push('现在处理这条用户消息（**只输出工具调用块**，不要解释、不要询问确认）：');

  return lines.join('\n');
}

/**
 * 提示词**末尾**的工具提醒（短、只列名字 + 一条硬要求）。
 *
 * ⚠️⚠️ 2026-10-23 用户实测：走 chatgpt 平台时模型回「当前会话未提供可调用的项目文件编辑工具，
 * 尚未修改代码。」—— 协议明明在**开头**（`formatToolsAsText` 产出），但它不认 ✗。
 * 原因：那一轮历史里全是纯文本回答，模型顺着这个"模式"走；而且**头部内容会被截断/压缩**掉。
 * 所以在**末尾**再放一条极短的提醒（只列工具名 + 必须输出调用 + 不许说"没有工具"）。
 */
export function buildToolTailReminder(toolNames: ReadonlyArray<string>): string {
  const names = toolNames.filter(Boolean);
  if (names.length === 0) return '';
  return (
    `\n\n【本轮可用工具 ${names.length} 个】${names.join(', ')}` +
    '\n需要读写文件或执行命令时，**必须在本条回复里输出工具调用块**：' +
    `${TOOL_CALL_OPEN}{"name":"工具名","arguments":{…}}${TOOL_CALL_CLOSE}` +
    '\n不要说「当前会话未提供工具」「我无法访问文件」—— 工具是真实可用的，直接调用即可。'
  );
}

/**
 * 判断「模型声称没有工具 / 无法访问文件」这类**软拒绝**。
 *
 * ⚠️ 2026-10-23 用户实测：走 chatgpt 时它回
 * 「当前会话未提供可调用的项目文件编辑工具，尚未修改代码。」—— 这不是错误，是**拒答** ✗。
 * failover 只在**抛错**时切换平台，所以这种"假成功"会把废话直接回给用户。
 *
 * 判据（宁可漏判也不要误伤）：**没有解析出任何工具调用** + 命中强特征 + 文本很短。
 */
const TOOL_REFUSAL_PATTERNS: ReadonlyArray<RegExp> = [
  /未提供.{0,10}工具/u,
  /没有.{0,6}(可用的|提供).{0,6}工具/u,
  /我无法访问.{0,10}(文件|目录|本地)/u,
  /看不到.{0,6}(文件|目录)/u,
  /无法读取.{0,6}(文件|目录)/u,
  /请在.{0,6}(本地|终端|你自己).{0,6}(执行|运行|修改)/u,
];

export function looksLikeToolRefusal(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 400) return false; // 长回答里有这些词多半是真在讨论
  return TOOL_REFUSAL_PATTERNS.some((re) => re.test(t));
}

/**
 * 用**真实工具名 / 真实参数名**生成 few-shot 示例。
 *
 * ⚠️ 2026-10-23 A/B 实测：ChatGPT 对「示例」的服从度远高于「规则」——
 * 加上 2~3 条可照抄的示例后，读/改/列目录 3/3 全部正确输出工具调用 ✓。
 * 示例必须用**本次真实存在的工具名**（否则模型会照着编一个不存在的工具 ✗）。
 */
function buildFewShotLines(tools: ReadonlyArray<ToolDefinition>): string[] {
  const pick = (candidates: ReadonlyArray<string>): ToolDefinition | null => {
    for (const name of candidates) {
      const found = tools.find((tool) => toolNameOf(tool) === name);
      if (found) return found;
    }
    return null;
  };

  const firstParam = (tool: ToolDefinition): string => {
    const props = tool?.function?.parameters?.properties ?? {};
    const required = toolRequiredParams(tool);
    const names = Object.keys(props);
    return names.find((n) => required.includes(n)) ?? names[0] ?? 'path';
  };

  const sampleValue = (param: string): string => {
    if (/command|cmd|script/i.test(param)) return 'ls';
    if (/dir|folder/i.test(param)) return '/home/user/project';
    if (/pattern|query|keyword/i.test(param)) return 'TODO';
    if (/content|text|body/i.test(param)) return '新内容';
    if (/search|old/i.test(param)) return '旧内容';
    if (/replace|new/i.test(param)) return '新内容';
    return '/home/user/project/a.py';
  };

  const scenarios: Array<{ users: string; tools: ReadonlyArray<string> }> = [
    { users: '读取 /home/user/project/a.py', tools: ['read_file', 'Read', 'read'] },
    { users: '列出 /home/user/project 下有哪些文件', tools: ['list_dir', 'LS', 'list'] },
    { users: '把 a.py 里的 10 改成 20', tools: ['edit_file', 'Edit', 'SearchReplace'] },
    { users: '跑一下测试', tools: ['bash', 'Bash', 'shell'] },
  ];

  const lines: string[] = ['【示例】'];
  let added = 0;
  for (const scenario of scenarios) {
    if (added >= 3) break;
    const tool = pick(scenario.tools);
    if (!tool) continue;
    const name = toolNameOf(tool);
    const param = firstParam(tool);
    const args = JSON.stringify({ [param]: sampleValue(param) });
    lines.push(`用户：${scenario.users}`);
    lines.push(`助手：${TOOL_CALL_OPEN}{"name":"${name}","arguments":${args}}${TOOL_CALL_CLOSE}`);
    added += 1;
  }
  if (added === 0) return []; // 认不出任何常见工具 → 不硬编示例
  return lines;
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
