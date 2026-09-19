import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = fileURLToPath(
  new URL('../shared/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@vyra\/shared$/, replacement: shared }],
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
