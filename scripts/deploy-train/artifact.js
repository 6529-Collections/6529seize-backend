'use strict';

const path = require('node:path');
const { compareText, serviceDirectory } = require('./catalog');
const { hashText } = require('./git');

const SERVERLESS_ADAPTERS = ['serverless', 'resources-only'];
const ESBUILD_IGNORED_FLAGS = [
  '--sourcemap',
  '--outfile=',
  '--outdir=',
  '--metafile=',
  '--log-level='
];

/** Splits an npm script into commands joined by `&&`, honouring quotes. */
function splitCommands(script) {
  const commands = [];
  let current = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) current.push(word);
    word = null;
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word = word ?? '';
    } else if (char === '&' && script[index + 1] === '&') {
      endWord();
      commands.push(current);
      current = [];
      index += 1;
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quote) throw new Error(`Unterminated quote in script: ${script}`);
  endWord();
  commands.push(current);
  return commands.filter((command) => command.length > 0);
}

function splitList(value) {
  return value.split(',').filter(Boolean);
}

function applyKeyValueFlag(options, field, body, flag) {
  const separator = body.indexOf('=');
  if (separator <= 0) throw new Error(`Malformed esbuild flag ${flag}`);
  options[field] = options[field] || {};
  options[field][body.slice(0, separator)] = body.slice(separator + 1);
}

const VALUE_FLAGS = {
  '--platform=': (options, value) => (options.platform = value),
  '--target=': (options, value) => (options.target = splitList(value)),
  '--format=': (options, value) => (options.format = value),
  '--packages=': (options, value) => (options.packages = value),
  '--main-fields=': (options, value) => (options.mainFields = splitList(value)),
  '--conditions=': (options, value) => (options.conditions = splitList(value)),
  '--tsconfig=': (options, value) => (options.tsconfig = value),
  '--external:': (options, value) => options.external.push(value),
  '--loader:': (options, value, flag) =>
    applyKeyValueFlag(options, 'loader', value, flag),
  '--define:': (options, value, flag) =>
    applyKeyValueFlag(options, 'define', value, flag)
};
const BOOLEAN_FLAGS = {
  '--bundle': 'bundle',
  '--minify': 'minify',
  '--keep-names': 'keepNames'
};

/**
 * Translates the esbuild CLI arguments of a service build into JS API
 * options. Output, source-map and metafile flags are dropped because the
 * drift tool builds both sides in memory with identical settings. Unknown
 * flags fail loudly so a new build option cannot be silently ignored.
 */
function esbuildOptionsFromArgs(args) {
  const options = { entryPoints: [], external: [] };
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      options.entryPoints.push(arg);
      continue;
    }
    if (ESBUILD_IGNORED_FLAGS.some((flag) => arg.startsWith(flag))) continue;
    if (BOOLEAN_FLAGS[arg]) {
      options[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }
    const prefix = Object.keys(VALUE_FLAGS).find((flag) =>
      arg.startsWith(flag)
    );
    if (!prefix) throw new Error(`Unsupported esbuild flag ${arg}`);
    VALUE_FLAGS[prefix](options, arg.slice(prefix.length), arg);
  }
  if (options.entryPoints.length === 0) {
    throw new Error('esbuild command has no entry point');
  }
  if (options.external.length === 0) delete options.external;
  return options;
}

/** Lockfile key for a file inside a node_modules directory. */
function packageKeyFromNodeModulesPath(relativePath) {
  const segments = relativePath.split('/').filter(Boolean);
  const parts = [];
  let index = 0;
  while (index < segments.length) {
    const width = segments[index].startsWith('@') ? 2 : 1;
    parts.push(segments.slice(index, index + width).join('/'));
    index += width;
    if (segments[index] !== 'node_modules') break;
    index += 1;
  }
  return `node_modules/${parts.join('/node_modules/')}`;
}

