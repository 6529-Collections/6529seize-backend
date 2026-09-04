#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRIVATE_SCOPE = '@6529-collections';
const PRIVATE_PACKAGE_NAME = `${PRIVATE_SCOPE}/release-request`;
const PRIVATE_PACKAGE_VERSION = '0.0.3';
const PRIVATE_PACKAGE_SPEC = `${PRIVATE_PACKAGE_NAME}@${PRIVATE_PACKAGE_VERSION}`;
const PRIVATE_PACKAGE_LOCK_PATH = `node_modules/${PRIVATE_PACKAGE_NAME}`;
const PRIVATE_REGISTRY = 'https://npm.pkg.github.com';
const PRIVATE_TARBALL =
  `${PRIVATE_REGISTRY}/download/${PRIVATE_PACKAGE_NAME}/` +
  `${PRIVATE_PACKAGE_VERSION}/7cafe723b35db8ccf76eba6b856f3840412796b4`;
const PRIVATE_INTEGRITY =
  'sha512-hOBpv7kbJihS51uzysMQxTgq4lZshKFr3HaPT0haoppiPYquSL7HrLKLIPrx9jf1VEIgqRxmMYw2+515dw/TlQ==';
const AUTH_VARIABLE = 'NODE_AUTH_TOKEN';
const AUTH_PLACEHOLDER = `\${${AUTH_VARIABLE}}`;
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const ALLOWED_COMMANDS = new Set([
  'audit',
  'ci',
  'install',
  'uninstall',
  'update'
]);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
];
const FORBIDDEN_OPTION_FRAGMENTS = [
  'auth',
  'ca',
  'global',
  'location',
  'prefix',
  'proxy',
  'registry',
  'script-shell',
  'strict-ssl',
  'token',
  'userconfig',
  'workspace'
];

