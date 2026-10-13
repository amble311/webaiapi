/**
 * 工具名 / 参数名映射与解析 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * ⚠️ **与原设计不同处（有意的修正）**：
 * Python 版把映射表放在**模块级全局变量**里（`_DYNAMIC_TOOL_NAME_MAP` /
 * `_DYNAMIC_PARAM_NAME_MAP`），由 `format_tools_as_text(tools)` 写入、由
 * `_build_tool_call` 读取。在并发服务里这是**真实的串扰 bug**：两个客户端
 * 同时请求且工具集不同时，后者的映射会覆盖前者，导致工具名/参数名被映射错。
 *
 * TS 版改为**显式的 {@link ToolMaps} 对象**：由 `createToolMaps(tools)` 按请求创建，
 * 沿调用链显式传递。既修掉并发串扰，也让函数变成可测的纯函数。
 */
import { randomUUID } from 'node:crypto';

import { logger } from '../log/logger.js';
import type { ToolCallPayload, ToolDefinition } from '../types/message.js';
import { toolNameOf, toolRequiredParams } from '../types/message.js';
import { cleanDomHtml } from './clean.js';

/** AI 输出工具名 → 标准名的静态别名表。 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  edit_file: 'SearchReplace',
  EditFile: 'SearchReplace',
  edit: 'SearchReplace',
  replace: 'SearchReplace',
  replace_in_file: 'SearchReplace',
  write_file: 'Write',
  WriteFile: 'Write',
  create_file: 'Write',
};

/** 语义别名分组：`write/create` → 写文件工具，等等。 */
export const TOOL_NAME_ALIAS_PATTERNS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['write', ['write', 'create', 'newfile']],
  ['edit', ['edit', 'replace', 'searchreplace', 'strreplace', 'str_replace', 'modify', 'patch']],
  ['read', ['read', 'catfile', 'viewfile']],
];

/** 仅在 IDE 内可用、不应由后端 API 调用的工具。 */
export const TRAE_INTERNAL_TOOLS = new Set([
  'AdvisorTool',
  'get_goal',
  'create_goal',
  'update_goal',
  'OpenPreview',
  'CheckCommandStatus',
  'StopCommand',
  'GetDiagnostics',
]);

/** 文件系统类工具：必须在**客户端**执行（后端只负责把调用回传）。 */
export const FILE_SYSTEM_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'SearchReplace',
  'Grep',
  'Glob',
  'LS',
  'DeleteFile',
  'RunCommand',
  'WebSearch',
  'WebFetch',
  'Skill',
  'Task',
  'SearchCodebase',
]);

/** 用户交互类工具：同样回传客户端执行。 */
export const USER_INTERACTION_TOOLS = new Set(['AskUserQuestion', 'TodoWrite', 'NotifyUser']);

/** 平台自带工具名 —— 出现即说明模型在「对着网页搜索」干活，必须专项告警。 */
export const PLATFORM_BUILTIN_TOOL_NAMES = new Set([
  'search',
  'open',
  'click',
  'find',
  'browse',
  'browser',
  'finish',
]);

/** 一次请求内有效的工具名/参数名映射。 */
export interface ToolMaps {
  /** 标准名（write / edit / read）→ 客户端实际工具名。 */
  name: Record<string, string>;
  /** 工具名 → { 归一化参数名（仅小写字母）→ 客户端原始参数名 }。 */
  param: Record<string, Record<string, string>>;
}

/** 空映射表（等价于 Python 版全局变量未初始化时的行为）。 */
export const EMPTY_TOOL_MAPS: ToolMaps = { name: {}, param: {} };

