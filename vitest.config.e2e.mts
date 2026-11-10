import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/env.ts'],
    // every file truncates the same test database, so run them one at a time
    fileParallelism: false,
    testTimeout: 30_000,
  },
  // SWC instead of esbuild so Nest gets its decorator metadata
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
