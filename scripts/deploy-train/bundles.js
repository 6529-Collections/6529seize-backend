'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { compareText, serviceDirectory } = require('./catalog');
const { extractTree, hashText } = require('./git');
const { packageKeyFromNodeModulesPath } = require('./artifact');

const CACHE_FORMAT = 1;
const TREE_PATHS = ['src', 'package.json', 'tsconfig.json'];
const CONFIG_FILE = /^(?:package\.json|tsconfig(?:\.[^/]+)?\.json)$/;
const CAPTURE_SHIM = path.join(__dirname, 'esbuild-capture.mjs');
const DAY_MS = 24 * 60 * 60 * 1000;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

/**
 * node_modules directories the builds resolve packages from, most specific
 * first, with the lockfile that describes each one.
 */
function nodeModulesRoots(repoRoot) {
  const roots = [];
  for (const owner of ['src/api-serverless', '']) {
    const link = owner ? `${owner}/node_modules` : 'node_modules';
    const dir = path.join(repoRoot, link);
    if (!fs.existsSync(dir)) continue;
    roots.push({
      owner,
      link,
      dir: fs.realpathSync(dir),
      lockPath: owner ? `${owner}/package-lock.json` : 'package-lock.json'
    });
  }
  return roots;
}

/**
 * Identifies the build environment. Cached bundles are reused only when the
 * installed packages, esbuild version and platform match.
 */
function environmentKey(repoRoot, roots, esbuildVersion) {
  return hashText(
    JSON.stringify({
      format: CACHE_FORMAT,
      platform: process.platform,
      esbuild: esbuildVersion,
      locks: roots.map((root) => [
        root.owner,
        hashText(fs.readFileSync(path.join(repoRoot, root.lockPath)))
      ])
    })
  );
}

/**
 * What a cached bundle depends on in its source tree: the object ID of every
 * bundled source and of each package.json or tsconfig*.json beside them, and
 * the listing of each directory on their paths. If all of these match in
 * another commit, esbuild resolves and emits the same bundle there.
 */
function parentDirectory(file) {
  const dir = path.posix.dirname(file);
  return dir === '.' ? '' : dir;
}

/** Records one directory's listing and the config files directly in it. */
function recordDirectory(dir, tree, inputs, dirs) {
  dirs[dir] = tree.listingHash(dir);
  for (const child of tree.children(dir)) {
    if (child.type === 'blob' && CONFIG_FILE.test(child.name)) {
      const configPath = dir ? `${dir}/${child.name}` : child.name;
      inputs[configPath] = tree.oid(configPath);
    }
  }
}

function validityFor(sources, tree) {
  const inputs = {};
  const dirs = {};
  for (const source of sources) {
    inputs[source] = tree.oid(source);
    let dir = parentDirectory(source);
    while (!(dir in dirs)) {
      recordDirectory(dir, tree, inputs, dirs);
      if (!dir) break;
      dir = parentDirectory(dir);
    }
  }
  return { inputs, dirs };
}

function isValidFor(entry, tree) {
  for (const [file, oid] of Object.entries(entry.inputs)) {
    if (tree.oid(file) !== oid) return false;
  }
  for (const [dir, listing] of Object.entries(entry.dirs)) {
    if (tree.listingHash(dir) !== listing) return false;
  }
  return true;
}

/** A cache file's entry; unreadable or outdated files are dropped. */
function readCacheEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (entry.format === CACHE_FORMAT) return { file, entry };
  } catch {
    // Fall through: a corrupt entry is removed and rebuilt.
  }
  fs.rmSync(file, { force: true });
  return null;
}

/** File cache of built bundle fingerprints, one directory per service. */
class BundleCache {
  constructor(dir, { maxEntriesPerService = 40, maxAgeDays = 21 } = {}) {
    this.dir = dir;
    this.maxEntriesPerService = maxEntriesPerService;
    this.maxAgeDays = maxAgeDays;
    this.loaded = new Map();
  }

  serviceDir(service) {
    return path.join(this.dir, service);
  }

