#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

for (const target of process.argv.slice(2)) {
  const abs = path.resolve(process.cwd(), target);
  const relativeToRepoRoot = path.relative(repoRoot, abs);
  if (
    abs !== repoRoot &&
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
