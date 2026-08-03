import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PINNED_PACKAGE_MANAGER = 'npm@10.9.8';
const FORBIDDEN_FILES = new Set([
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'bun.lock',
  '.yarnrc',
  '.yarnrc.yml'
]);
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.serverless',
  'dist',
  'build',
  'coverage'
]);
const REQUIRED_COMMAND_FILES = [
  'bin/6529',
  'bin/bun',
  'bin/corepack',
  'bin/npm',
  'bin/npx',
  'bin/pnpm',
  'bin/yarn',
  'scripts/bootstrap-6529-command.sh',
  'scripts/require-6529-command.cjs'
];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const commandGuardPath = path.join(
  repoRoot,
  'scripts',
  'require-6529-command.cjs'
);
const fix = process.argv.includes('--fix');

const gitignoreMatchers = loadGitignoreMatchers();
const packageJsonFiles = [];
const strayLockfiles = [];
collectFiles(repoRoot);

const errors = [];

for (const file of REQUIRED_COMMAND_FILES) {
  const absolutePath = path.join(repoRoot, file);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`${file}: required 6529 command file is missing`);
    continue;
  }
  if ((fs.statSync(absolutePath).mode & 0o111) === 0) {
    errors.push(`${file}: required 6529 command file is not executable`);
  }
}

for (const file of strayLockfiles) {
  errors.push(
    `${file}: forbidden package-manager file. This repo uses npm only; remove it.`
  );
}

for (const file of packageJsonFiles) {
  const absolutePath = path.join(repoRoot, file);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    errors.push(`${file}: not valid JSON`);
    continue;
  }
  const expectedPreinstall = getExpectedPreinstall(absolutePath);
  const hasPinnedPackageManager =
    manifest.packageManager === PINNED_PACKAGE_MANAGER;
  const unguardedScripts = getUnguardedScripts(
    manifest.scripts,
    expectedPreinstall
  );
  const hasCommandGuard = unguardedScripts.length === 0;

  if (fix && (!hasPinnedPackageManager || !hasCommandGuard)) {
    manifest.packageManager = PINNED_PACKAGE_MANAGER;
    manifest.scripts = guardScripts(manifest.scripts, expectedPreinstall);
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(
      absolutePath,
      `${JSON.stringify(manifest, null, 2).replaceAll('\n', eol)}${eol}`
    );
    console.log(`fixed: ${file}`);
    continue;
  }

  if (!hasPinnedPackageManager) {
    errors.push(
      `${file}: "packageManager" must be "${PINNED_PACKAGE_MANAGER}" (found ${JSON.stringify(
        manifest.packageManager ?? null
      )}). From the repository root, run: 6529 run package-manager:fix`
    );
  }
  if (!hasCommandGuard) {
    errors.push(
      `${file}: every package script must start with ${JSON.stringify(
        `${expectedPreinstall} && `
      )}; preinstall must equal ${JSON.stringify(
        expectedPreinstall
      )}. Unguarded: ${unguardedScripts.join(
        ', '
      )}. From the repository root, run: 6529 run package-manager:fix`
    );
  }
}

function getExpectedPreinstall(packageJsonPath) {
  const relativeGuardPath = path
    .relative(path.dirname(packageJsonPath), commandGuardPath)
    .replaceAll(path.sep, '/');
  return `node ${relativeGuardPath}`;
}

function getUnguardedScripts(scripts, expectedGuard) {
  if (!scripts || typeof scripts !== 'object') {
    return ['<missing scripts>'];
  }
  const guardPrefix = `${expectedGuard} && `;
  return Object.entries(scripts)
    .filter(([name, command]) =>
      name === 'preinstall'
        ? command !== expectedGuard
        : typeof command !== 'string' || !command.startsWith(guardPrefix)
    )
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

function guardScripts(scripts, expectedGuard) {
  const guardedScripts = { preinstall: expectedGuard };
  const guardPrefix = `${expectedGuard} && `;
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (name === 'preinstall') {
      continue;
    }
    guardedScripts[name] =
      typeof command === 'string' && command.startsWith(guardPrefix)
        ? command
        : `${guardPrefix}${command}`;
  }
  return guardedScripts;
}

function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path
      .relative(repoRoot, absolutePath)
      .replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      if (
        !SKIPPED_DIRECTORIES.has(entry.name) &&
        !isGitignored(relativePath, true)
      ) {
        collectFiles(absolutePath);
      }
      continue;
    }
    if (isGitignored(relativePath, false)) {
      continue;
    }
    if (entry.name === 'package.json') {
      packageJsonFiles.push(relativePath);
    } else if (FORBIDDEN_FILES.has(entry.name)) {
      strayLockfiles.push(relativePath);
    }
  }
}

// Minimal .gitignore support so local-only files (scratch directories,
// vendored tools) are not validated or rewritten. Handles the pattern
// shapes used in this repo's root .gitignore: bare names, dir/ suffixes,
// leading-/ anchors, and * / ? / ** globs. Negations are ignored, which
// only makes the check skip more, never fail on a re-included file.
function loadGitignoreMatchers() {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return [];
  }
  return fs
    .readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((pattern) => {
      const directoryOnly = pattern.endsWith('/');
      let body = directoryOnly ? pattern.slice(0, -1) : pattern;
      const anchored = body.startsWith('/') || body.includes('/');
      body = body.startsWith('/') ? body.slice(1) : body;
      const regexBody = body
        .split('**')
        .map((part) =>
          part
            .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
            .replaceAll('*', '[^/]*')
            .replaceAll('?', '[^/]')
        )
        .join('.*');
      const prefix = anchored ? '^' : '(^|/)';
      return { regex: new RegExp(`${prefix}${regexBody}$`), directoryOnly };
    });
}

function isGitignored(relativePath, isDirectory) {
  return gitignoreMatchers.some(
    ({ regex, directoryOnly }) =>
      (!directoryOnly || isDirectory) && regex.test(relativePath)
  );
}

if (errors.length > 0) {
  console.error(
    `Package manager check failed (${errors.length} problem${
      errors.length === 1 ? '' : 's'
    }):`
  );
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Package manager check passed: ${packageJsonFiles.length} package.json files pinned to ${PINNED_PACKAGE_MANAGER}, with every package script guarded by 6529 and no stray lockfiles.`
);
