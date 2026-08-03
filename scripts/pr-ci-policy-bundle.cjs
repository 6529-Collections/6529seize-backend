#!/usr/bin/env node
/* eslint @typescript-eslint/no-require-imports: off */
/* global Buffer, __dirname, console, module, process, require */
'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const CONTRACT = 'pr-ci-policy-bundle-v1';
const MAX_FILE_COUNT = 96;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 64 * 1024;
const GIT_BINARY = '/usr/bin/git';
const LEGACY_PR_CI_WORKFLOW_SHA256 =
  '8e7263390b15e4576fa04d0877c5b924a5ad210705f300363497676949fa6369';

const FILE_PATHS = Object.freeze([
  '.github/workflows/deploy.yml',
  '.github/workflows/on-pull-request.yml',
  '.github/workflows/release-bus-v2-advance-staging-ref.yml',
  '.github/workflows/release-bus-v2-preflight.yml',
  '.prettierignore',
  '.prettierrc',
  'bin/6529',
  'bin/bun',
  'bin/corepack',
  'bin/npm',
  'bin/npx',
  'bin/pnpm',
  'bin/yarn',
  'eslint.config.mjs',
  'jest.config.ts',
  'scripts/assert-pr-ci-source-clean.mjs',
  'scripts/bootstrap-6529-command.sh',
  'scripts/check-package-manager.mjs',
  'scripts/generate-deploy-config.mjs',
  'scripts/pr-ci-policy-bundle.cjs',
  'scripts/require-6529-command.cjs',
  'scripts/release-bus-backend-package-strategies.mjs',
  'scripts/release-bus-package-backend.mjs',
  'src/.prettierrc',
  'src/api-serverless/esbuild.config.mjs',
  'src/api-serverless/generate-openapi-routes.ts',
  'src/api-serverless/restructure-openapi.ts',
  'src/api-serverless/tsconfig.json',
  'src/api-serverless/tsconfig.paths.json',
  'src/config/deploy-services.json',
  'src/releaseBusV2/release-bus-v2-performance-workflow.test.ts',
  'src/releaseBusV2/release-bus-v2-advance-staging-ref-workflow.test.ts',
  'src/tests/_setup/globalSetup.ts',
  'src/tests/_setup/globalTeardown.ts',
  'src/tests/_setup/perTestHooks.ts',
  'tsconfig.json'
]);

const PACKAGE_POLICIES = Object.freeze({
  'package.json': Object.freeze({
    scriptKeys: Object.freeze([
      'build',
      'ci:assert-source-clean',
      'format:check',
      'generate:deploy-config',
      'lint:check',
      'postbuild',
      'prebuild',
      'pretest',
      'test'
    ]),
    fieldKeys: Object.freeze([
      'packageManager',
      'dependencies.adm-zip',
      'devDependencies.@types/jest',
      'devDependencies.@typescript-eslint/parser',
      'devDependencies.esbuild',
      'devDependencies.eslint',
      'devDependencies.jest',
      'devDependencies.prettier',
      'devDependencies.ts-jest',
      'devDependencies.ts-node',
      'devDependencies.typescript',
      'devDependencies.typescript-eslint',
      'devDependencies.yaml'
    ])
  }),
  'src/api-serverless/package.json': Object.freeze({
    scriptKeys: Object.freeze([
      'build',
      'generate',
      'generate:openapi',
      'postbuild',
      'prebuild',
      'restructure-openapi'
    ]),
    fieldKeys: Object.freeze([
      'packageManager',
      'dependencies.adm-zip',
      'dependencies.@openapitools/openapi-generator-cli',
      'devDependencies.esbuild',
      'devDependencies.eslint',
      'devDependencies.ts-node',
      'devDependencies.typescript'
    ])
  })
});

