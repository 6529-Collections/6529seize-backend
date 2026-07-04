import { execSync } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import process from 'node:process';

const PINNED_PACKAGE_MANAGER = 'npm@10.9.8';
const FORBIDDEN_FILES = [
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'bun.lock',
  '.yarnrc',
  '.yarnrc.yml'
];

const fix = process.argv.includes('--fix');

const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const packageJsonFiles = trackedFiles.filter(
  (file) => file === 'package.json' || file.endsWith('/package.json')
);

const errors = [];

const strayLockfiles = trackedFiles.filter((file) => {
  const basename = file.split('/').pop();
  return FORBIDDEN_FILES.includes(basename);
});
for (const file of strayLockfiles) {
  errors.push(
    `${file}: forbidden package-manager file. This repo uses npm only; remove it.`
  );
}

for (const file of packageJsonFiles) {
  const raw = fs.readFileSync(file, 'utf8');
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
    const updated = setPackageManager(raw, manifest);
    fs.writeFileSync(file, updated);
    console.log(`fixed: ${file}`);
  } else {
    errors.push(
      `${file}: "packageManager" must be "${PINNED_PACKAGE_MANAGER}" (found ${JSON.stringify(
        manifest.packageManager ?? null
      )}). Run: node scripts/check-package-manager.mjs --fix`
    );
  }
}

function setPackageManager(raw, manifest) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = raw.endsWith('\n');
  manifest.packageManager = PINNED_PACKAGE_MANAGER;
  let output = JSON.stringify(manifest, null, 2);
  if (eol !== '\n') {
    output = output.replaceAll('\n', eol);
  }
  return trailingNewline ? output + eol : output;
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
