import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
});
