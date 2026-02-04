import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TsconfigPathsPlugin } from '@esbuild-plugins/tsconfig-paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  sourcemap: true,
  platform: 'node',
  target: 'es2020',
  outfile: 'dist/index.js',
  plugins: [
    TsconfigPathsPlugin({
      tsconfig: path.join(__dirname, 'tsconfig.paths.json')
    })
  ]
});
