/**
 * VYRA — Electron main/preload bundling with esbuild.
 *
 * The main process runs in Node, so `platform: 'node'` keeps Node builtins
 * external. Workspace packages (@vyra/*) are inlined from TypeScript source.
 * npm dependencies with native binaries or file-based payloads stay
 * external and resolve from node_modules at runtime (both in dev and in
 * the packaged app).
 *
 * Usage:
 *   node esbuild.config.mjs main      # dist/main/main.js
 *   node esbuild.config.mjs preload   # dist/preload/preload.js
 *   node esbuild.config.mjs           # both
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(root, '../../packages');

const alias = Object.fromEntries(
  [
    'shared',
    'agent-core',
    'tools',
    'voice',
    'memory',
    'providers',
    'observability',
    'safety',
  ].map((p) => [`@vyra/${p}`, path.join(workspace, p, 'src/index.ts')]),
);

// Never bundle these: native .node binaries and Playwright's driver files
// must resolve from node_modules at runtime.
const nativeExternal = [
  'electron',
  'better-sqlite3',
  '@nut-tree-fork/nut-js',
  'playwright',
  'playwright-core',
];

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias,
  external: nativeExternal,
  logLevel: 'info',
};

const which = process.argv[2];

if (!which || which === 'main') {
  rmSync(path.join(root, 'dist/main'), { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(root, 'dist/main/main.js'),
  });
}

if (!which || which === 'preload') {
  rmSync(path.join(root, 'dist/preload'), { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(root, 'dist/preload/preload.js'),
  });
}