function classifyCopySource(source, serviceDir) {
  const clean = source.replace(/\/\*[^/]*$/, '').replace(/\/+$/, '');
  if (clean === 'dist' || clean.startsWith('dist/')) return null;
  if (clean === 'node_modules') return { kind: 'service-node-modules' };
  if (clean.startsWith('node_modules/')) {
    return {
      kind: 'package',
      key: packageKeyFromNodeModulesPath(clean.slice('node_modules/'.length))
    };
  }
  const repoPath = path.posix.normalize(path.posix.join(serviceDir, clean));
  if (repoPath.startsWith('..')) {
    throw new Error(`Copy source ${source} leaves the repository`);
  }
  return { kind: 'file', path: repoPath };
}

/**
 * Reads how a service is built from its package.json scripts: the esbuild
 * invocation (CLI flags or an esbuild config module) and the files that
 * build or postbuild copy into the deployed artifact.
 */
function parseBuildSpec(packageJson, serviceName) {
  const scripts = (packageJson && packageJson.scripts) || {};
  const serviceDir = serviceDirectory(serviceName);
  const commands = splitCommands(scripts.build || '');
  let bundle = { kind: 'none' };
  for (const argv of commands) {
    if (argv[0] === 'esbuild') {
      bundle = {
        kind: 'esbuild-cli',
        options: esbuildOptionsFromArgs(argv.slice(1))
      };
      break;
    }
    if (argv[0] === 'node' && /esbuild\.config\.m?js$/.test(argv[1] || '')) {
      bundle = { kind: 'esbuild-config', configFile: argv[1] };
      break;
    }
  }
  const copies = [];
  for (const argv of commands.concat(splitCommands(scripts.postbuild || ''))) {
    if (argv[0] !== 'cp') continue;
    const operands = argv.slice(1).filter((arg) => !arg.startsWith('-'));
    for (const source of operands.slice(0, -1)) {
      const copy = classifyCopySource(source, serviceDir);
      if (copy) copies.push(copy);
    }
  }
  return { bundle, copies };
}

function lockSummary(lock, key) {
  const entry = lock && lock.packages && lock.packages[key];
  if (!entry) return 'missing';
  return `${entry.version || '?'} ${entry.integrity || entry.resolved || ''}`.trim();
}

function lockVersion(lock, key) {
  const entry = lock && lock.packages && lock.packages[key];
  return entry ? entry.version || '?' : null;
}

function serverlessUsesWorkflowEnv(yamlText) {
  return /\$\{env:(?!VERSION_DESCRIPTION\}|SENTRY_DSN\})/.test(yamlText || '');
}

function adapterStepNames(service, needsWorkflowEnv) {
  const steps = [];
  if (service.deploy_adapter === 'api-zip' || needsWorkflowEnv) {
    steps.push('Select environment-specific config');
  }
  if (SERVERLESS_ADAPTERS.includes(service.deploy_adapter)) {
    steps.push('Deploy service');
  } else if (service.deploy_adapter === 'api-zip') {
    steps.push('Deploy API');
  } else {
    steps.push(`Deploy ${service.name}`);
  }
  return steps;
}

/**
 * Fingerprint of how the deploy workflow ships the service: the catalog
 * fields that shape the deployment plus the workflow steps that run it.
 */
function adapterFingerprint(service, environment, workflow, needsWorkflowEnv) {
  if (!service) return 'missing';
  const steps =
    (workflow &&
      workflow.jobs &&
      workflow.jobs['build-and-deploy'] &&
      workflow.jobs['build-and-deploy'].steps) ||
    [];
  const stepRun = (name) => {
    const step = steps.find((candidate) => candidate.name === name);
    return step ? step.run || step.uses || '' : 'missing';
  };
  const workflowEnv =
    service.deploy_adapter === 'api-zip' || needsWorkflowEnv
      ? (workflow && workflow.env) || null
      : null;
  return hashText(
    JSON.stringify({
      adapter: service.deploy_adapter,
      region: service.aws_region && service.aws_region[environment],
      memory: service.memory_size ?? null,
      steps: adapterStepNames(service, needsWorkflowEnv).map((name) => [
        name,
        stepRun(name)
      ]),
      env: workflowEnv
    })
  );
}

function isServiceFile(name, adapter) {
  if (adapter === 'api-zip') {
    return ['package.json', 'package-lock.json', 'esbuild.config.mjs'].includes(
      name
    );
  }
  return !/\.(ts|md)$/.test(name);
}

