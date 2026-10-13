import { describe, expect, it, vi } from 'vitest';

import {
  expandHome,
  getApiKeys,
  getAvailableModelsList,
  getDefaultWorkspacePaths,
  loadSettings,
  parseDotEnv,
  toBool,
  toInt,
} from '../src/config.js';

describe('toBool', () => {
  it('识别常规真值', () => {
    for (const raw of ['true', 'TRUE', '1', 'yes', 'on', ' on ']) {
      expect(toBool(raw, 'DEBUG', false)).toBe(true);
    }
  });

  it('识别常规假值', () => {
    for (const raw of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(toBool(raw, 'DEBUG', false)).toBe(false);
    }
  });

  it('未设置时用默认值', () => {
    expect(toBool(undefined, 'DEBUG', true)).toBe(true);
    expect(toBool(undefined, 'DEBUG', false)).toBe(false);
  });

  it('非布尔字符串回退默认值并告警（Python 版会因此启动失败）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 实测环境里存在 DEBUG=release
      expect(toBool('release', 'DEBUG', false)).toBe(false);
      // 传 true 作默认值时，回退到 true（不猜测语义）
      expect(toBool('release', 'DEBUG', true)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain('DEBUG');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('toInt', () => {
  it('解析整数并回退非法值', () => {
    expect(toInt('8631', 'API_PORT', 1)).toBe(8631);
    expect(toInt(undefined, 'API_PORT', 8631)).toBe(8631);
    expect(toInt('', 'API_PORT', 8631)).toBe(8631);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(toInt('abc', 'API_PORT', 8631)).toBe(8631);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseDotEnv', () => {
  it('解析注释、空行、export、引号与含 = 的值', () => {
    const parsed = parseDotEnv(
      [
        '# 注释',
        '',
        'APP_NAME=AI API Gateway',
        'export API_PORT=8631',
        'QUOTED="a b"',
        "SINGLE='c d'",
        'WITH_EQUALS=a=b=c',
        '  SPACED  =  trimmed  ',
        'INVALID LINE',
        '=novalue',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      APP_NAME: 'AI API Gateway',
      API_PORT: '8631',
      QUOTED: 'a b',
      SINGLE: 'c d',
      WITH_EQUALS: 'a=b=c',
      SPACED: 'trimmed',
    });
  });
});

describe('loadSettings', () => {
  it('无 .env、无环境变量时用默认值（对齐 config.py 的 Field default）', () => {
    const s = loadSettings({ env: {}, dotEnvPath: null });

    expect(s.appName).toBe('webaiapi');
    expect(s.apiPort).toBe(8631);
    expect(s.apiPrefix).toBe('/v1');
    expect(s.requestTimeout).toBe(300);
    expect(s.authDir).toBe('~/.ai-api/auth');
    expect(s.availableModels).toBe('mix');
    expect(s.rateLimitEnabled).toBe(false);
  });

  it('环境变量覆盖 .env', () => {
    const s = loadSettings({
      env: { API_PORT: '9000' },
      dotEnvPath: '/fake/.env',
      readFile: () => 'API_PORT=1111\nLOG_LEVEL=DEBUG\n',
    });

    expect(s.apiPort).toBe(9000);
    expect(s.logLevel).toBe('DEBUG');
  });

  it('.env 缺失时不抛异常', () => {
    const s = loadSettings({
      env: {},
      dotEnvPath: '/definitely/not/here.env',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(s.apiPort).toBe(8631);
  });

  it('真实项目的 .env 里 DEBUG 不是合法布尔值时也能加载', () => {
    const s = loadSettings({
      env: {},
      dotEnvPath: '/fake/.env',
      readFile: () => 'DEBUG=release\nAPI_PORT=8631\n',
    });

    expect(s.debug).toBe(false);
    expect(s.apiPort).toBe(8631);
  });
});

describe('getAvailableModelsList', () => {
  it('按逗号切分并去掉空白', () => {
    const s = loadSettings({ env: {}, dotEnvPath: null });
    expect(getAvailableModelsList({ ...s, availableModels: 'mix' })).toEqual(['mix']);
    expect(getAvailableModelsList({ ...s, availableModels: 'mix, glm-4 ,, chatglm' })).toEqual([
      'mix',
      'glm-4',
      'chatglm',
    ]);
    expect(getAvailableModelsList({ ...s, availableModels: '' })).toEqual([]);
  });
});

describe('getApiKeys', () => {
  it('切成 Set 并去空白', () => {
    const s = loadSettings({ env: {}, dotEnvPath: null });
    expect(getApiKeys({ ...s, apiKeys: 'a, b ,,c' })).toEqual(new Set(['a', 'b', 'c']));
    expect(getApiKeys({ ...s, apiKeys: '' }).size).toBe(0);
  });
});

describe('getDefaultWorkspacePaths', () => {
  it('只保留存在的目录', () => {
    const s = loadSettings({ env: {}, dotEnvPath: null });
    const paths = getDefaultWorkspacePaths(
      { ...s, defaultWorkspacePaths: '/exists, /missing' },
      (p) => p === '/exists',
    );
    expect(paths).toEqual(['/exists']);
  });

  it('未配置时回退当前工作目录', () => {
    const s = loadSettings({ env: {}, dotEnvPath: null });
    expect(getDefaultWorkspacePaths({ ...s, defaultWorkspacePaths: '' }, () => true)).toEqual([
      process.cwd(),
    ]);
  });
});

describe('expandHome', () => {
  it('展开开头的 ~', () => {
    const home = process.env['HOME'];
    if (!home) return;
    expect(expandHome('~/.ai-api/auth')).toBe(`${home}/.ai-api/auth`);
    expect(expandHome('~')).toBe(home);
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });
});