/** 归一化参数名：只保留字母后小写（`filePath` → `filepath`）。 */
export function normalizeParamKey(name: string): string {
  return name.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

/** 归一化工具名：只保留小写字母数字（`write_to_file` → `writetofile`）。 */
export function normalizeToolName(name: string | null | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 从客户端工具定义中检测写入/编辑/读取工具的实际名称（按参数特征推断）。
 *
 * - 写入工具：有 file_path/path + content，且无 old_str
 * - 编辑工具：有 old_str/oldText 之一 + new_str/newText 之一
 * - 读取工具：有 file_path（**不是** path，`path` 可能是目录）且无 content/old_str
 */
export function detectToolNames(tools: ReadonlyArray<ToolDefinition>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const tool of tools) {
    const name = toolNameOf(tool);
    const props = tool?.function?.parameters?.properties ?? {};
    const paramNamesLower = new Set(Object.keys(props).map((p) => p.toLowerCase()));

    const hasFilePath = paramNamesLower.has('file_path') || paramNamesLower.has('filepath');
    const hasContent = paramNamesLower.has('content');
    const hasOld = ['old_str', 'oldtext', 'old_text', 'search'].some((p) =>
      paramNamesLower.has(p),
    );
    const hasNew = ['new_str', 'newtext', 'new_text', 'replace'].some((p) =>
      paramNamesLower.has(p),
    );

    if (hasFilePath && hasContent && !hasOld) {
      result['write'] ??= name;
    } else if (hasOld && hasNew) {
      result['edit'] ??= name;
    } else if (hasFilePath && !hasContent && !hasOld) {
      result['read'] ??= name;
    }
  }

  return result;
}

/**
 * 按客户端工具定义建立映射表（替代 Python 版写全局变量的做法）。
 */
export function createToolMaps(tools: ReadonlyArray<ToolDefinition>): ToolMaps {
  const name = detectToolNames(tools);
  if (Object.keys(name).length > 0) {
    logger.info({ detected: name }, '[tool_calls] 检测到客户端工具名映射');
  }

  const param: Record<string, Record<string, string>> = {};
  for (const tool of tools) {
    const toolName = toolNameOf(tool);
    const props = tool?.function?.parameters?.properties;
    if (!toolName || !props || typeof props !== 'object') continue;

    const paramMap: Record<string, string> = {};
    for (const paramName of Object.keys(props)) {
      paramMap[normalizeParamKey(paramName)] = paramName;
    }
    param[toolName] = paramMap;
  }

  return { name, param };
}

/**
 * 把 AI 输出的工具名解析为客户端真实工具名；无法解析时返回空字符串。
 *
 * 依次尝试：完全相同 → 归一化后相同 → 语义别名。
 *
 * ⚠️ **近似名必须映射后保留，绝不能直接丢弃** —— 丢弃会让工具调用凭空消失，
 * 客户端收到一段纯文本后就停住了（实测 AI 输出 `write_file`、
 * 客户端只有 `write_to_file`，整条调用被丢弃）。
 */
export function resolveToolName(
  name: string | null | undefined,
  allowed: ReadonlyArray<string>,
  maps: ToolMaps = EMPTY_TOOL_MAPS,
): string {
  if (!name || allowed.length === 0) return '';
  if (allowed.includes(name)) return name;

  const normMap = new Map<string, string>();
  for (const a of allowed) normMap.set(normalizeToolName(a), a);

  const norm = normalizeToolName(name);
  const exact = normMap.get(norm);
  if (exact) return exact;

  const low = name.toLowerCase();
  for (const [kind, keys] of TOOL_NAME_ALIAS_PATTERNS) {
    if (!keys.some((k) => low.includes(k))) continue;

    const real = maps.name[kind];
    if (real && allowed.includes(real)) return real;

    // 兜底：在客户端工具里找归一化名含该语义的
    for (const a of allowed) {
      if (normalizeToolName(a).includes(kind)) return a;
    }
  }

  return '';
}

/** 生成 `call_` 前缀的工具调用 id（对应 Python `uuid4().hex[:24]`）。 */
export function makeToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** 通用别名：把各种写法归一化到标准参数名。 */
const GENERAL_ALIASES: Record<string, string> = {
  filePath: 'file_path',
  filepath: 'file_path',
  filename: 'file_path',
  fileName: 'file_path',
};

/** 需要把 `path` 当作 `file_path` 的工具（`LS` 等用 `path` 表示目录，不映射）。 */
const PATH_TO_FILE_PATH_TOOLS = new Set([
  'Read',
  'SearchReplace',
  'write_file',
  'Write',
  'Edit',
  'DeleteFile',
]);

const SEARCHREPLACE_ALIASES: Record<string, string> = {
  oldText: 'old_str',
  old_text: 'old_str',
  old_string: 'old_str',
  oldString: 'old_str',
  search: 'old_str',
  find: 'old_str',
  pattern: 'old_str',
  match: 'old_str',
  target: 'old_str',
  newText: 'new_str',
  new_text: 'new_str',
  new_string: 'new_str',
  newString: 'new_str',
  replace: 'new_str',
  replacement: 'new_str',
  replaceWith: 'new_str',
  replace_with: 'new_str',
};

const WRITE_FILE_ALIASES: Record<string, string> = {
  fileContent: 'content',
  file_content: 'content',
  text: 'content',
  data: 'content',
};

/**
 * 归一化工具参数名（等价于 `_normalize_tool_arguments`）。
 *
 * 规则：标准名的值优先于别名的值（同一目标 key 冲突时不覆盖）。
 */
export function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || Object.keys(args).length === 0) return args;

  const name = TOOL_NAME_ALIASES[toolName] ?? toolName;
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    let newKey = key;
    let isAlias = false;

    if (key in GENERAL_ALIASES) {
      newKey = GENERAL_ALIASES[key] as string;
      isAlias = true;
    }
    if (key === 'path' && PATH_TO_FILE_PATH_TOOLS.has(name)) {
      newKey = 'file_path';
      isAlias = true;
    }
    if (name === 'SearchReplace' && key in SEARCHREPLACE_ALIASES) {
      newKey = SEARCHREPLACE_ALIASES[key] as string;
      isAlias = true;
    } else if ((name === 'write_file' || name === 'Write') && key in WRITE_FILE_ALIASES) {
      newKey = WRITE_FILE_ALIASES[key] as string;
      isAlias = true;
    }

    if (!(newKey in normalized)) {
      normalized[newKey] = value;
    } else if (!isAlias) {
      // 目标 key 已存在，但当前是标准名 → 标准名的值更可靠，覆盖
      normalized[newKey] = value;
    }
    // 否则：已存在且当前是别名 → 不覆盖（标准名优先）
  }

  return normalized;
}