function policyError(message) {
  return new Error(`Private GitHub Packages install: ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw policyError(
      `cannot read ${path.basename(filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function buildPrivateNpmrc() {
  return [
    `${PRIVATE_SCOPE}:registry=${PRIVATE_REGISTRY}`,
    `//npm.pkg.github.com/:_authToken=${AUTH_PLACEHOLDER}`,
    ''
  ].join('\n');
}

function buildTokenFreeScriptShell() {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `unset ${AUTH_VARIABLE}`,
    'exec /bin/sh "$@"',
    ''
  ].join('\n');
}

function privateDependencyEntries(metadata) {
  const entries = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = metadata?.[field];
    if (!dependencies || typeof dependencies !== 'object') {
      continue;
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (name.startsWith(`${PRIVATE_SCOPE}/`)) {
        entries.push({ field, name, version });
      } else if (String(version).includes(`${PRIVATE_SCOPE}/`)) {
        throw policyError(
          `${name} cannot alias or redirect to the private package scope`
        );
      }
    }
  }
  return entries;
}

function validateOnlyApprovedPrivateDependency(metadata, label) {
  for (const entry of privateDependencyEntries(metadata)) {
    if (
      entry.name !== PRIVATE_PACKAGE_NAME ||
      entry.version !== PRIVATE_PACKAGE_VERSION
    ) {
      throw policyError(
        `${label} may only reference ${PRIVATE_PACKAGE_SPEC}, not ${entry.name}@${entry.version}`
      );
    }
  }
}

function isPrivatePackageRecordPath(packagePath) {
  return new RegExp(`(?:^|node_modules/)${PRIVATE_SCOPE}/[^/]+$`).test(
    packagePath
  );
}

function resolvedHostname(metadata) {
  try {
    return new URL(metadata.resolved).hostname;
  } catch {
    return null;
  }
}

function validateLockfilePackageRecord(packagePath, metadata) {
  validateOnlyApprovedPrivateDependency(
    metadata,
    `package-lock.json record ${packagePath || '<root>'}`
  );

  if (
    isPrivatePackageRecordPath(packagePath) &&
    packagePath !== PRIVATE_PACKAGE_LOCK_PATH
  ) {
    throw policyError(
      `package-lock.json contains an unapproved private package record: ${packagePath}`
    );
  }
  if (
    packagePath === PRIVATE_PACKAGE_LOCK_PATH &&
    metadata.resolved !== PRIVATE_TARBALL
  ) {
    throw policyError(
      `package-lock.json must resolve ${PRIVATE_PACKAGE_SPEC} to the approved tarball`
    );
  }
  if (
    resolvedHostname(metadata) === 'npm.pkg.github.com' &&
    packagePath !== PRIVATE_PACKAGE_LOCK_PATH
  ) {
    throw policyError(
      `package-lock.json routes an unapproved package through ${PRIVATE_REGISTRY}: ${packagePath}`
    );
  }
}

function validateLockfilePackageRecords(lockfile) {
  for (const [packagePath, metadata] of Object.entries(
    lockfile.packages ?? {}
  )) {
    validateLockfilePackageRecord(packagePath, metadata);
  }
}

function validateApprovedPackageRecord(packageRecord) {
  if (
    packageRecord?.version !== PRIVATE_PACKAGE_VERSION ||
    packageRecord?.resolved !== PRIVATE_TARBALL ||
    packageRecord?.integrity !== PRIVATE_INTEGRITY ||
    packageRecord?.dev !== true
  ) {
    throw policyError(
      `package-lock.json must contain the approved ${PRIVATE_PACKAGE_SPEC} tarball and integrity`
    );
  }
}

function validateRepositoryPolicy(
  repositoryRoot = REPOSITORY_ROOT,
  { allowMissingLockEntry = false } = {}
) {
  if (fs.existsSync(path.join(repositoryRoot, '.npmrc'))) {
    throw policyError(
      'the repository must not persist private registry credentials or routing in .npmrc'
    );
  }

  const manifest = readJson(path.join(repositoryRoot, 'package.json'));
  validateOnlyApprovedPrivateDependency(manifest, 'package.json');
  if (
    manifest.devDependencies?.[PRIVATE_PACKAGE_NAME] !== PRIVATE_PACKAGE_VERSION
  ) {
    throw policyError(
      `package.json must pin ${PRIVATE_PACKAGE_SPEC} exactly as a root dev dependency`
    );
  }

  const lockfile = readJson(path.join(repositoryRoot, 'package-lock.json'));
  const rootRecord = lockfile.packages?.[''];
  if (!rootRecord || typeof rootRecord !== 'object') {
    throw policyError('package-lock.json has no root package record');
  }
  validateOnlyApprovedPrivateDependency(rootRecord, 'package-lock.json root');

  const lockedRootVersion = rootRecord.devDependencies?.[PRIVATE_PACKAGE_NAME];
  const packageRecord = lockfile.packages?.[PRIVATE_PACKAGE_LOCK_PATH];
  validateLockfilePackageRecords(lockfile);

  if (allowMissingLockEntry && !lockedRootVersion && !packageRecord) {
    return;
  }
  if (lockedRootVersion !== PRIVATE_PACKAGE_VERSION) {
    throw policyError(
      `package-lock.json must pin ${PRIVATE_PACKAGE_SPEC} in root devDependencies`
    );
  }

  validateApprovedPackageRecord(packageRecord);
}

function normalizeOption(argument) {
  return argument
    .split('=', 1)[0]
    .toLowerCase()
    .replace(/^--?/, '')
    .replace(/^no-/, '');
}

function validateAuthenticatedCommand(args) {
  if (!ALLOWED_COMMANDS.has(args[0])) {
    throw policyError(
      'only npm install and dependency mutation commands are allowed'
    );
  }
  if (args[0] === 'audit' && args[1] !== 'fix') {
    throw policyError(
      'npm audit may authenticate only when applying audit fixes'
    );
  }
}

function validatePrivatePackageSpecs(command, argument) {
  const privateSpecs =
    argument.match(
      /@6529-collections\/[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?/g
    ) ?? [];
  if (command === 'uninstall' && privateSpecs.length > 0) {
    throw policyError(
      `${PRIVATE_PACKAGE_SPEC} is pinned by repository policy and cannot be removed`
    );
  }
  for (const packageSpec of privateSpecs) {
    if (packageSpec !== PRIVATE_PACKAGE_SPEC) {
      throw policyError(
        `only ${PRIVATE_PACKAGE_SPEC} may use private package routing`
      );
    }
  }
}

function validateNpmOption(argument) {
  if (!argument.startsWith('-')) {
    return;
  }
  const option = normalizeOption(argument);
  if (
    FORBIDDEN_OPTION_FRAGMENTS.some((fragment) => option.includes(fragment))
  ) {
    throw policyError(
      `npm option is not allowed during authenticated install: ${argument}`
    );
  }
}

function validateArgument(command, argument) {
  if (argument.includes('npm.pkg.github.com')) {
    throw policyError(
      'private registry URLs cannot be supplied on the command line'
    );
  }
  validatePrivatePackageSpecs(command, argument);
  validateNpmOption(argument);
}

function validateArguments(args) {
  validateAuthenticatedCommand(args);
  for (const argument of args) {
    validateArgument(args[0], argument);
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw policyError(
      `${AUTH_VARIABLE} is required for the private root dependency install`
    );
  }
  if (token.trim() !== token || /\s/.test(token)) {
    throw policyError(`${AUTH_VARIABLE} has an invalid value`);
  }
  return token;
}

function tokenEnvironmentKeys(environment) {
  return Object.keys(environment).filter(
    (key) => key.toLowerCase() === AUTH_VARIABLE.toLowerCase()
  );
}

function environmentFlagEnabled(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return !['', '0', 'false', 'no', 'off'].includes(normalized);
}

function isCi(environment) {
  return (
    environmentFlagEnabled(environment.CI) ||
    environmentFlagEnabled(environment.GITHUB_ACTIONS)
  );
}

function parseGhScopes(output) {
  const scopesLine = output
    .split(/\r?\n/)
    .find((line) => /Token scopes:/i.test(line));
  if (!scopesLine) {
    return [];
  }
  return scopesLine
    .replace(/^.*Token scopes:\s*/i, '')
    .split(',')
    .map((scope) => scope.replace(/[\s'"]/g, ''))
    .filter(Boolean);
}

function resolveAuthenticationToken({
  environment = process.env,
  spawn = spawnSync
} = {}) {
  const tokenKeys = tokenEnvironmentKeys(environment);
  if (
    tokenKeys.length > 1 ||
    (tokenKeys.length === 1 && tokenKeys[0] !== AUTH_VARIABLE)
  ) {
    throw policyError(
      `${AUTH_VARIABLE} must use its exact environment-variable spelling`
    );
  }
  if (tokenKeys.length === 1) {
    return validateToken(environment[AUTH_VARIABLE]);
  }
  if (isCi(environment)) {
    throw policyError(
      `CI is non-interactive; provide ${AUTH_VARIABLE} only on the root install step`
    );
  }

  const status = spawn('gh', ['auth', 'status', '--hostname', 'github.com'], {
    encoding: 'utf8',
    env: sanitizeEnvironment(environment),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const scopes = parseGhScopes(
    `${status.stdout ?? ''}\n${status.stderr ?? ''}`
  );
  if (
    status.error ||
    status.status !== 0 ||
    !scopes.includes('read:packages')
  ) {
    throw policyError(
      `no reusable GitHub CLI token with read:packages was found; provide ${AUTH_VARIABLE}`
    );
  }

  const tokenResult = spawn(
    'gh',
    ['auth', 'token', '--hostname', 'github.com'],
    {
      encoding: 'utf8',
      env: sanitizeEnvironment(environment),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  if (tokenResult.error || tokenResult.status !== 0) {
    throw policyError('GitHub CLI could not provide its authenticated token');
  }
  return validateToken(String(tokenResult.stdout ?? '').trim());
}

function sanitizeEnvironment(environment) {
  const sanitized = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toLowerCase();
    if (
      normalized === AUTH_VARIABLE.toLowerCase() ||
      normalized.startsWith('npm_config_')
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function redact(value, token) {
  return String(value ?? '')
    .split(token)
    .join('[redacted]');
}

function emitResult(result, token, output) {
  output.stdout(redact(result.stdout, token));
  output.stderr(redact(result.stderr, token));
}

function runPrivatePackageCommand({
  args,
  corepackPath,
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  spawn = spawnSync,
  output = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value)
  }
}) {
  if (!path.isAbsolute(corepackPath)) {
    throw policyError('the Corepack executable must use an absolute path');
  }
  validateArguments(args);
  const isApprovedInitialAdd =
    args[0] === 'install' && args.includes(PRIVATE_PACKAGE_SPEC);
  validateRepositoryPolicy(repositoryRoot, {
    allowMissingLockEntry: isApprovedInitialAdd
  });
  const token = resolveAuthenticationToken({ environment, spawn });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), '6529-private-npm-')
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const userConfigPath = path.join(temporaryDirectory, 'user.npmrc');
  const globalConfigPath = path.join(temporaryDirectory, 'global.npmrc');
  const scriptShellPath = path.join(temporaryDirectory, 'token-free-shell');
  fs.writeFileSync(userConfigPath, buildPrivateNpmrc(), { mode: 0o600 });
  fs.writeFileSync(globalConfigPath, '', { mode: 0o600 });
  fs.writeFileSync(scriptShellPath, buildTokenFreeScriptShell(), {
    mode: 0o700
  });

  try {
    const baseEnvironment = sanitizeEnvironment(environment);
    const installEnvironment = {
      ...baseEnvironment,
      [AUTH_VARIABLE]: token,
      NPM_CONFIG_GLOBALCONFIG: globalConfigPath,
      NPM_CONFIG_SCRIPT_SHELL: scriptShellPath,
      NPM_CONFIG_USERCONFIG: userConfigPath
    };
    const installResult = spawn(corepackPath, ['npm', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: installEnvironment,
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    emitResult(installResult, token, output);
    if (installResult.error) {
      throw installResult.error;
    }
    if (installResult.status !== 0) {
      return installResult.status ?? 1;
    }

    // This strict post-install check is the authoritative guard for every
    // manifest and lockfile mutation, including the initial approved add.
    validateRepositoryPolicy(repositoryRoot);
    return 0;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  const [corepackPath, separator, ...args] = process.argv.slice(2);
  if (!corepackPath || separator !== '--' || args.length === 0) {
    console.error(
      'Usage: node scripts/private-github-packages.cjs <corepack-path> -- <npm-args...>'
    );
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = runPrivatePackageCommand({ args, corepackPath });
  } catch (error) {
    const suppliedToken = process.env[AUTH_VARIABLE];
    const message = error instanceof Error ? error.message : String(error);
    console.error(suppliedToken ? redact(message, suppliedToken) : message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  AUTH_PLACEHOLDER,
  AUTH_VARIABLE,
  PRIVATE_INTEGRITY,
  PRIVATE_PACKAGE_NAME,
  PRIVATE_PACKAGE_SPEC,
  PRIVATE_PACKAGE_VERSION,
  PRIVATE_REGISTRY,
  PRIVATE_TARBALL,
  REPOSITORY_ROOT,
  buildPrivateNpmrc,
  buildTokenFreeScriptShell,
  parseGhScopes,
  redact,
  resolveAuthenticationToken,
  runPrivatePackageCommand,
  sanitizeEnvironment,
  validateArguments,
  validateRepositoryPolicy
};
