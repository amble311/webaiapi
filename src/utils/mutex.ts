/**
 * 简单互斥锁 —— 替代 Python 的 `asyncio.Lock`。
 *
 * Node 没有内置的异步锁，而为这一处需求引入依赖不划算，所以自己实现（约 30 行）。
 *
 * 用法：
 * ```ts
 * const lock = new Mutex();
 * await lock.run(async () => { ... });   // 等价于 Python 的 `async with lock:`
 * if (lock.isLocked) { ... }             // 等价于 Python 的 `lock.locked()`
 * ```
 */
export class Mutex {
  /** 等待者队列：release 时把锁直接交给队首（而不是先释放再竞争）。 */
  private readonly waiters: Array<() => void> = [];

  private held = false;

  /** 当前是否已被持有。 */
  get isLocked(): boolean {
    return this.held;
  }

  /** 等待者数量（仅用于诊断/测试）。 */
  get pending(): number {
    return this.waiters.length;
  }

  /**
   * 获取锁；返回释放函数。
   *
   * 请在 `finally` 里调用释放函数，保证异常路径也能解锁。
   */
  async acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true;
      return () => this.release();
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // 被唤醒时锁已经「转交」给它，仍处于 held 状态
    return () => this.release();
  }

  /** 在锁保护下执行 `fn`（等价于 Python 的 `async with lock:`）。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 直接转交，避免「释放 → 被别的调用抢占」导致排队失效
      next();
      return;
    }
    this.held = false;
  }
}
