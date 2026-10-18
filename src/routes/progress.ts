/**
 * 「进展 / 重复」判断 —— 用来**替代**粗暴的「24 轮硬上限」。
 *
 * ## 为什么换掉 24 轮（2026-10-18 用户提出）
 * 硬上限一视同仁卡轮数：**庞大项目的正常探索**（读 40 个文件、每轮都是新目标）也会被砍 ✗；
 * 而真正该拦的是「**原地重复读取**」。所以判据从「轮数」改成「**有没有进展**」：
 *
 * - **有进展**：本轮出现**新目标**（新文件/新目录/新 pattern）或出现**写/改/执行**类调用；
 * - **重复**：同一「工具名 + 归一化参数」已执行过（参数级），或同一目标被读太多次且**未改动**
 *   （目标级 —— 模型换个 limit/offset 重读同一文件也算重复）；
 * - **僵局**：连续 N 轮**全部**是重复 → 只有这时才截停。
 *
 * ⚠️ 两条必须的例外：
 * 1. **写过的目标允许重读**（改完要验证）—— 目标级计数要看 `writtenTargets`；
 * 2. **写操作永远不抑制**（只有完全相同且重复的写才拦，防止反复下发同一修改）。
 */
import { isReadOnlyTool } from './helpers.js';

/** 参数级重复：同一指纹出现 ≥ 1 次（= 这是第 2 次）就抑制。 */
export const REPEAT_FINGERPRINT_LIMIT = 1;

/** 目标级重复：同一目标被读 ≥ 3 次（且未改动）就抑制。 */
export const REPEAT_TARGET_READ_LIMIT = 3;

/** 能从参数里取出「目标」的键（按优先级）。 */
const TARGET_KEYS = [
  'filePath',
  'file_path',
  'path',
  'target_directory',
  'targetDirectory',
  'dir',
  'pattern',
  'glob',
  'query',
] as const;

/** 工具调用的最小形状（兼容 `ToolCallPayload` 与历史消息里的 `tool_calls` 项）。 */
export interface CallLike {
  function?: { name?: string; arguments?: unknown };
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __raw: text };
  }
}

/**
 * 稳定 JSON：**键排序**后再序列化。
 *
 * ⚠️ `JSON.parse` + `JSON.stringify` **不会**排序键 —— 同一调用换个键顺序就成了「新调用」，
 * 重复抑制会失效（实测模型会这么绕过）。
 */
export function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

/** 调用指纹：`工具名|稳定 JSON 参数`。 */
export function callFingerprint(call: CallLike): string {
  const name = String(call?.function?.name ?? '');
  return `${name}|${stableJson(parseArgs(call?.function?.arguments))}`;
}

