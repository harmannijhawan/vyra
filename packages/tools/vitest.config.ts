import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    name: 'unit',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // @vyra/shared is resolved from source until workspaces are installed.
      '@vyra/shared': fileURLToPath(
        new URL('../shared/src/index.ts', import.meta.url),
      ),
    },
  },
});
