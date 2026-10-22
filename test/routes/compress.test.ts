/**
 * 压缩总预算（2026-10-21 实测事故）。
 *
 * 316,779 字符提示词 → 6 块历史**串行**压缩，每块 30~40s → 压缩吃掉 **198s**
 * （整个 HTTP 请求只有 300s）→ 轮到主模型只剩 73s → ChatGPT 冷启动（水合 30~90s）
 * 直接超时 ✗（用户看到「平台 'chatgpt' 不可用: 请求超过截止时间（deadline）」）。
 *
 * 现在压缩有自己的总预算（默认 90s）：超出的分块改用「原文截断」兜底（`allOk=false`，
 * 不写进摘要缓存）—— 宁可摘要糙一点，也不能把整个请求饿死。
 */
import { describe, expect, it } from 'vitest';

import { COMPRESS_TOTAL_BUDGET_MS, compressionDeadline } from '../../src/routes/compress.js';

describe('compressionDeadline', () => {
  it('⭐ 压缩预算收敛到 90s（不把整个请求预算吃光）', () => {
    const now = 1_000_000;
    expect(compressionDeadline(undefined, now)).toBe(now + COMPRESS_TOTAL_BUDGET_MS);
    expect(COMPRESS_TOTAL_BUDGET_MS).toBeLessThanOrEqual(120_000);
  });

  it('⭐ 请求截止时间更近时取更早的那个（绝不越过请求 deadline）', () => {
    const now = 1_000_000;
    expect(compressionDeadline(now + 30_000, now)).toBe(now + 30_000);
  });

  it('请求预算很宽裕时，仍然只给压缩 90s', () => {
    const now = 1_000_000;
    expect(compressionDeadline(now + 280_000, now)).toBe(now + COMPRESS_TOTAL_BUDGET_MS);
  });
});
