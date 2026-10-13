import { describe, expect, it } from 'vitest';

import { extractFilePathsFromMessages, extractWorkspacePath } from '../../src/tools/workspace.js';
import type { ChatMessage } from '../../src/types/message.js';

/** 造一个「所有路径都存在」的 isDir，避免测试依赖真实文件系统。 */
const allExist = () => true;

describe('extractWorkspacePath — 显式声明（方法1）', () => {
  it('⭐ CodeBuddy 把 Workspace Folder 放在 user 消息的 <user_info> 里也要能提取', () => {
    // 这是文档里记录的坑：只扫 system 消息会落空 → 回退 API 进程 CWD → 工具路径全错
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '<user_info>\nWorkspace Folder: /home/amble/object/webapi\n</user_info>\n请修复 bug',
      },
    ];
    expect(extractWorkspacePath(messages, { isDir: allExist })).toBe('/home/amble/object/webapi');
  });

  it('Trae 风格的 Working directory / Project root 也能提取', () => {
    expect(
      extractWorkspacePath([{ role: 'system', content: 'Working directory: /srv/app_data' }], {
        isDir: allExist,
      }),
    ).toBe('/srv/app_data');

    expect(
      extractWorkspacePath([{ role: 'system', content: 'Project root: /opt/my_service' }], {
        isDir: allExist,
      }),
    ).toBe('/opt/my_service');
  });

  it('中文锚点「工作目录:」支持', () => {
    expect(
      extractWorkspacePath([{ role: 'system', content: '工作目录：/opt/my_service' }], {
        isDir: allExist,
      }),
    ).toBe('/opt/my_service');
  });

  it('去掉路径尾部多余的 /', () => {
    expect(
      extractWorkspacePath([{ role: 'system', content: 'Project path: /opt/my_service/}' }], {
        isDir: allExist,
      }),
    ).toBe('/opt/my_service');
  });

  it('方法1/2 要求目录存在（用带扩展名的路径隔离方法3，避免它把候选捡回来）', () => {
    expect(
      extractWorkspacePath([{ role: 'system', content: 'Working directory: /no/such.py' }], {
        isDir: () => false,
      }),
    ).toBe('');
  });

  it('⚠️ 方法3 刻意不校验目录是否存在（目录在用户机器上，不在 API 服务器上）', () => {
    expect(
      extractWorkspacePath([{ role: 'system', content: '参见 /no/such_dir' }], {
        isDir: () => false,
      }),
    ).toBe('/no/such_dir');
  });

  it('⭐ user 显式声明的优先级高于 system（不受消息顺序影响）', () => {
    const userFirst: ChatMessage[] = [
      { role: 'user', content: 'Workspace Folder: /user/proj_a' },
      { role: 'system', content: 'Working directory: /sys/proj_b' },
    ];
    const systemFirst: ChatMessage[] = [
      { role: 'system', content: 'Working directory: /sys/proj_b' },
      { role: 'user', content: 'Workspace Folder: /user/proj_a' },
    ];
    expect(extractWorkspacePath(userFirst, { isDir: allExist })).toBe('/user/proj_a');
    expect(extractWorkspacePath(systemFirst, { isDir: allExist })).toBe('/user/proj_a');
  });
});

describe('extractWorkspacePath — Working directories 列表（方法2）', () => {
  it('匹配列表项并取最长的', () => {
    const content = [
      'Working directories:',
      '- /opt/my_service',
      '- /opt/my_service/packages/api_1',
    ].join('\n');

    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe(
      '/opt/my_service/packages/api_1',
    );
  });

  it('user 级声明(3) 不会被 system 列表(2) 覆盖', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Working directories:\n- /opt/my_service/packages/api_1' },
      { role: 'user', content: 'Workspace Folder: /user/proj_a' },
    ];
    expect(extractWorkspacePath(messages, { isDir: allExist })).toBe('/user/proj_a');
  });
});

