import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.serverless',
  'build',
  'coverage',
  'dist',
  'node_modules'
]);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const requestedLockfiles = process.argv.slice(2);
const lockfiles =
  requestedLockfiles.length > 0
    ? requestedLockfiles.map((file) => path.resolve(process.cwd(), file))
    : collectLockfiles(repoRoot);
const errors = [];
let optionalDependencyCount = 0;

if (lockfiles.length === 0) {
  errors.push('no package-lock.json files found');
}

for (const lockfilePath of lockfiles) {
  const label = displayPath(lockfilePath);
  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    continue;
  }

  if (
    !lockfile.packages ||
    typeof lockfile.packages !== 'object' ||
    Array.isArray(lockfile.packages)
  ) {
    errors.push(`${label}: lockfile has no packages object`);
    continue;
  }

  for (const [packagePath, metadata] of Object.entries(lockfile.packages)) {
    for (const [dependency, version] of Object.entries(
      metadata.optionalDependencies ?? {}
    )) {
      optionalDependencyCount += 1;
      if (!resolvePackage(lockfile.packages, packagePath, dependency)) {
        errors.push(
          `${label}: ${packagePath || '<root>'} declares optional dependency ` +
            `${dependency}@${version}, but the lockfile has no resolvable package record`
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Package lock check failed (${errors.length} problem${
      errors.length === 1 ? '' : 's'
    }):`
  );
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `Package lock check passed: ${lockfiles.length} lockfile${
    lockfiles.length === 1 ? '' : 's'
  }, ${optionalDependencyCount} optional dependency edge${
    optionalDependencyCount === 1 ? '' : 's'
  } resolved.`
);

function collectLockfiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...collectLockfiles(path.join(directory, entry.name)));
      }
    } else if (entry.name === 'package-lock.json') {
      found.push(path.join(directory, entry.name));
    }
  }
  return found.sort();
}

function resolvePackage(packages, packagePath, dependency) {
  let currentPath = packagePath;
  while (true) {
    const candidate = currentPath
      ? `${currentPath}/node_modules/${dependency}`
      : `node_modules/${dependency}`;
    if (Object.hasOwn(packages, candidate)) {
      return candidate;
    }
    if (!currentPath) {
      return null;
    }
    currentPath = parentPackagePath(currentPath);
  }
}

function parentPackagePath(packagePath) {
  const nestedDependencyMarker = '/node_modules/';
  const markerIndex = packagePath.lastIndexOf(nestedDependencyMarker);
  return markerIndex >= 0 ? packagePath.slice(0, markerIndex) : '';
}

function displayPath(lockfilePath) {
  const relativePath = path.relative(repoRoot, lockfilePath);
  return relativePath.startsWith('..') ? lockfilePath : relativePath;
}
