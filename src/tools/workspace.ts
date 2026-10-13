/**
 * 工作目录与文件路径提取 —— `legacy-python/src/utils/tool_calls.py` 的一部分。
 *
 * ⚠️ 这里是踩坑最密的地方，改动前请读 `docs/hard-constraints.md`「工作目录提取」。
 *
 * 核心结论：方法1（显式声明正则）**必须对所有 role 生效**。
 * CodeBuddy 把 `Workspace Folder: <path>` 放在 **user** 消息的 `<user_info>` 里，
 * 只扫 system 消息会落空 → 回退到 API 进程的 CWD → 工具调用路径全部错误。
 *
 * 与原实现的差异：
 * - Python `re` 的 `\w` 是 Unicode 语义，JS 的 `\w` 只有 ASCII，故统一替换为
 *   `PY_W_CHARS`（`\p{L}\p{N}_`）并使用 `u` 标志。
 * - 「目录是否存在」的检查改为可注入（{@link ExtractWorkspaceOptions.isDir}），
 *   便于单测与跨平台（Python 直接调 `os.path.isdir`）。
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { logger } from '../log/logger.js';
import type { ChatMessage, MessageDict } from '../types/message.js';
import { messageToDict } from '../types/message.js';
import { PY_W_CHARS } from './repair.js';

/** AI 不确定路径时常用的编造前缀（必须排除）。 */
export const FABRICATED_PATH_PREFIXES: ReadonlyArray<string> = [
  '/home/user/',
  '/home/amble/project/',
  '/home/amble/workspace/',
  '/home/project/',
  '/home/workspace/',
  'C:/Users/user/',
];

/**
 * 匹配显式声明的工作目录。
 *
 * 锚点需覆盖各 IDE 注入 `<user_info>` 的格式差异：
 * - Trae / Cursor: `Working directory:` / `Primary working directory:`
 * - CodeBuddy:     `Workspace Folder:`
 * - 通用:          `Project root:` / `Project path:` / `工作目录:`
 */
export const WORKSPACE_PATH_PATTERNS = new RegExp(
  String.raw`(?:working\s*director|primary\s*working\s*director|` +
    String.raw`workspace\s*folder|project\s*root|project\s*path|project\s*folder|` +
    String.raw`workspace|工作目录)` +
    String.raw`[：:]\s*[` +
    '`"\'' +
    String.raw`]*([/${PY_W_CHARS}~.\-]+)`,
  'iu',
);

/** 匹配 `Working directories:` 之后的列表项。 */
const WORKING_DIRS_BLOCK = /Working\s+director(?:y|ies)[：:]\s*\n((?:\s*-\s+[^\n]+\n?)+)/iu;

/** 匹配形如 `- /path/to/dir` 的行。 */
export const PATH_LINE_PATTERN = new RegExp(
  String.raw`^\s*-\s+([/~${PY_W_CHARS}./-]+)\s*$`,
  'gmu',
);

/** 路径提取后带的文件扩展名（工作目录是目录，不是文件）。 */
// ⚠️ 必须写成 `[${PY_W_CHARS}]{n,m}`：直接写 `${PY_W_CHARS}{n,m}` 时量词
// 只作用于最后一个原子（`_`），而不是整个「字母/数字/下划线」集合。
const HAS_EXTENSION = new RegExp(String.raw`\.[a-zA-Z][${PY_W_CHARS}]{0,7}$`, 'u');

/** Java 关键字：被无锚点正则误拼成路径的常见片段。 */
const JAVA_CLASS_KEYWORDS = new Set([
  'class', 'function', 'public', 'private', 'protected',
  'interface', 'extends', 'implements', 'package', 'import',
  'abstract', 'final', 'static', 'void', 'return', 'new',
  'super', 'this', 'true', 'false', 'null',
]);

/** 代码示例路径关键词。 */
const EXAMPLE_KEYWORDS = ['good-example', 'bad-example', 'example', 'demo', 'sample'];

