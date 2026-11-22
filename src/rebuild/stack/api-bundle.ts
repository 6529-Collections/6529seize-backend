import * as fs from 'node:fs';
import * as path from 'node:path';

/** The API's entry for the run, bundled with the API's own compiler settings. */
const API_ENTRY = path.join('src', 'rebuild', 'stack', 'api-server.child.ts');

/** Files the API reads from its working directory; its deploy copies them beside the bundle. */
const API_FILES = ['openapi.yaml', 'openapi.oracle.yaml'];

/**
 * Bundles the API with esbuild into `outDir/api.js`, as the API's deploy
 * does (src/api-serverless/esbuild.config.mjs), so its module interop is the
 * deployed one, and copies the files the deploy puts beside it. The API runs
 * with `outDir` as its working directory. Returns the bundle's path.
 */
export async function bundleApi(
  repoRoot: string,
  outDir: string
): Promise<string> {
  const esbuild = require('esbuild') as {
    build(options: Record<string, unknown>): Promise<{ errors: unknown[] }>;
  };
  const apiPackage = path.join(repoRoot, 'src', 'api-serverless');
  const outfile = path.join(outDir, 'api.js');
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, API_ENTRY)],
    bundle: true,
    sourcemap: true,
    platform: 'node',
    target: 'es2020',
    outfile,
    tsconfig: path.join(apiPackage, 'tsconfig.json'),
    absWorkingDir: apiPackage,
    logLevel: 'silent'
  });
  if (result.errors.length) {
    throw new Error(
      `The API bundle failed: ${JSON.stringify(result.errors).slice(0, 2000)}`
    );
  }
  for (const file of API_FILES) {
    fs.copyFileSync(path.join(apiPackage, file), path.join(outDir, file));
  }
  return outfile;
}