/**
 * Everything besides the bundle that the deployed artifact or its deploy
 * step depends on, as comparable `{ name, value, paths }` components.
 * `side` gives read access to one commit: `tree`, `readText(path)`,
 * `readJson(path)`, the parsed deploy workflow and the catalog entry.
 */
function collectComponents(serviceName, environment, spec, side) {
  const service = side.catalogService;
  const dir = serviceDirectory(serviceName);
  const adapter = service ? service.deploy_adapter : 'missing';
  const components = [];
  const add = (name, value, paths) => components.push({ name, value, paths });
  for (const child of side.tree.children(dir)) {
    if (child.type !== 'blob' || !isServiceFile(child.name, adapter)) continue;
    const filePath = `${dir}/${child.name}`;
    add(`file ${filePath}`, side.tree.oid(filePath), [filePath]);
  }
  const serviceLockPath = `${dir}/package-lock.json`;
  const serviceLock = side.readJson(serviceLockPath);
  const rootLock = side.readJson('package-lock.json');
  for (const copy of spec.copies) {
    if (copy.kind === 'file') {
      add(`copied ${copy.path}`, side.tree.oid(copy.path) || 'missing', [
        copy.path
      ]);
    } else if (copy.kind === 'package') {
      const lock = serviceLock || rootLock;
      add(`copied package ${copy.key}`, lockSummary(lock, copy.key), [
        serviceLock ? serviceLockPath : 'package-lock.json'
      ]);
    }
  }
  const yamlText = side.readText(`${dir}/serverless.yaml`);
  const needsWorkflowEnv =
    SERVERLESS_ADAPTERS.includes(adapter) &&
    serverlessUsesWorkflowEnv(yamlText);
  if (
    SERVERLESS_ADAPTERS.includes(adapter) &&
    /serverless-config\//.test(yamlText || '')
  ) {
    const configPath = `serverless-config/${environment}`;
    add(configPath, side.tree.oid(configPath) || 'missing', [configPath]);
  }
  add(
    'deploy adapter',
    adapterFingerprint(service, environment, side.workflow, needsWorkflowEnv),
    ['src/config/deploy-services.json', '.github/workflows/deploy.yml']
  );
  if (spec.bundle.kind !== 'none') {
    const esbuildVersion =
      lockVersion(serviceLock, 'node_modules/esbuild') ||
      lockVersion(rootLock, 'node_modules/esbuild');
    add('esbuild version', esbuildVersion || 'missing', [
      serviceLockPath,
      'package-lock.json'
    ]);
  }
  if (SERVERLESS_ADAPTERS.includes(adapter)) {
    add(
      'serverless version',
      lockVersion(rootLock, 'node_modules/serverless') || 'missing',
      ['package-lock.json']
    );
  }
  return components;
}

/** Human-readable differences between two component lists. */
function compareComponents(deployed, target) {
  const byName = (list) => new Map(list.map((item) => [item.name, item]));
  const before = byName(deployed);
  const after = byName(target);
  const reasons = [];
  const paths = new Set();
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of Array.from(names).sort(compareText)) {
    const old = before.get(name);
    const next = after.get(name);
    if (old && next && old.value === next.value) continue;
    let reason;
    if (!old) reason = `${name} added`;
    else if (!next) reason = `${name} removed`;
    else if (/version$/.test(name))
      reason = `${name} ${old.value} -> ${next.value}`;
    else reason = `${name} changed`;
    reasons.push(reason);
    for (const item of [old, next]) {
      for (const changedPath of (item && item.paths) || []) {
        paths.add(changedPath);
      }
    }
  }
  return { reasons, paths: Array.from(paths) };
}

module.exports = {
  SERVERLESS_ADAPTERS,
  splitCommands,
  esbuildOptionsFromArgs,
  packageKeyFromNodeModulesPath,
  classifyCopySource,
  parseBuildSpec,
  lockSummary,
  lockVersion,
  serverlessUsesWorkflowEnv,
  adapterStepNames,
  adapterFingerprint,
  collectComponents,
  compareComponents
};
