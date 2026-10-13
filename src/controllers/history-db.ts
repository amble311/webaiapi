/**
 * 历史消息数据库 —— `legacy-python/src/controllers/history_db.py` 的移植（SQLite）。
 *
 * 用途：
 * 1. 切换模型/账号时注入最近 N 条原文，保持对话连续性；
 * 2. 跨平台故障切换时，新平台能拿到上下文继续回答。
 *
 * 表结构（与 Python 完全一致，便于两个版本共用同一个 db 文件）：
 * ```sql
 * messages(
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   conversation_id TEXT NOT NULL,
 *   role TEXT NOT NULL,
 *   content TEXT NOT NULL,
 *   platform TEXT,
 *   account_id TEXT,
 *   model TEXT,
 *   created_at REAL NOT NULL
 * )
 * INDEX idx_conv_time ON messages(conversation_id, created_at)
 * ```
 *
 * ## 与原实现的差异
 * - 用 **Node 内置 `node:sqlite`**（Node 22.5+），不引入 `better-sqlite3`
 *   这类需要本机编译的原生依赖 —— 这对 npm 分发是决定性的
 *   （否则用户 `npm i` 时还要有 C++ 工具链）。
 * - 线程模型：Python 用 `threading.Lock` + 每次开新连接（为绕开 sqlite 的跨线程限制）。
 *   Node 是单线程事件循环，`DatabaseSync` 是同步 API，**不存在跨线程问题**，
 *   因此改为「进程内一个长连接 + 一个 Mutex」保护写序列。
 * - ⚠️ **降级行为**：若运行环境没有 `node:sqlite`（Node < 22.5），
 *   本模块**不会让服务起不来**，而是打印一条明确告警并退化成「无历史」模式。
 *   历史只是增强（丢了它 Provider 会退回去发完整提示词），不该拖垮整个网关。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { settings, expandHome } from '../config.js';
import { logger } from '../log/logger.js';
import { Mutex } from '../utils/mutex.js';

/* ------------------------------------------------------------------ */
/* node:sqlite 的可选加载                                              */
/* ------------------------------------------------------------------ */

/** `node:sqlite` 的最小接口（只声明用到的部分，避免与不同 @types/node 版本耦合）。 */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;

/** 惰性加载 `node:sqlite`（失败只警告一次，并永久记住结果）。 */
function loadSqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule;

  try {
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite') as SqliteModule;
  } catch {
    sqliteModule = null;
    logger.warn(
      '[history] 当前 Node 不支持内置 `node:sqlite`（需要 Node 22.5+），' +
        '历史消息功能已禁用：跨平台/换号时不会注入历史上下文。' +
        '这不影响正常对话（Provider 会发送完整提示词）。',
    );
  }
  return sqliteModule;
}

/* ------------------------------------------------------------------ */
/* 记录类型                                                            */
/* ------------------------------------------------------------------ */

export interface HistoryMessage {
  role: string;
  content: string;
  platform: string | null;
  account_id: string | null;
  model: string | null;
  created_at: number;
}

export interface HistoryStats {
  total_messages: number;
  conversations: number;
  ttl_days: number;
}

export interface AddMessageParams {
  conversationId: string;
  role: string;
  content: string;
  platform?: string | null;
  accountId?: string | null;
  model?: string | null;
}

/** 默认 db 路径：`~/.ai-api/history.db`（与 `authDir` 同级）。 */
export function defaultHistoryDbPath(): string {
  const authDir = expandHome(settings.authDir ?? '~/.ai-api/auth');
  return join(dirname(authDir), 'history.db');
}

export class HistoryDB {
  readonly dbPath: string;

  private db: SqliteDatabase | null = null;

  private readonly lock = new Mutex();

  constructor(
    dbPath?: string,
    private readonly ttlDays = 7,
  ) {
    this.dbPath = dbPath ?? defaultHistoryDbPath();
    this.initDb();
  }

  /** 是否可用（不可用时所有方法都是安全空操作）。 */
  get available(): boolean {
    return this.db !== null;
  }

