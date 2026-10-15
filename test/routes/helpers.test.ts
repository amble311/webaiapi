/**
 * 转换轮 / 续跑轮的**材料准备**（2026-10-14 实测事故）。
 *
 * 事故链：主轮被网页平台自带的 `open`/`search` 劫持（单轮调 `open` 52 次）→
 * 回答里全是「浏览器工具已确认不可用」「open 工具已达到上限，应该停止调用」这类自我纠结 →
 * 转换轮（reparse）拿到这份材料后，**同一个 ChatGLM** 跟着又去调平台工具，白烧 90s，0 工具调用。
 * 另外转换轮的「用户原始请求」被取成了最后一条消息 = **tool 结果**
 * （`已写入 /home/amble/object/btc/README.md（1231 字符）`）。
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_RESPONSE_NOTICE,
  formatRecentProgress,
  looksUnfinishedAnswer,
  stripPlatformToolNoise,
} from '../../src/routes/helpers.js';
import type { ChatMessage } from '../../src/types/message.js';

describe('stripPlatformToolNoise', () => {
  it('⭐ 真实案例：剔掉平台工具议论，保留模型真正想做的事', () => {
    const material = [
      '浏览器工具已确认不可用。以下按会话协议发起本地工具调用（三个并行读取）：',
      '搜索结果与当前本地任务无关，忽略。继续本地清理与状态收尾：',
      '已严格遵守系统指令，停止 search 调用。现在直接用 bash 完成本地任务：',
      '清理验证状态。清理误写入的文件与怪目录，然后启动服务验证状态。',
      '浏览器工具不可用，本任务是纯本地工程任务。立即用 bash 推进：',
      '1. 删除误创建的 README.md',
      '2. 用 rm -rf 清理怪目录',
      '3. 启动 API 后端',
      '系统提醒 open 工具已达到上限，应该停止调用 open。让我改用 bash 工具。',
    ].join('\n');

    const cleaned = stripPlatformToolNoise(material);

    expect(cleaned).not.toContain('浏览器工具');
    expect(cleaned).not.toContain('open 工具');
    expect(cleaned).not.toContain('停止 search 调用');
    expect(cleaned).not.toContain('搜索结果与本任务无关');
    // 实质内容全部保留
    expect(cleaned).toContain('清理验证状态。清理误写入的文件与怪目录，然后启动服务验证状态。');
    expect(cleaned).toContain('1. 删除误创建的 README.md');
    expect(cleaned).toContain('2. 用 rm -rf 清理怪目录');
    expect(cleaned).toContain('3. 启动 API 后端');
  });

  it('⚠️ 只丢「句子」不丢整行：同一行里既有议论又有真命令', () => {
    const cleaned = stripPlatformToolNoise(
      '浏览器工具不可用；用 bash 删除 /home/amble/object/btc/README.md',
    );
    expect(cleaned).not.toContain('浏览器工具');
    expect(cleaned).toContain('用 bash 删除 /home/amble/object/btc/README.md');
  });

  it('不含噪音时原样返回（只折叠多余空行）', () => {
    expect(stripPlatformToolNoise('读取 config.py\n\n\n\n写入 done')).toBe(
      '读取 config.py\n\n写入 done',
    );
  });

  it('全是噪音 → 空串（调用方会因此跳过转换轮）', () => {
    expect(
      stripPlatformToolNoise('浏览器工具不可用，本任务是纯本地工程任务。立即用 bash 推进：'),
    ).toBe('');
    expect(stripPlatformToolNoise('')).toBe('');
  });
});

describe('formatRecentProgress', () => {
  const messages = [
    { role: 'system', content: '你是玄猪…' },
    { role: 'user', content: '把服务重启一下' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"/a"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: '已读取 /a（42 行）' },
    {
      role: 'assistant',
      content: '正在执行 1 个操作：write_file',
      tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"/b"}' } }],
    },
    { role: 'tool', tool_call_id: 'c2', content: '已写入 /home/amble/object/btc/README.md（1231 字符）' },
  ] as unknown as ChatMessage[];

  it('⭐ 抽取对话尾部的工具调用与结果（转换轮据此知道做到哪了）', () => {
    const progress = formatRecentProgress(messages);

    expect(progress).toContain('用户: 把服务重启一下');
    expect(progress).toContain('AI 调用工具: read_file');
    expect(progress).toContain('工具结果: 已读取 /a（42 行）');
    expect(progress).toContain('AI 调用工具: write_file（旁白: 正在执行 1 个操作：write_file）');
    expect(progress).toContain('工具结果: 已写入 /home/amble/object/btc/README.md（1231 字符）');
    // 早于窗口的 system 消息不进材料
    expect(progress).not.toContain('你是玄猪');
  });

  it('按时间顺序排列（最近的在最后）', () => {
    const progress = formatRecentProgress(messages);
    expect(progress.indexOf('用户: 把服务重启一下')).toBeLessThan(
      progress.indexOf('AI 调用工具: read_file'),
    );
    expect(progress.indexOf('AI 调用工具: read_file')).toBeLessThan(
      progress.indexOf('AI 调用工具: write_file'),
    );
  });

  it('超过预算时只保留最近的部分', () => {
    const long = [
      { role: 'user', content: 'a'.repeat(900) },
      { role: 'tool', content: `最近的结果 ${'b'.repeat(900)}` },
    ] as unknown as ChatMessage[];

    const progress = formatRecentProgress(long, { maxTotalChars: 500 });
    expect(progress.length).toBeLessThanOrEqual(500);
    expect(progress).toContain('最近的结果');
  });

  it('空消息列表不崩', () => {
    expect(formatRecentProgress([])).toBe('');
  });
});

/**
 * 「只说计划、没有动手」的判定（`looksUnfinishedAnswer`）。
 *
 * ⚠️ 2026-10-16 实测（玄猪截图）：回答「**我先查看**项目目录结构，识别出可能的历史脚本和
 * 无用文件。」之后**一个工具调用都没有**就结束了 —— 这句不含旧的标记词，于是恢复轮不触发、
 * 客户端拿到纯文本就结束回合。补了「宣布动作」句式后它必须命中。
 */
