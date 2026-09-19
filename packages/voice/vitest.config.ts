import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Alias @vyra/shared to source so tests run without a built workspace install.
export default defineConfig({
  resolve: {
    alias: {
      '@vyra/shared': fileURLToPath(
        new URL('../shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
