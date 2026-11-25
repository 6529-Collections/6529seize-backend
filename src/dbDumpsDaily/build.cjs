// Bundles the function as `esbuild index.ts --bundle --sourcemap
// --platform=node --target=es2020 --outfile=dist/index.js` would, with the
// commit it is built from baked in (__DB_DUMPS_DAILY_BUILD_COMMIT__), so a
// job can tell which code it runs.
const { execFileSync } = require('node:child_process');

const COMMIT = /^[0-9a-f]{40}$/;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

/**
 * HEAD's commit, or '' when it doesn't describe the build: no git, or
 * tracked files changed since the commit.
 */
function buildCommit(run = git) {
  try {
    const head = run(['rev-parse', 'HEAD']).trim();
    const changed = run([
      'status',
      '--porcelain',
      '--untracked-files=no'
    ]).trim();
    return COMMIT.test(head) && changed === '' ? head : '';
  } catch {
    return '';
  }
}

function build(commit = buildCommit()) {
  require('esbuild').buildSync({
    entryPoints: ['index.ts'],
    bundle: true,
    sourcemap: true,
    platform: 'node',
    target: 'es2020',
    outfile: 'dist/index.js',
    logLevel: 'warning',
    define: { __DB_DUMPS_DAILY_BUILD_COMMIT__: JSON.stringify(commit) }
  });
  process.stdout.write(
    `dbDumpsDaily built from ${commit || 'an unknown commit'}\n`
  );
}

module.exports = { buildCommit, build };

if (require.main === module) {
  build();
}
