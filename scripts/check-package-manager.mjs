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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const fix = process.argv.includes('--fix');

const packageJsonFiles = [];
const strayLockfiles = [];
collectFiles(repoRoot);

const errors = [];

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
  if (manifest.packageManager === PINNED_PACKAGE_MANAGER) {
    continue;
  }
  if (fix) {
    fs.writeFileSync(absolutePath, setPackageManager(raw));
    console.log(`fixed: ${file}`);
  } else {
    errors.push(
      `${file}: "packageManager" must be "${PINNED_PACKAGE_MANAGER}" (found ${JSON.stringify(
        manifest.packageManager ?? null
      )}). Run: node scripts/check-package-manager.mjs --fix`
    );
  }
}

function collectFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        collectFiles(absolutePath);
      }
      continue;
    }
    const relativePath = path
      .relative(repoRoot, absolutePath)
      .replaceAll(path.sep, '/');
    if (entry.name === 'package.json') {
      packageJsonFiles.push(relativePath);
    } else if (FORBIDDEN_FILES.has(entry.name)) {
      strayLockfiles.push(relativePath);
    }
  }
}

function setPackageManager(raw) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const existingKey = /"packageManager"\s*:\s*"[^"]*"/;
  if (existingKey.test(raw)) {
    return raw.replace(
      existingKey,
      `"packageManager": "${PINNED_PACKAGE_MANAGER}"`
    );
  }
  const indentMatch = raw.match(/^([ \t]+)"/m);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const closingIndex = raw.lastIndexOf('}');
  const head = raw.slice(0, closingIndex).replace(/\s*$/, '');
  const needsComma = !head.endsWith('{');
  return (
    head +
    `${needsComma ? ',' : ''}${eol}${indent}"packageManager": "${PINNED_PACKAGE_MANAGER}"${eol}` +
    raw.slice(closingIndex)
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
  `Package manager check passed: ${packageJsonFiles.length} package.json files pinned to ${PINNED_PACKAGE_MANAGER}, no stray lockfiles.`
);
