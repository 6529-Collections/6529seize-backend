#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

for (const target of process.argv.slice(2)) {
  if (!target) {
    console.error('Refusing to remove an empty path target.');
    process.exitCode = 1;
    continue;
  }

  const abs = path.resolve(process.cwd(), target);
  const relativeToRepoRoot = path.relative(repoRoot, abs);
  if (abs === repoRoot) {
    console.error(`Refusing to remove repository root: ${target}`);
    process.exitCode = 1;
    continue;
  }

  if (
    (relativeToRepoRoot.startsWith('..') || path.isAbsolute(relativeToRepoRoot))
  ) {
    console.error(`Refusing to remove path outside repository root: ${target}`);
    process.exitCode = 1;
    continue;
  }

  fs.rmSync(abs, {
    force: true,
    maxRetries: 3,
    recursive: true
  });
}