  /** 打开连接并建表。失败则退化成「无历史」模式。 */
  private initDb(): void {
    const sqlite = loadSqlite();
    if (!sqlite) return;

    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new sqlite.DatabaseSync(this.dbPath);

      try {
        // WAL 模式提升并发读写性能（与原实现一致）
        this.db.exec('PRAGMA journal_mode=WAL');
      } catch {
        // 某些文件系统（网络盘）不支持 WAL，忽略即可
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          platform TEXT,
          account_id TEXT,
          model TEXT,
          created_at REAL NOT NULL
        )
      `);
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_conv_time ON messages(conversation_id, created_at)',
      );

      logger.debug(`✓ 历史数据库已初始化: ${this.dbPath}`);
    } catch (error) {
      logger.error(`历史数据库初始化失败（已降级为无历史模式）: ${String(error)}`);
      this.db = null;
    }
  }

  /** 添加一条消息。 */
  async addMessage(params: AddMessageParams): Promise<void> {
    const { conversationId, role, content, platform, accountId, model } = params;
    if (!this.db || !conversationId || !content) return;

    const release = await this.lock.acquire();
    try {
      this.db
        .prepare(
          `INSERT INTO messages
             (conversation_id, role, content, platform, account_id, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(conversationId, role, content, platform ?? null, accountId ?? null, model ?? null, Date.now() / 1000);
    } catch (error) {
      logger.error(`写入历史消息失败: ${String(error)}`);
    } finally {
      release();
    }
  }

  /**
   * 取最近 N 条消息（**按时间升序**返回，便于直接拼接成上下文）。
   *
   * 实现方式与原实现一致：SQL 用 `ORDER BY created_at DESC LIMIT ?` 取最新的 N 条，
   * 再在内存里反转成「旧 → 新」。
   */
  async getRecentMessages(conversationId: string, limit = 20): Promise<HistoryMessage[]> {
    if (!this.db || !conversationId) return [];

    const release = await this.lock.acquire();
    try {
      const rows = this.db
        .prepare(
          `SELECT role, content, platform, account_id, model, created_at
             FROM messages
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(conversationId, limit) as Array<Record<string, unknown>>;

      // 反转为升序（旧 → 新）
      return rows.reverse().map((row) => ({
        role: String(row['role'] ?? ''),
        content: String(row['content'] ?? ''),
        platform: row['platform'] == null ? null : String(row['platform']),
        account_id: row['account_id'] == null ? null : String(row['account_id']),
        model: row['model'] == null ? null : String(row['model']),
        created_at: Number(row['created_at'] ?? 0),
      }));
    } catch (error) {
      logger.error(`读取历史消息失败: ${String(error)}`);
      return [];
    } finally {
      release();
    }
  }

  /** 该对话最近一条消息所属的平台（用于检测跨平台切换）。 */
  async getLastPlatform(conversationId: string): Promise<string | null> {
    if (!this.db || !conversationId) return null;

    const release = await this.lock.acquire();
    try {
      const row = this.db
        .prepare(
          `SELECT platform FROM messages
            WHERE conversation_id = ? AND platform IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get(conversationId) as Record<string, unknown> | undefined;
      return row?.['platform'] == null ? null : String(row['platform']);
    } catch (error) {
      logger.error(`读取最近平台失败: ${String(error)}`);
      return null;
    } finally {
      release();
    }
  }

  /** 清理超过 TTL 的历史消息，返回删除条数。 */
  async cleanupOld(days?: number): Promise<number> {
    if (!this.db) return 0;

    const ttl = days ?? this.ttlDays;
    const cutoff = Date.now() / 1000 - ttl * 86400;

    const release = await this.lock.acquire();
    try {
      const result = this.db
        .prepare('DELETE FROM messages WHERE created_at < ?')
        .run(cutoff);
      const deleted = Number(result.changes);
      if (deleted > 0) {
        logger.info(`✓ 清理过期历史消息: ${deleted} 条（>${ttl}天）`);
      }
      return deleted;
    } catch (error) {
      logger.error(`清理历史消息失败: ${String(error)}`);
      return 0;
    } finally {
      release();
    }
  }

  /** 数据库统计。 */
  async stats(): Promise<HistoryStats> {
    if (!this.db) {
      return { total_messages: 0, conversations: 0, ttl_days: this.ttlDays };
    }

    const release = await this.lock.acquire();
    try {
      const totalRow = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as
        | Record<string, unknown>
        | undefined;
      const convRow = this.db
        .prepare('SELECT COUNT(DISTINCT conversation_id) AS c FROM messages')
        .get() as Record<string, unknown> | undefined;

      return {
        total_messages: Number(totalRow?.['c'] ?? 0),
        conversations: Number(convRow?.['c'] ?? 0),
        ttl_days: this.ttlDays,
      };
    } catch (error) {
      logger.error(`统计历史数据库失败: ${String(error)}`);
      return { total_messages: 0, conversations: 0, ttl_days: this.ttlDays };
    } finally {
      release();
    }
  }

  /** 关闭连接（优雅退出时调用）。 */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // 忽略
    }
    this.db = null;
  }
}

let historyDb: HistoryDB | null = null;

/** 获取全局历史数据库实例（单例）。 */
export function getHistoryDb(): HistoryDB {
  historyDb ??= new HistoryDB();
  return historyDb;
}

/** 重置单例（测试用）。 */
export function __setHistoryDbForTest(db: HistoryDB | null): void {
  historyDb = db;
}
