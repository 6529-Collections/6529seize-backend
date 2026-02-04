import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoSrc = path.resolve(__dirname, '..');

await esbuild.build({
  entryPoints: ['src/handler.ts'],
  bundle: true,
  sourcemap: true,
  platform: 'node',
  target: 'es2020',
  outfile: 'dist/index.js',
  alias: {
    '@/constants': path.join(repoSrc, 'constants'),
    '@/meme-claims': path.join(repoSrc, 'meme-claims'),
    '@/entities': path.join(repoSrc, 'entities'),
    '@/numbers': path.join(repoSrc, 'numbers'),
    '@/strings': path.join(repoSrc, 'strings')
  }
});