/** 项目根目录的路径深度上限。 */
const MAX_PATH_DEPTH = 5;

/** 路径最短长度（太短不太可能是项目目录）。 */
const MIN_PATH_LEN = 10;

/**
 * API 项目自身目录（用于排除 —— 用户项目不可能在这个目录下）。
 *
 * 从模块位置往上两级：`src/tools/` → 仓库根，`dist/tools/` → 仓库根，两者一致。
 */
export const SELF_PROJECT_DIR: string = fileURLToPath(new URL('../../', import.meta.url)).replace(
  /\/$/,
  '',
);

export interface ExtractWorkspaceOptions {
  /** 「是否是目录」判定；默认读文件系统。 */
  isDir?: (path: string) => boolean;
  /** 要排除的项目自身目录；默认 {@link SELF_PROJECT_DIR}。 */
  selfDir?: string;
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 从消息里提取工作目录 / 项目根路径；找不到返回空字符串。
 *
 * 优先级：user 显式声明(3) > system 显式声明(2) > system 路径推断(1)。
 */
export function extractWorkspacePath(
  messages: ReadonlyArray<ChatMessage | MessageDict>,
  options: ExtractWorkspaceOptions = {},
): string {
  const { isDir = defaultIsDir, selfDir = SELF_PROJECT_DIR } = options;

  let workspacePath = '';
  let systemContent = '';
  let bestPriority = 0;

  for (const raw of messages) {
    const m = messageToDict(raw as ChatMessage);
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content) continue;

    // ── 方法1（任意 role）：匹配显式声明的目录 ──
    const match = WORKSPACE_PATH_PATTERNS.exec(content);
    if (match) {
      const path = (match[1] as string).replace(/\/+$/, '');
      const priority = role === 'user' ? 3 : 2;
      if (isDir(path) && priority > bestPriority) {
        workspacePath = path;
        bestPriority = priority;
        logger.info({ role, path }, '[workspace] 从消息提取工作目录');
      }
    }

    if (role !== 'system') continue;

    systemContent = content;

    // ── 方法2：`Working directories:` 之后的列表 ──
    const wdMatch = WORKING_DIRS_BLOCK.exec(content);
    if (wdMatch) {
      for (const lineMatch of (wdMatch[1] as string).matchAll(
        new RegExp(PATH_LINE_PATTERN.source, 'gmu'),
      )) {
        const path = (lineMatch[1] as string).replace(/\/+$/, '');
        // system 级显式声明优先级 2，**不能覆盖** user 级声明(3)。
        // ⚠️ 与原设计不同处：Python 版写的是 `best_priority < 2`，
        //    一旦第一行把 bestPriority 置成 2，后面更长的候选就永远进不来
        //    （列表里有多个目录时等于只取第一个），与「取最长」的意图不符。
        //    这里改成 `< 3`：既不越过 user 级声明，又能继续在 system 级候选里挑最长的。
        if (isDir(path) && bestPriority < 3 && path.length > workspacePath.length) {
          workspacePath = path;
          bestPriority = 2;
        }
      }
    }

    // ── 方法3：在 system 消息里找非编造的真实目录路径 ──
    if (!workspacePath) {
      // lookbehind 排除 XML/HTML 标签误匹配：
      // 系统提示里的 <maximize_context_understanding> 会被无锚点正则误认成路径，
      // 进而作为错误工作目录注入工具描述，导致 AI 把文件写到不存在的目录。
      const pathPattern = new RegExp(
        String.raw`(?<![\p{L}\p{N}_<])([/~][${PY_W_CHARS}./-]+)`,
        'gu',
      );

      for (const pm of content.matchAll(pathPattern)) {
        const path = (pm[1] as string).replace(/\/+$/, '');

        if (HAS_EXTENSION.test(path)) continue; // 带扩展名 → 是文件不是目录
        if (FABRICATED_PATH_PREFIXES.some((p) => path.startsWith(p))) continue;
        if (path === selfDir || path.startsWith(`${selfDir}/`)) continue;

        const parts = path.split('/');
        const last = parts[parts.length - 1] as string;
        if (parts.length >= 2 && JAVA_CLASS_KEYWORDS.has(last)) continue;
        if (EXAMPLE_KEYWORDS.some((ex) => path.toLowerCase().includes(ex))) continue;
        if (path.length < MIN_PATH_LEN) continue;
        if ((path.match(/\//g) ?? []).length > MAX_PATH_DEPTH) continue;

        // 排除「疑似 JSON 字段名拼接」：所有段都是纯字母且段数 >= 3
        // （真实项目目录几乎都会含下划线/数字/连字符/点之一）
        const nonEmpty = parts.filter(Boolean);
        if (nonEmpty.length >= 3 && nonEmpty.every((p) => /^[A-Za-z]+$/u.test(p))) continue;

        // 注意：不再验证目录是否存在 ——
        // 用户的项目目录在用户机器上，不在 API 服务器上
        if (path.length > workspacePath.length) {
          workspacePath = path;
          bestPriority = Math.max(bestPriority, 1);
        }
      }
    }
  }

  // ── 兜底：从 tool 结果的 file_path 反推目录 ──
  if (!workspacePath) {
    for (const raw of messages) {
      const m = messageToDict(raw as ChatMessage);
      if (m.role !== 'tool') continue;
      const content = typeof m.content === 'string' ? m.content : '';

      for (const pm of content.matchAll(
        new RegExp(String.raw`(?:file_path|path)[：:]\s*([/~][${PY_W_CHARS}./-]+)`, 'gu'),
      )) {
        const path = pm[1] as string;
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        if (isDir(dir) && dir.length > workspacePath.length) workspacePath = dir;
      }
    }
  }

  if (workspacePath) {
    logger.info({ workspacePath }, '[workspace] 成功提取工作目录');
  } else {
    logger.warn('[workspace] 未能从消息中提取工作目录');
    if (systemContent) {
      for (const line of systemContent.split('\n')) {
        if (
          line.includes('/home/') ||
          line.includes('/Users/') ||
          line.includes('Primary') ||
          line.includes('Working')
        ) {
          logger.warn({ line: line.trim() }, '[workspace] 系统消息路径行');
        }
      }
    }
  }

  return workspacePath;
}

/**
 * 从消息历史里提取出现过的真实文件路径。
 *
 * ⚠️ **只从 tool 结果里提取**，不从 AI 的 `tool_calls` 里提取 ——
 * 后者可能是模型编造的。
 */
export function extractFilePathsFromMessages(
  messages: ReadonlyArray<ChatMessage | MessageDict>,
): string[] {
  const paths = new Set<string>();

  for (const raw of messages) {
    const m = messageToDict(raw as ChatMessage);
    if (m.role !== 'tool') continue;
    const content = typeof m.content === 'string' ? m.content : '';

    // 模式1: `file_path: /path/to/file` 或 `path: /path/to/file`
    for (const pm of content.matchAll(
      new RegExp(
        String.raw`(?:file_path|path)[：:]\s*["']*([/~][${PY_W_CHARS}./-]+\.[${PY_W_CHARS}]{1,10})`,
        'gu',
      ),
    )) {
      const p = pm[1] as string;
      if (!p.startsWith('http') && p.length < 300) paths.add(p);
    }

    // 模式2: 路径出现在文件内容开头（如 Read 工具返回 `# /path/to/file`）
    for (const pm of content.matchAll(
      new RegExp(
        String.raw`^#\s*([/~][${PY_W_CHARS}./-]+\.[${PY_W_CHARS}]{1,10})\s*$`,
        'gmu',
      ),
    )) {
      const p = pm[1] as string;
      if (!p.startsWith('http') && p.length < 300) paths.add(p);
    }
  }

  return [...paths].sort();
}