describe('extractWorkspacePath — 路径推断（方法3）', () => {
  it('无锚点时从 system 消息里找最长的合理目录', () => {
    const content = '本项目位于 /opt/my_service，请阅读其中文件。';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe(
      '/opt/my_service',
    );
  });

  it('⭐ 排除 XML 标签被误识别成路径（lookbehind 防的就是这个）', () => {
    // <maximize_context_understanding> 会被无锚点正则当成 /maximize_context_understanding，
    // 进而作为错误工作目录注入 → AI 把文件写到不存在的目录
    const content =
      '<maximize_context_understanding>\n请最大化理解\n</maximize_context_understanding>\n/opt/my_service';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe(
      '/opt/my_service',
    );
  });

  it('排除带文件扩展名的路径（那是文件不是目录）', () => {
    const content = '/opt/config/app.json';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe('');
  });

  it('排除编造路径前缀（/home/user/ 等）', () => {
    const content = '/home/user/my_service';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe('');
  });

  it('排除过深的路径（>5 层）', () => {
    const content = '/1/2/3/4/5/6/7';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe('');
  });

  it('排除过短的路径（<10 字符）', () => {
    const content = '/a/b_1';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe('');
  });

  it('排除「纯字母段数 >= 3」的疑似 schema 字段名拼接', () => {
    // 如 /cwds/status/validFrom —— 真实项目目录几乎都含下划线/数字/连字符/点
    const content = '/cwds/status/validFrom';
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist })).toBe('');
  });

  it('排除项目自身目录', () => {
    const self = '/opt/self_project';
    const content = `参见 ${self}/src/a_1`;
    expect(extractWorkspacePath([{ role: 'system', content }], { isDir: allExist, selfDir: self })).toBe(
      '',
    );
  });

  it('方法3 推断出的路径不覆盖已有的显式声明', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Working directory: /opt/my_service' },
      { role: 'system', content: '顺便看下 /var/log_data_dir' },
    ];
    expect(extractWorkspacePath(messages, { isDir: allExist })).toBe('/opt/my_service');
  });
});

describe('extractWorkspacePath — 兜底与边界', () => {
  it('从 tool 结果的 file_path 反推目录', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '看看文件' },
      { role: 'tool', content: 'file_path: /opt/my_service/src/main.ts' },
    ];
    expect(extractWorkspacePath(messages, { isDir: allExist })).toBe('/opt/my_service/src');
  });

  it('完全没有线索时返回空字符串', () => {
    expect(extractWorkspacePath([{ role: 'user', content: '你好' }], { isDir: allExist })).toBe('');
  });

  it('空消息列表返回空字符串', () => {
    expect(extractWorkspacePath([], { isDir: allExist })).toBe('');
  });

  it('多模态 user 消息（数组 content）不报错', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(extractWorkspacePath(messages, { isDir: allExist })).toBe('');
  });
});

describe('extractFilePathsFromMessages', () => {
  it('只从 tool 结果里提取（AI 的 tool_calls 可能编造）', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '我打算写 /fake/made_up.ts' },
      { role: 'tool', content: 'file_path: /real/path/file_1.ts' },
    ];
    const paths = extractFilePathsFromMessages(messages);
    expect(paths).toContain('/real/path/file_1.ts');
    expect(paths).not.toContain('/fake/made_up.ts');
  });

  it('提取 `# /path` 形式的文件头', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', content: '# /real/path/file_1.ts\nconst a = 1;' },
    ];
    expect(extractFilePathsFromMessages(messages)).toContain('/real/path/file_1.ts');
  });

  it('排除 URL 与超长路径，并去重排序', () => {
    const long = `/real/${'a'.repeat(400)}.ts`;
    const messages: ChatMessage[] = [
      { role: 'tool', content: `file_path: https://x.com/a_1.ts\nfile_path: /b/b_1.ts\nfile_path: /b/b_1.ts\nfile_path: ${long}` },
    ];
    const paths = extractFilePathsFromMessages(messages);
    expect(paths).toEqual(['/b/b_1.ts']);
  });

  it('无 tool 消息时返回空数组', () => {
    expect(extractFilePathsFromMessages([{ role: 'user', content: 'hi' }])).toEqual([]);
  });
});
