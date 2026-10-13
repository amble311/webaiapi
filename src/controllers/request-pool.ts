/**
 * 请求池 —— `legacy-python/src/controllers/request_pool.py` 的移植。
 *
 * 用途：给**非流式**请求做一次「入池 → 完成/失败」的记账，
 * 并把汇总状态暴露在 `/v1/status` 上（`total_requests` / `queue_size` /
 * `status_counts`）。
 *
 * ## 有意不移植的部分（Python 里定义但从未被调用）
 * - `RequestPool.get_next_request()` / `get_pending_request()` / `mark_processing()` /
 *   `get_request()`：全仓库零调用。请求的「排队-取出」流程从来没跑过 ——
 *   实际调度是 `_streamWithFailover()` 直接串行调用 Provider，池只做了记账。
 * - `IntelligentScheduler.select_best_instance()`：零调用，而且它依赖的
 *   `instance_loads` / `account_loads` 也**从来没有被增加过**
 *   （`increment_load` / `decrement_load` 零调用），返回的永远是空字典。
 *   这里保留 `getLoadStatus()`（`/v1/status` 需要这个字段形状）与
 *   increment/decrement（成本极低、语义完整），只删掉那个永远选不出东西的选择器。
 *
 * ## 与原实现的差异
 * - `asyncio.Queue(maxsize=N)` → {@link BoundedQueue}：`asyncio.Queue` 在满时
 *   `await put()` 会**阻塞**；这里保留同样语义（满时等待），因为
 *   `addRequest` 是 `await` 调用的。想改成「不阻塞直接丢弃」请先确认调用方。
 * - `logging.success(...)` → `logger.info(...)`（pino 没有 success 级别）。
 */
import { logger } from '../log/logger.js';
import { Mutex } from '../utils/mutex.js';

export type RequestStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** 池中的一条请求记录。 */
export interface PooledRequest {
  request_id: string;
  platform: string;
  model: string;
  message: string;
  conversation_id: string | null;
  status: RequestStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
  /** 分配的账号 ID。 */
  account_id: string | null;
  /** 分配的浏览器实例 ID。 */
  instance_id: string | null;
}

/** 池状态（`/v1/status` 用）。 */
export interface RequestPoolStatus {
  total_requests: number;
  queue_size: number;
  max_size: number;
  status_counts: Record<RequestStatus, number>;
}

/** 有界队列：满时 `put()` 等待（等价于 `asyncio.Queue(maxsize)`）。 */
class BoundedQueue<T> {
  private readonly items: T[] = [];

  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  /** 入队（满时等待直到有空位）。 */
  async put(item: T): Promise<void> {
    while (this.items.length >= this.capacity) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.items.push(item);
  }

  /** 出队（空时返回 null，非阻塞）。 */
  getNowait(): T | null {
    const item = this.items.shift() ?? null;
    if (item !== null && this.waiters.length > 0) {
      // 让出一个空位，唤醒最早等待的写入者
      const wake = this.waiters.shift();
      wake?.();
    }
    return item;
  }

  get size(): number {
    return this.items.length;
  }
}

export class RequestPool {
  private readonly requests = new Map<string, PooledRequest>();

  private readonly pendingQueue: BoundedQueue<PooledRequest>;

  private readonly lock = new Mutex();

  constructor(private readonly maxSize = 100) {
    this.pendingQueue = new BoundedQueue<PooledRequest>(maxSize);
    logger.info(`请求池初始化: max_size=${maxSize}`);
  }

  /** 添加请求到池中。 */
  async addRequest(params: {
    requestId: string;
    platform: string;
    model: string;
    message: string;
    conversationId?: string | null;
  }): Promise<PooledRequest> {
    const release = await this.lock.acquire();
    try {
      const request: PooledRequest = {
        request_id: params.requestId,
        platform: params.platform,
        model: params.model,
        message: params.message,
        conversation_id: params.conversationId ?? null,
        status: 'pending',
        created_at: Date.now() / 1000,
        started_at: null,
        completed_at: null,
        result: null,
        error: null,
        account_id: null,
        instance_id: null,
      };

      this.requests.set(params.requestId, request);
      await this.pendingQueue.put(request);

      logger.info(`请求已加入池中: ${params.requestId}`);
      return request;
    } finally {
      release();
    }
  }