describe('looksUnfinishedAnswer', () => {
  it('⭐ 真实案例：「宣布了动作」也算未完成', () => {
    expect(
      looksUnfinishedAnswer('我先查看项目目录结构，识别出可能的历史脚本和无用文件。'),
    ).toBe(true);
    expect(looksUnfinishedAnswer('接下来我会把这三个文件改掉。')).toBe(true); // 旧标记词
    expect(looksUnfinishedAnswer('先检查一下依赖版本。')).toBe(true);
    expect(looksUnfinishedAnswer('我打算运行测试确认。')).toBe(true);
    expect(looksUnfinishedAnswer('我来梳理一下调用链。')).toBe(true);
  });

  it('⚠️ 回顾式陈述 / 已完成的总结**不能**误判（否则每轮多烧 80~100s）', () => {
    expect(looksUnfinishedAnswer('我查看了文件，结论是配置项写错了。')).toBe(false);
    expect(looksUnfinishedAnswer('我删除了 3 个无用脚本，并已运行测试验证。')).toBe(false);
    expect(looksUnfinishedAnswer('无需进一步操作，任务已完成。')).toBe(false);
    expect(looksUnfinishedAnswer('API 后端运行正常，TUI 未启动，没有新增信息需要处理。')).toBe(
      false,
    );
    expect(looksUnfinishedAnswer('下面是本次清理的结果汇总。')).toBe(false);
  });

  it('旧标记词仍然有效（不回归）', () => {
    expect(looksUnfinishedAnswer('仍有三处关键文件内容未知，需先补读。')).toBe(true);
    expect(looksUnfinishedAnswer('工具轮数已达上限（8/8），尚未修改任何文件。')).toBe(true);
    expect(looksUnfinishedAnswer('')).toBe(false);
  });

  it('⚠️ 正则不能带 g 标志（否则同一输入第二次判 false）', () => {
    const text = '我先查看项目目录结构。';
    expect(looksUnfinishedAnswer(text)).toBe(true);
    expect(looksUnfinishedAnswer(text)).toBe(true);
    expect(looksUnfinishedAnswer(text)).toBe(true);
  });
});

/**
 * 「空响应」文案（2026-10-16）：必须**如实**（平台只出思考），不能把用户引向
 * 「请求太大」这种错误方向。
 */
describe('EMPTY_RESPONSE_NOTICE', () => {
  it('如实说明「只输出了思考」，且不再提「把请求拆小」', () => {
    expect(EMPTY_RESPONSE_NOTICE).toContain('只输出了思考');
    expect(EMPTY_RESPONSE_NOTICE).not.toContain('把请求拆小');
    expect(EMPTY_RESPONSE_NOTICE).not.toContain('模型没有生成正文');
    // 没有内部前缀（与原生模型的 content 对齐）
    expect(EMPTY_RESPONSE_NOTICE.startsWith('[')).toBe(false);
  });
});
