import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/handlers.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  metafile: true,
  sourcemap: false,
  outExtension: { '.js': '.cjs' },
  legalComments: 'none'
});
const root = resolve('.');
const inputs = Object.keys(result.metafile.inputs);
if (
  inputs.some(
    (input) =>
      !resolve(input).startsWith(`${root}/`) &&
      !resolve(input).startsWith(`${root}\\`)
  )
) {
  throw new Error('Monitoring bundle imported outside its standalone package');
}
if (
  inputs.some((input) =>
    /node_modules\/(mysql|redis|discord.js|winston|@sentry)\//.test(input)
  )
) {
  throw new Error('Monitoring bundle includes application dependencies');
}
await writeFile(
  'dist/bundle-inputs.json',
  `${JSON.stringify(
    inputs.sort((a, b) => a.localeCompare(b)),
    null,
    2
  )}\n`
);
console.log(
  `Standalone monitoring bundle verified (${inputs.length} local inputs).`
);