/** 过滤掉「工具名不在客户端提供列表中」的调用，近似名先映射再保留。 */
export function filterUnknownToolCalls(
  toolCalls: ReadonlyArray<ToolCallPayload> | null | undefined,
  tools: ReadonlyArray<ToolDefinition> | null | undefined,
  maps: ToolMaps = EMPTY_TOOL_MAPS,
): { valid: ToolCallPayload[]; dropped: ToolCallPayload[] } {
  if (!toolCalls || toolCalls.length === 0) return { valid: [], dropped: [] };
  if (!tools || tools.length === 0) {
    // 客户端未提供工具列表 → 无法判断，全部放行
    return { valid: [...toolCalls], dropped: [] };
  }

  const realNames: string[] = [];
  for (const t of tools) {
    const n = toolNameOf(t);
    if (n) realNames.push(n);
  }

  const realNameSet = new Set<string>(realNames);
  /** 兼容 AI 输出标准名（Write/Read/SearchReplace/Edit）的情况。 */
  const COMPAT_STANDARD_NAMES = new Set(['Write', 'Read', 'SearchReplace', 'Edit']);

  const valid: ToolCallPayload[] = [];
  const dropped: ToolCallPayload[] = [];
  const mapped: string[] = [];

  for (const tc of toolCalls) {
    const name = tc.function?.name ?? '';

    // 客户端真实工具名 → 原样保留
    if (realNameSet.has(name)) {
      valid.push(tc);
      continue;
    }

    // ⚠️ 先尝试映射，**再**考虑兼容标准名。
    // Python 版把标准名直接放进 `allowed` 并优先于映射判断，
    // 结果是：模型输出 `SearchReplace`、客户端只有 `replace_in_file` 时，
    // 会原样下发一个客户端并不存在的工具 → IDE 报错。
    // 这里改成「能映射就先映射」，映射不了才用标准名兜底。
    const resolved = resolveToolName(name, realNames, maps);
    if (resolved) {
      valid.push({
        ...tc,
        function: {
          ...tc.function,
          name: resolved,
          arguments: cleanDomHtml(tc.function.arguments),
        },
      });
      mapped.push(`${name}→${resolved}`);
      continue;
    }

    // 映射不了、但属于兼容标准名 → 保留（客户端也许本身就是标准名风格）
    if (COMPAT_STANDARD_NAMES.has(name)) {
      valid.push(tc);
      continue;
    }

    dropped.push(tc);
  }

  if (mapped.length > 0) {
    logger.warn({ mapped }, '[tool_calls] 工具名已映射到客户端真实名称');
  }
  if (dropped.length > 0) {
    const droppedNames = dropped.map((tc) => tc.function?.name ?? '');
    logger.warn(
      { names: droppedNames },
      `[tool_calls] 丢弃 ${dropped.length} 个未知工具名的调用（客户端未提供该工具）`,
    );

    const builtin = droppedNames.filter((n) => PLATFORM_BUILTIN_TOOL_NAMES.has(n.toLowerCase()));
    if (builtin.length > 0) {
      logger.warn(
        { builtin },
        '[tool_calls] 模型调用了平台自带工具（不是客户端工具）——它在用网页端的联网搜索/浏览能力；' +
          '请检查提示词中的「禁止联网搜索」约束',
      );
    }
  }

  return { valid, dropped };
}

/* ==================================================================== */
/* 按参数签名纠正选错的工具                                             */
/* ==================================================================== */

/** 一个工具声明的「参数面」（用于判断一组参数是否落在它的签名里）。 */
interface ParamSurface {
  name: string;
  /** 声明的全部参数名。 */
  props: ReadonlySet<string>;
  /** 声明的必填参数名。 */
  required: ReadonlySet<string>;
}

