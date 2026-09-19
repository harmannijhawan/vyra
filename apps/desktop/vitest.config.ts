import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: 'vyra-desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Resolve the workspace contract package to source during tests/dev.
      '@vyra/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
