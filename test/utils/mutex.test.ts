import { describe, expect, it } from 'vitest';

import { Mutex } from '../../src/utils/mutex.js';

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Mutex', () => {
  it('run 返回结果并自动释放', async () => {
    const lock = new Mutex();
    expect(await lock.run(async () => 42)).toBe(42);
    expect(lock.isLocked).toBe(false);
  });

  it('异常路径也会释放锁（不会把服务永久堵死）', async () => {
    const lock = new Mutex();
    await expect(
      lock.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(lock.isLocked).toBe(false);
    expect(await lock.run(async () => 'ok')).toBe('ok');
  });

  it('isLocked 在持有期间为 true', async () => {
    const lock = new Mutex();
    await lock.run(async () => {
      expect(lock.isLocked).toBe(true);
    });
    expect(lock.isLocked).toBe(false);
  });

  it('串行化：后进入者必须等前者结束', async () => {
    const lock = new Mutex();
    const order: string[] = [];

    const first = lock.run(async () => {
      order.push('a-start');
      await tick(20);
      order.push('a-end');
    });

    await tick(1);
    const second = lock.run(async () => {
      order.push('b-start');
      await tick(1);
      order.push('b-end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('排队顺序是 FIFO，且不会被后来者插队', async () => {
    const lock = new Mutex();
    const order: number[] = [];
    const keep: Array<Promise<void>> = [];

    for (let i = 0; i < 4; i += 1) {
      keep.push(
        lock.run(async () => {
          order.push(i);
          await tick(1);
        }),
      );
    }

    await Promise.all(keep);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('acquire 返回的释放函数可手工调用', async () => {
    const lock = new Mutex();
    const release = await lock.acquire();
    expect(lock.isLocked).toBe(true);
    release();
    expect(lock.isLocked).toBe(false);
  });

  it('锁交接后仍在 held 状态（不会出现两人同时持锁）', async () => {
    const lock = new Mutex();
    const release = await lock.acquire();

    const waiter = lock.run(async () => {
      expect(lock.isLocked).toBe(true);
      return 'inside';
    });

    release();
    expect(await waiter).toBe('inside');
  });
});
