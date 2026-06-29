import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  // VS Code loads the extension via require(); CJS is the safe host format.
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  // `vscode` is provided by the host at runtime and must never be bundled.
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await build(options);
}
