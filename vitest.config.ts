import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 项目里有大量按毫秒计时的等待循环，测试串行更可复现
    // （Vitest 4 起 `poolOptions` 被移除，用 fileParallelism 控制并发）
    fileParallelism: false,
  },
});
