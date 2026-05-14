/* eslint-env node */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_REF = 'origin/main';

const options = process.argv.slice(2).reduce(
  (result, arg) => {
    if (arg.startsWith('--base=')) {
      return { ...result, baseRef: arg.slice('--base='.length) };
    }
    if (arg === '--skip-typecheck') {
      return { ...result, skipTypecheck: true };
    }
    throw new Error(`Unknown argument: ${arg}`);
  },
  { baseRef: DEFAULT_BASE_REF, skipTypecheck: false }
);

const repoRoot = process.cwd();

function run(command, args, extraOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraOptions.env
    },
    shell: false,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function read(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

function readLines(command, args) {
  const output = read(command, args);
  return output ? output.split('\n').filter(Boolean) : [];
}

function getMergeBase(baseRef) {
  try {
    return read('git', ['merge-base', 'HEAD', baseRef]);
  } catch (error) {
    throw new Error(
      `Could not find merge base with ${baseRef}. Fetch main first or pass --base=<ref>.\n${error.message}`
    );
  }
}

function normalizeFileName(fileName) {
  return fileName.split(path.sep).join('/');
}

function fileExists(fileName) {
  return existsSync(path.join(repoRoot, fileName));
}

function changedFilesSince(baseRef) {
  const mergeBase = getMergeBase(baseRef);
  const committed = readLines('git', ['diff', '--name-only', `${mergeBase}...HEAD`]);
  const staged = readLines('git', ['diff', '--cached', '--name-only']);
  const unstaged = readLines('git', ['diff', '--name-only']);

  return [...new Set([...committed, ...staged, ...unstaged].map(normalizeFileName))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function changedSourceTsFiles(baseRef) {
  return changedFilesSince(baseRef).filter(
    (fileName) =>
      fileName.startsWith('src/') && fileName.endsWith('.ts') && fileExists(fileName)
  );
}

const changedTsFiles = changedSourceTsFiles(options.baseRef);

if (!changedTsFiles.length) {
  console.log(`No changed src/**/*.ts files found since ${options.baseRef}.`);
  if (!options.skipTypecheck) {
    run('npm', ['run', 'generate:deploy-config']);
    run(
      'npx',
      ['tsc', '-p', 'tsconfig.json', '--noEmit'],
      { env: { NODE_OPTIONS: '--max-old-space-size=8192' } }
    );
  }
  process.exit(0);
}

console.log(`Checking ${changedTsFiles.length} changed src/**/*.ts file(s) since ${options.baseRef}.`);

run('npm', ['run', 'generate:deploy-config']);
run('npx', ['prettier', '--write', ...changedTsFiles]);
run(
  'npx',
  ['eslint', '--fix', '--max-warnings=0', ...changedTsFiles],
  { env: { NODE_OPTIONS: '--max-old-space-size=8192' } }
);
run('npx', ['jest', '--findRelatedTests', ...changedTsFiles, '--passWithNoTests']);

if (!options.skipTypecheck) {
  run(
    'npx',
    ['tsc', '-p', 'tsconfig.json', '--noEmit'],
    { env: { NODE_OPTIONS: '--max-old-space-size=8192' } }
  );
}