/** 调用的「目标」（文件/目录/pattern）；取不到返回 `null`。 */
export function callTarget(call: CallLike): string | null {
  const args = parseArgs(call?.function?.arguments);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const rec = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 本轮是否含写/改/执行类调用（只看工具名，不知道的就当写，保守）。 */
export function hasWriteCall(calls: ReadonlyArray<CallLike>): boolean {
  return calls.some((call) => !isReadOnlyTool(String(call?.function?.name ?? '')));
}

/** 本次请求的历史统计（从最后一条 user 消息往后算）。 */
export interface RequestHistory {
  /** 指纹 → 已出现次数。 */
  fingerprints: Map<string, number>;
  /** 目标 → 被读次数。 */
  targetReads: Map<string, number>;
  /** 本次请求里被写过的目标。 */
  writtenTargets: Set<string>;
  /** 已发生的工具轮数（= 带 tool_calls 的 assistant 消息数）。 */
  rounds: number;
  /** 结尾连续「无进展」的轮数。 */
  stallStreak: number;
}

/** 空的统计（第一轮用）。 */
export function emptyHistory(): RequestHistory {
  return {
    fingerprints: new Map(),
    targetReads: new Map(),
    writtenTargets: new Set(),
    rounds: 0,
    stallStreak: 0,
  };
}

/**
 * 分析「最后一条 user 消息之后」的历史。
 *
 * @param messages 完整消息数组
 * @param fromIdx  最后一条 user 消息的下标（之后的消息才算「本轮任务」）
 */
export function analyzeRequest(
  messages: ReadonlyArray<{ role?: string; tool_calls?: unknown }>,
  fromIdx: number,
): RequestHistory {
  const history = emptyHistory();
  let stall = 0;

  for (let i = Math.max(0, fromIdx + 1); i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as CallLike[]) : [];
    if (calls.length === 0) continue;

    history.rounds += 1;

    /* 这一轮是否「无进展」：所有调用都是之前见过的指纹，且没有任何写操作。 */
    let noProgress = true;
    for (const call of calls) {
      const fp = callFingerprint(call);
      const seen = history.fingerprints.get(fp) ?? 0;
      if (seen === 0) noProgress = false;
    }
    if (hasWriteCall(calls)) noProgress = false;
    stall = noProgress ? stall + 1 : 0;

    // 该轮发生之后才计入统计（供下一轮判断重复）
    for (const call of calls) {
      const fp = callFingerprint(call);
      history.fingerprints.set(fp, (history.fingerprints.get(fp) ?? 0) + 1);

      const target = callTarget(call);
      const readOnly = isReadOnlyTool(String(call?.function?.name ?? ''));
      if (target && readOnly) {
        history.targetReads.set(target, (history.targetReads.get(target) ?? 0) + 1);
      }
      if (target && !readOnly) history.writtenTargets.add(target);
    }
  }

  history.stallStreak = stall;
  return history;
}

/** 被抑制的调用（含原因，直接写进正文告诉模型）。 */
export interface SuppressedCall {
  name: string;
  argsPreview: string;
  reason: string;
}

/** 一轮调用的评估结果。 */
export interface RoundAssessment {
  keep: CallLike[];
  suppressed: SuppressedCall[];
  /** 保留下来的调用里是否有进展（新目标 / 写操作）。 */
  isProgress: boolean;
}

/**
 * 评估**本轮**调用：哪些能下发、哪些是重复、是否算进展。
 *
 * ⚠️ 判定顺序：参数级（完全相同）→ 目标级（同一目标读太多次且未改动）。
 * 写操作只在「完全相同」时被抑制（改完之后再改一次同样的内容没有意义）。
 */
export function assessCalls(
  calls: ReadonlyArray<CallLike>,
  history: RequestHistory,
): RoundAssessment {
  const keep: CallLike[] = [];
  const suppressed: SuppressedCall[] = [];
  let isProgress = false;

  for (const call of calls) {
    const name = String(call?.function?.name ?? '');
    const target = callTarget(call);
    const readOnly = isReadOnlyTool(name);
    const fp = callFingerprint(call);
    const argsPreview = String(call?.function?.arguments ?? '').slice(0, 120);

    // ① 参数级：这个调用已经执行过
    if ((history.fingerprints.get(fp) ?? 0) >= REPEAT_FINGERPRINT_LIMIT) {
      suppressed.push({ name, argsPreview, reason: '同一调用已执行过（结果在上下文里）' });
      continue;
    }

    // ② 目标级：同一目标读太多次，且期间没被改过
    if (
      readOnly &&
      target &&
      !history.writtenTargets.has(target) &&
      (history.targetReads.get(target) ?? 0) >= REPEAT_TARGET_READ_LIMIT
    ) {
      suppressed.push({
        name,
        argsPreview,
        reason: `目标 ${target} 已读过 ${REPEAT_TARGET_READ_LIMIT} 次且未变动（换个目标，或先改它）`,
      });
      continue;
    }

    keep.push(call);

    // 进展判断：写操作，或读到「新目标」
    if (!readOnly) isProgress = true;
    else if (target && (history.targetReads.get(target) ?? 0) === 0) isProgress = true;
  }

  return { keep, suppressed, isProgress };
}