const RUNTIME_PINS = Object.freeze({ node: '22.17.1' });
const NODE_PIN_WORKFLOWS = Object.freeze([
  '.github/workflows/deploy.yml',
  '.github/workflows/on-pull-request.yml',
  '.github/workflows/release-bus-v2-preflight.yml'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitBlobSha(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return childProcess
    .execFileSync(GIT_BINARY, ['hash-object', '--stdin'], {
      encoding: 'utf8',
      input: bytes
    })
    .trim();
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertCanonicalToken(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\t\r\n\0]/u.test(value)
  ) {
    throw new Error(
      `pr-ci-policy-bundle: ${label} must be a non-empty tab/LF/NUL-free string`
    );
  }
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertCanonicalToken(value, label);
    if (seen.has(value)) {
      throw new Error(`pr-ci-policy-bundle: duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function readRegularFileNoFollow(absolutePath, label) {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) {
    throw new TypeError(
      'pr-ci-policy-bundle: this platform cannot reject symbolic-link inputs'
    );
  }

  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`pr-ci-policy-bundle: ${label} is missing`);
    }
    if (error?.code === 'ELOOP') {
      throw new Error(`pr-ci-policy-bundle: ${label} is not a regular file`);
    }
    throw error;
  }

  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`pr-ci-policy-bundle: ${label} is not a regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPackageField(packageJson, dottedKey) {
  let value = packageJson;
  for (const segment of dottedKey.split('.')) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      throw new Error(
        `pr-ci-policy-bundle: package field is missing: ${dottedKey}`
      );
    }
    value = value[segment];
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `pr-ci-policy-bundle: package field must be a non-empty string: ${dottedKey}`
    );
  }
  return value;
}

function assertNodeRuntimePins(root, workflows, expectedNodeVersion) {
  for (const relativePath of workflows) {
    const source = readRegularFileNoFollow(
      path.join(root, relativePath),
      `protected path ${relativePath}`
    ).toString('utf8');
    const exactLegacyWorkflow =
      relativePath === '.github/workflows/on-pull-request.yml' &&
      sha256(source) === LEGACY_PR_CI_WORKFLOW_SHA256;
    const versions = Array.from(
      source.matchAll(/node-version:\s*["']?([^"'#\s]+)["']?/gu),
      (match) => match[1]
    );
    if (
      versions.length === 0 ||
      (versions.some((version) => version !== expectedNodeVersion) &&
        !exactLegacyWorkflow)
    ) {
      throw new Error(
        `pr-ci-policy-bundle: ${relativePath} must pin every Node setup to ${expectedNodeVersion}`
      );
    }
  }
}

function assertPinnedWorkflowActions(root, workflows) {
  for (const relativePath of workflows) {
    const source = readRegularFileNoFollow(
      path.join(root, relativePath),
      `protected path ${relativePath}`
    ).toString('utf8');
    if (
      relativePath === '.github/workflows/on-pull-request.yml' &&
      sha256(source) === LEGACY_PR_CI_WORKFLOW_SHA256
    )
      continue;
    let workflow;
    try {
      workflow = YAML.parse(source, { maxAliasCount: 0 });
    } catch (error) {
      throw new Error(
        `pr-ci-policy-bundle: malformed workflow YAML at ${relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const visit = (value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(value, 'uses')) {
        const action = value.uses;
        if (typeof action !== 'string' || action.length === 0) {
          throw new Error(
            `pr-ci-policy-bundle: malformed uses at ${relativePath}`
          );
        }
        if (
          !action.startsWith('./') &&
          !/^[^@\s]+@[a-f0-9]{40}$/u.test(action)
        ) {
          throw new Error(
            `pr-ci-policy-bundle: external action is not pinned to a 40-hex SHA at ${relativePath}`
          );
        }
      }
      for (const child of Object.values(value)) visit(child);
    };
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new Error(
        `pr-ci-policy-bundle: malformed workflow YAML at ${relativePath}: expected an object`
      );
    }
    visit(workflow);
  }
}

function assertExactGitRef(root, expectedGitRef, filePaths) {
  if (!/^[a-f0-9]{40}$/u.test(expectedGitRef)) {
    throw new Error(
      'pr-ci-policy-bundle: expected Git ref must be an exact lowercase 40-hex commit'
    );
  }
  let resolved;
  try {
    resolved = childProcess
      .execFileSync(
        GIT_BINARY,
        ['rev-parse', '--verify', `${expectedGitRef}^{commit}`],
        { cwd: root, encoding: 'utf8' }
      )
      .trim();
  } catch {
    throw new Error('pr-ci-policy-bundle: expected Git commit is unavailable');
  }
  if (resolved !== expectedGitRef) {
    throw new Error('pr-ci-policy-bundle: expected Git commit moved');
  }
  for (const relativePath of filePaths) {
    let expectedBlob;
    try {
      expectedBlob = childProcess
        .execFileSync(
          GIT_BINARY,
          ['rev-parse', `${expectedGitRef}:${relativePath}`],
          {
            cwd: root,
            encoding: 'utf8'
          }
        )
        .trim();
    } catch {
      throw new Error(
        `pr-ci-policy-bundle: protected path is absent from exact Git ref: ${relativePath}`
      );
    }
    const actualBlob = gitBlobSha(
      readRegularFileNoFollow(
        path.join(root, relativePath),
        `protected path ${relativePath}`
      )
    );
    if (actualBlob !== expectedBlob) {
      throw new Error(
        `pr-ci-policy-bundle: working bytes differ from exact Git ref: ${relativePath}`
      );
    }
  }
}

function buildPolicyBundle({
  root,
  filePaths = FILE_PATHS,
  packagePolicies = PACKAGE_POLICIES,
  runtimePins = RUNTIME_PINS,
  nodePinWorkflows = NODE_PIN_WORKFLOWS,
  pinnedActionWorkflows = filePaths.filter((relativePath) =>
    relativePath.startsWith('.github/workflows/')
  ),
  maxFileCount = MAX_FILE_COUNT,
  maxSourceBytes = MAX_SOURCE_BYTES,
  maxCanonicalBytes = MAX_CANONICAL_BYTES
}) {
  if (!path.isAbsolute(root)) {
    throw new Error('pr-ci-policy-bundle: root must be absolute');
  }
  assertUnique(filePaths, 'file path');
  assertUnique(Object.keys(packagePolicies), 'package path');
  assertUnique(Object.keys(runtimePins), 'runtime pin key');
  if (filePaths.length > maxFileCount) {
    throw new Error(
      `pr-ci-policy-bundle: file count ${filePaths.length} exceeds ${maxFileCount}`
    );
  }

  let sourceBytes = 0;
  const lines = [];
  for (const relativePath of filePaths) {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split('/').some((segment) => segment === '..')
    ) {
      throw new Error(
        `pr-ci-policy-bundle: unsafe repository path: ${relativePath}`
      );
    }
    const bytes = readRegularFileNoFollow(
      path.join(root, relativePath),
      `protected path ${relativePath}`
    );
    sourceBytes += bytes.length;
    if (sourceBytes > maxSourceBytes) {
      throw new Error(
        `pr-ci-policy-bundle: protected source bytes exceed ${maxSourceBytes}`
      );
    }
    lines.push(`file\t${relativePath}\t${gitBlobSha(bytes)}\n`);
  }

  for (const [packagePath, policy] of Object.entries(packagePolicies)) {
    const packageJson = JSON.parse(
      readRegularFileNoFollow(
        path.join(root, packagePath),
        `protected package path ${packagePath}`
      ).toString('utf8')
    );
    if (packageJson.packageManager !== 'npm@10.9.8') {
      throw new Error(
        `pr-ci-policy-bundle: ${packagePath} must pin npm@10.9.8`
      );
    }
    assertUnique(policy.scriptKeys, `${packagePath} script key`);
    assertUnique(policy.fieldKeys, `${packagePath} field key`);
    for (const key of policy.scriptKeys) {
      const value = packageJson.scripts?.[key];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(
          `pr-ci-policy-bundle: package script is missing: ${packagePath}#${key}`
        );
      }
      lines.push(
        `package-script\t${packagePath}#${key}\t${JSON.stringify(value)}\n`
      );
    }
    for (const key of policy.fieldKeys) {
      lines.push(
        `package-field\t${packagePath}#${key}\t${JSON.stringify(
          readPackageField(packageJson, key)
        )}\n`
      );
    }
  }
  for (const [key, value] of Object.entries(runtimePins)) {
    assertCanonicalToken(value, `runtime pin ${key}`);
    lines.push(`runtime-pin\t${key}\t${JSON.stringify(value)}\n`);
  }
  if (runtimePins.node) {
    assertNodeRuntimePins(root, nodePinWorkflows, runtimePins.node);
  }
  assertPinnedWorkflowActions(root, pinnedActionWorkflows);

  lines.sort(bytewiseCompare);
  const canonical = lines.join('');
  const canonicalBytes = Buffer.byteLength(canonical, 'utf8');
  if (canonicalBytes > maxCanonicalBytes) {
    throw new Error(
      `pr-ci-policy-bundle: canonical bytes ${canonicalBytes} exceeds ${maxCanonicalBytes}`
    );
  }
  return {
    contract: CONTRACT,
    canonical,
    digest: sha256(Buffer.from(canonical, 'utf8')),
    line_count: lines.length,
    byte_count: canonicalBytes,
    source_byte_count: sourceBytes
  };
}

