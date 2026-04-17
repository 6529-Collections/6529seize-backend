#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const denied = [];
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  '.turbo',
  '.next'
]);

function walk(currentPath) {
  const entries = fs.readdirSync(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      walk(path.join(currentPath, entry.name));
      continue;
    }

    if (entry.name === 'package-lock.json') {
      denied.push(path.relative(repoRoot, path.join(currentPath, entry.name)));
    }
  }
}

walk(repoRoot);

if (denied.length > 0) {
  console.error('package-lock.json is not supported in this repository.');
  console.error('Remove these files and commit pnpm-lock.yaml instead:');
  for (const file of denied.toSorted((a, b) => a.localeCompare(b))) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}