  /** 标记请求为已完成。 */
  async markCompleted(requestId: string, result: string): Promise<void> {
    const release = await this.lock.acquire();
    try {
      const request = this.requests.get(requestId);
      if (!request) return;

      request.status = 'completed';
      request.completed_at = Date.now() / 1000;
      request.result = result;

      if (typeof request.started_at === 'number' && request.started_at > 0) {
        const duration = request.completed_at - request.started_at;
        logger.info(`请求完成: ${requestId}, 耗时: ${duration.toFixed(2)}s`);
      }
    } finally {
      release();
    }
  }

  /** 标记请求为失败。 */
  async markFailed(requestId: string, error: string): Promise<void> {
    const release = await this.lock.acquire();
    try {
      const request = this.requests.get(requestId);
      if (!request) return;

      request.status = 'failed';
      request.completed_at = Date.now() / 1000;
      request.error = error;
      logger.error(`请求失败: ${requestId}, 错误: ${error}`);
    } finally {
      release();
    }
  }

  /** 当前队列长度。 */
  getQueueSize(): number {
    return this.pendingQueue.size;
  }

  /** 池状态汇总。 */
  getStatus(): RequestPoolStatus {
    const statusCounts: Record<RequestStatus, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    for (const request of this.requests.values()) {
      statusCounts[request.status] += 1;
    }

    return {
      total_requests: this.requests.size,
      queue_size: this.getQueueSize(),
      max_size: this.maxSize,
      status_counts: statusCounts,
    };
  }
}

/**
 * 智能调度器（负载视图）。
 *
 * ⚠️ 在 Python 版里这套负载计数**从来没有被写入过**（没人调用 increment/decrement），
 * 所以 `getLoadStatus()` 一直返回两个空对象。这里保持同样的行为与字段形状，
 * 免得 `/v1/status` 的消费方对不上。
 */
export class IntelligentScheduler {
  private readonly instanceLoads = new Map<string, number>();

  private readonly accountLoads = new Map<string, number>();

  private readonly lock = new Mutex();

  constructor() {
    logger.info('智能调度器初始化');
  }

  /** 增加负载计数。 */
  async incrementLoad(instanceId: string, accountId: string): Promise<void> {
    const release = await this.lock.acquire();
    try {
      this.instanceLoads.set(instanceId, (this.instanceLoads.get(instanceId) ?? 0) + 1);
      this.accountLoads.set(accountId, (this.accountLoads.get(accountId) ?? 0) + 1);
      logger.debug(`增加负载: instance=${instanceId}, account=${accountId}`);
    } finally {
      release();
    }
  }

  /** 减少负载计数（减到 0 就移除条目，与 Python 一致）。 */
  async decrementLoad(instanceId: string, accountId: string): Promise<void> {
    const release = await this.lock.acquire();
    try {
      const inst = (this.instanceLoads.get(instanceId) ?? 0) - 1;
      if (inst <= 0) this.instanceLoads.delete(instanceId);
      else this.instanceLoads.set(instanceId, inst);

      const acc = (this.accountLoads.get(accountId) ?? 0) - 1;
      if (acc <= 0) this.accountLoads.delete(accountId);
      else this.accountLoads.set(accountId, acc);

      logger.debug(`减少负载: instance=${instanceId}, account=${accountId}`);
    } finally {
      release();
    }
  }

  /** 负载状态（供 `/v1/status` 展示）。 */
  getLoadStatus(): {
    instance_loads: Record<string, number>;
    account_loads: Record<string, number>;
  } {
    return {
      instance_loads: Object.fromEntries(this.instanceLoads),
      account_loads: Object.fromEntries(this.accountLoads),
    };
  }
}

let requestPool: RequestPool | null = null;
let scheduler: IntelligentScheduler | null = null;

/** 获取请求池实例（单例）。 */
export function getRequestPool(): RequestPool {
  requestPool ??= new RequestPool();
  return requestPool;
}

/** 获取调度器实例（单例）。 */
export function getScheduler(): IntelligentScheduler {
  scheduler ??= new IntelligentScheduler();
  return scheduler;
}

/** 重置单例（测试用）。 */
export function __setRequestPoolForTest(
  pool: RequestPool | null,
  sched: IntelligentScheduler | null,
): void {
  requestPool = pool;
  scheduler = sched;
}