function parseCli(argv) {
  let output = '';
  let expectedGitRef = '';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      output = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--expected-git-ref') {
      expectedGitRef = argv[index + 1] ?? '';
      index += 1;
    } else {
      throw new Error(`pr-ci-policy-bundle: unknown argument: ${argument}`);
    }
  }
  if (!output) {
    throw new Error(
      'pr-ci-policy-bundle: usage: pr-ci-policy-bundle.cjs --output <path> --expected-git-ref <40-hex>'
    );
  }
  if (!expectedGitRef) {
    throw new Error('pr-ci-policy-bundle: --expected-git-ref is required');
  }
  return { output, expectedGitRef };
}

function main() {
  const { output, expectedGitRef } = parseCli(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  assertExactGitRef(root, expectedGitRef, [
    ...FILE_PATHS,
    ...Object.keys(PACKAGE_POLICIES)
  ]);
  const bundle = buildPolicyBundle({ root });
  const outputPath = path.resolve(process.cwd(), output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bundle.canonical, {
    encoding: 'utf8',
    flag: 'wx'
  });
  process.stdout.write(
    `${JSON.stringify({
      contract: bundle.contract,
      digest: bundle.digest,
      line_count: bundle.line_count,
      byte_count: bundle.byte_count,
      source_byte_count: bundle.source_byte_count
    })}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'pr-ci-policy-bundle: failed'
    );
    process.exitCode = 1;
  }
}

module.exports = {
  CONTRACT,
  FILE_PATHS,
  MAX_CANONICAL_BYTES,
  MAX_FILE_COUNT,
  MAX_SOURCE_BYTES,
  NODE_PIN_WORKFLOWS,
  PACKAGE_POLICIES,
  RUNTIME_PINS,
  assertExactGitRef,
  buildPolicyBundle,
  bytewiseCompare,
  gitBlobSha,
  readRegularFileNoFollow,
  sha256
};