  entries(service) {
    if (!this.loaded.has(service)) {
      const dir = this.serviceDir(service);
      const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const entries = names
        .filter((name) => name.endsWith('.json'))
        .sort(compareText)
        .map((name) => readCacheEntry(path.join(dir, name)))
        .filter(Boolean);
      this.loaded.set(service, entries);
    }
    return this.loaded.get(service);
  }

  find(service, specKey, envKey, tree) {
    for (const { file, entry } of this.entries(service)) {
      if (entry.specKey !== specKey || entry.envKey !== envKey) continue;
      if (!isValidFor(entry, tree)) continue;
      const now = new Date();
      fs.utimesSync(file, now, now);
      return entry;
    }
    return null;
  }

  store(service, entry) {
    const dir = this.serviceDir(service);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${hashText(JSON.stringify([entry.specKey, entry.envKey, entry.builtAt])).slice(0, 24)}.json`
    );
    fs.writeFileSync(file, JSON.stringify(entry));
    this.entries(service).push({ file, entry });
  }

  /** Drops entries unused for `maxAgeDays` and caps each service. */
  prune(now = Date.now()) {
    if (!fs.existsSync(this.dir)) return;
    for (const service of fs.readdirSync(this.dir)) {
      const dir = this.serviceDir(service);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = fs
        .readdirSync(dir)
        .map((name) => {
          const file = path.join(dir, name);
          return { file, used: fs.statSync(file).mtimeMs };
        })
        .sort((left, right) => right.used - left.used);
      files.forEach(({ file, used }, index) => {
        if (
          index >= this.maxEntriesPerService ||
          now - used > this.maxAgeDays * DAY_MS
        ) {
          fs.rmSync(file, { force: true });
        }
      });
    }
  }
}

let captureQueue = Promise.resolve();
let captureCount = 0;

/**
 * Evaluates an esbuild config module with `esbuild` replaced by a recorder
 * and returns the options it passes to build(). Captures run one at a time
 * because the recorder is process-global.
 */
function captureConfigOptions(configPath) {
  const capture = async () => {
    const text = fs.readFileSync(configPath, 'utf8');
    const pattern = /from\s+(['"])esbuild\1/g;
    const imports = text.match(pattern) || [];
    if (imports.length !== 1) {
      throw new Error(`${configPath} must import esbuild exactly once`);
    }
    const patched = text.replace(
      pattern,
      `from ${JSON.stringify(pathToFileURL(CAPTURE_SHIM).href)}`
    );
    const temporary = path.join(
      path.dirname(configPath),
      `.deploy-train-capture-${process.pid}-${Date.now()}-${++captureCount}.mjs`
    );
    fs.writeFileSync(temporary, patched);
    globalThis.__deployTrainEsbuildCapture = [];
    try {
      await import(pathToFileURL(temporary).href);
      const captured = globalThis.__deployTrainEsbuildCapture;
      if (captured.length !== 1) {
        throw new Error(
          `${configPath} called esbuild.build ${captured.length} times; expected once`
        );
      }
      return captured[0];
    } finally {
      delete globalThis.__deployTrainEsbuildCapture;
      fs.rmSync(temporary, { force: true });
    }
  };
  const result = captureQueue.then(capture, capture);
  captureQueue = result.catch(() => undefined);
  return result;
}

function normalizeBundle(text, workDir, treeDir, roots) {
  const replacements = [];
  for (const root of roots) {
    const label = `<node_modules:${root.owner || 'root'}>`;
    replacements.push(
      [toPosix(path.relative(workDir, root.dir)), label],
      [root.dir, label],
      [toPosix(root.dir), label]
    );
  }
  replacements.push([treeDir, '<tree>'], [toPosix(treeDir), '<tree>']);
  replacements.sort((left, right) => right[0].length - left[0].length);
  let normalized = text;
  for (const [from, to] of replacements) {
    if (from) normalized = normalized.split(from).join(to);
  }
  return normalized;
}

function classifyInputs(metafile, workDir, treeDir, roots) {
  const sources = new Set();
  const packages = new Set();
  for (const key of Object.keys(metafile.inputs)) {
    if (/^[(<]/.test(key) || /^[a-z][a-z0-9-]+:(?![\\/])/i.test(key)) continue;
    const absolute = path.resolve(workDir, key);
    const root = roots.find(
      (candidate) =>
        isInside(absolute, candidate.dir) ||
        isInside(absolute, path.join(treeDir, candidate.link))
    );
    if (root) {
      const base = isInside(absolute, root.dir)
        ? root.dir
        : path.join(treeDir, root.link);
      packages.add(
        `${root.owner}\t${packageKeyFromNodeModulesPath(toPosix(path.relative(base, absolute)))}`
      );
    } else if (isInside(absolute, treeDir)) {
      sources.add(toPosix(path.relative(treeDir, absolute)));
    } else {
      throw new Error(`Bundle input ${key} is outside the tree and packages`);
    }
  }
  return {
    sources: Array.from(sources).sort(compareText),
    packages: Array.from(packages).sort(compareText)
  };
}

function describeBuildFailure(error) {
  const first = error && Array.isArray(error.errors) && error.errors[0];
  if (!first) return error instanceof Error ? error.message : String(error);
  const where = first.location
    ? ` (${first.location.file}:${first.location.line})`
    : '';
  return `${first.text}${where}`;
}

/**
 * Builds service bundles at any commit: extracts the commit's sources into
 * a scratch tree that shares the checkout's installed packages, then runs
 * the service's own esbuild options in memory.
 */
function createBundler({ repoRoot, treesDir, esbuild, roots }) {
  const trees = new Map();
  const links = [];

  function ensureTree(sha) {
    if (!trees.has(sha)) {
      trees.set(
        sha,
        (async () => {
          const dir = path.join(treesDir, sha.slice(0, 16));
          await extractTree(repoRoot, sha, dir, TREE_PATHS);
          for (const root of roots) {
            const linkPath = path.join(dir, root.link);
            if (
              fs.existsSync(path.dirname(linkPath)) &&
              !fs.existsSync(linkPath)
            ) {
              fs.symlinkSync(
                root.dir,
                linkPath,
                process.platform === 'win32' ? 'junction' : 'dir'
              );
              links.push(linkPath);
            }
          }
          return dir;
        })()
      );
    }
    return trees.get(sha);
  }

  async function build(serviceName, spec, sha) {
    const treeDir = await ensureTree(sha);
    const workDir = path.join(treeDir, serviceDirectory(serviceName));
    const base =
      spec.bundle.kind === 'esbuild-config'
        ? await captureConfigOptions(path.join(workDir, spec.bundle.configFile))
        : spec.bundle.options;
    const options = { ...base };
    for (const key of ['outdir', 'outfile', 'write', 'metafile', 'sourcemap']) {
      delete options[key];
    }
    let result;
    try {
      result = await esbuild.build({
        ...options,
        absWorkingDir: workDir,
        outfile: path.join(workDir, 'dist', 'index.js'),
        write: false,
        metafile: true,
        sourcemap: false,
        logLevel: 'silent'
      });
    } catch (error) {
      throw new Error(
        `esbuild failed for ${serviceName} at ${sha.slice(0, 10)}: ${describeBuildFailure(error)}`
      );
    }
    const outputs = result.outputFiles.filter((file) =>
      file.path.endsWith('.js')
    );
    if (outputs.length !== 1) {
      throw new Error(`${serviceName} produced ${outputs.length} JS outputs`);
    }
    const text = normalizeBundle(outputs[0].text, workDir, treeDir, roots);
    return {
      bundleSha256: hashText(text),
      bytes: Buffer.byteLength(text),
      ...classifyInputs(result.metafile, workDir, treeDir, roots)
    };
  }

  function cleanup() {
    for (const link of links)
      fs.rmSync(link, { force: true, recursive: false });
    fs.rmSync(treesDir, { recursive: true, force: true });
  }

  return { ensureTree, build, cleanup };
}

module.exports = {
  CACHE_FORMAT,
  TREE_PATHS,
  nodeModulesRoots,
  environmentKey,
  validityFor,
  isValidFor,
  BundleCache,
  captureConfigOptions,
  normalizeBundle,
  classifyInputs,
  createBundler
};
