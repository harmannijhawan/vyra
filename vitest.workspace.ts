import { defineWorkspace } from 'vitest/config';

// Each package contributes its own vitest config; this file aggregates them
// so `npm test` runs the whole suite in one pass.
export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
]);