function paramSurfaceOf(tool: ToolDefinition): ParamSurface | null {
  const name = toolNameOf(tool);
  if (!name) return null;

  const props = Object.keys(tool?.function?.parameters?.properties ?? {});
  // 没声明参数面的工具（或声明成空对象）无法参与判断 —— 跳过，别瞎猜
  if (props.length === 0) return null;

  return {
    name,
    props: new Set(props),
    required: new Set(toolRequiredParams(tool)),
  };
}

/** 解析 `arguments`（OpenAI 形态是 JSON 字符串）；解析失败返回 null。 */
function parseArgs(tc: ToolCallPayload): Record<string, unknown> | null {
  const raw = tc.function?.arguments;
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface SignatureReroute {
  from: string;
  to: string;
  /** 触发改派的多余参数名（诊断用）。 */
  unknownKeys: string[];
}

/**
 * 按「参数签名」纠正选错的工具。
 *
 * ## 解决的真实问题（2026-10-14，xzh 实测）
 * 模型想**创建**文件，却调了 `edit_file` 并套用 `write_file` 的签名
 * （`edit_file(path, content)`）。客户端校验签名直接拒收：
 * `edit_file 收到未知参数 "content"。可用参数："path"、"search"、"replace"`。
 * 模型虽然能在下一轮思考里自我纠正（日志里它自己说
 * "I used the wrong tool — edit_file needs path/search/replace, not content"），
 * 但那一轮已经烧掉了客户端的一次工具往返，用户看到的就是一条报错。
 *
 * ## 规则（**保守**：只在能确定时动手）
 * 对每个调用：
 * 1. 按名字找到声明的工具；它的签名**装得下**全部参数 → 原样保留；
 * 2. 装不下（存在未知参数）→ 在**其余**声明工具里找「能装下全部参数、
 *    且必填参数都被满足」的候选：
 *    - 恰好 **1 个** → 改派给它（`edit_file(path,content)` → `write_file`）；
 *    - 0 个或 ≥2 个 → **原样保留**。0 个说明没有更好的去处；≥2 个说明有歧义，
 *      猜错比让客户端拒绝更糟（可能改写到错误的文件）。
 * 3. 名字本身就不在声明列表里的调用**不碰**（那是 {@link filterUnknownToolCalls} 的职责）。
 *
 * @returns 修好的调用数组 + 改派记录（调用方负责打日志）
 */
export function repairToolCallBySignature(
  toolCalls: ReadonlyArray<ToolCallPayload> | null | undefined,
  tools: ReadonlyArray<ToolDefinition> | null | undefined,
): { repaired: ToolCallPayload[]; reroutes: SignatureReroute[] } {
  if (!toolCalls || toolCalls.length === 0) return { repaired: [], reroutes: [] };
  if (!tools || tools.length === 0) return { repaired: [...toolCalls], reroutes: [] };

  const surfaces: ParamSurface[] = [];
  for (const t of tools) {
    const s = paramSurfaceOf(t);
    if (s) surfaces.push(s);
  }
  // 连参数面都拿不到 → 无法判断，全部放行
  if (surfaces.length === 0) return { repaired: [...toolCalls], reroutes: [] };

  const byName = new Map<string, ParamSurface>();
  for (const s of surfaces) byName.set(s.name, s);

  const repaired: ToolCallPayload[] = [];
  const reroutes: SignatureReroute[] = [];

  for (const tc of toolCalls) {
    const name = tc.function?.name ?? '';
    const declared = byName.get(name);

    // 名字未知，或声明工具没有参数面 → 不归本函数管
    if (!declared) {
      repaired.push(tc);
      continue;
    }

    const args = parseArgs(tc);
    if (!args) {
      repaired.push(tc);
      continue;
    }

    const keys = Object.keys(args);
    const unknownKeys = keys.filter((k) => !declared.props.has(k));

    // 签名装得下 → 不动
    if (unknownKeys.length === 0) {
      repaired.push(tc);
      continue;
    }

    // 找「能装下全部参数、且必填都被满足」的其它工具
    const candidates = surfaces.filter(
      (s) =>
        s.name !== declared.name &&
        keys.every((k) => s.props.has(k)) &&
        [...s.required].every((r) => keys.includes(r)),
    );

    if (candidates.length === 1) {
      const target = candidates[0] as ParamSurface;
      reroutes.push({ from: name, to: target.name, unknownKeys });
      repaired.push({
        ...tc,
        function: { ...tc.function, name: target.name, arguments: JSON.stringify(args) },
      });
      continue;
    }

    // 0 个（没有更好的去处）或 ≥2 个（有歧义）→ 原样交给客户端裁决
    repaired.push(tc);
  }

  return { repaired, reroutes };
}
