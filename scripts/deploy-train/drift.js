'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalogLib = require('./catalog');
const gitLib = require('./git');
const artifact = require('./artifact');
const bundles = require('./bundles');

const PULL_REQUEST_PATTERNS = [
  /^Merge pull request #(\d+)\b/,
  /\(#(\d+)\)\s*$/
];
const DB_MODULES = ['src/db.ts', 'src/db-api.ts'];

function pullRequestFromSubject(subject) {
  for (const pattern of PULL_REQUEST_PATTERNS) {
    const match = pattern.exec(subject || '');
    if (match) return Number(match[1]);
  }
  return null;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Cached read access to one commit's files. */
function createCommitReader(repoRoot, sha, shared) {
  const tree = gitLib.readTree(repoRoot, sha);
  const readText = (file) => {
    const oid = tree.oid(file);
    if (!oid || tree.type(file) !== 'blob') return null;
    if (!shared.text.has(oid)) {
      shared.text.set(oid, gitLib.readBlob(repoRoot, oid));
    }
    return shared.text.get(oid);
  };
  const readJson = (file) => {
    const oid = tree.oid(file);
    if (!oid) return null;
    if (!shared.json.has(oid)) {
      const text = readText(file);
      shared.json.set(oid, text === null ? null : JSON.parse(text));
    }
    return shared.json.get(oid);
  };
  let workflow;
  const reader = {
    sha,
    tree,
    readText,
    readJson,
    workflow() {
      if (workflow === undefined) {
        const text = readText('.github/workflows/deploy.yml');
        workflow = text ? shared.parseYaml(text) : null;
      }
      return workflow;
    },
    catalogService(name) {
      const config = readJson('src/config/deploy-services.json');
      const services = (config && config.services) || [];
      return services.find((service) => service.name === name) || null;
    },
    buildSpec(name) {
      const packageJson = readJson(
        `${catalogLib.serviceDirectory(name)}/package.json`
      );
      return packageJson ? artifact.parseBuildSpec(packageJson, name) : null;
    },
    side(name) {
      return {
        tree,
        readText,
        readJson,
        workflow: reader.workflow(),
        catalogService: reader.catalogService(name)
      };
    }
  };
  return reader;
}

function specKey(spec, reader, name) {
  if (spec.bundle.kind === 'esbuild-config') {
    const file = `${catalogLib.serviceDirectory(name)}/${spec.bundle.configFile}`;
    return gitLib.hashText(`config ${reader.tree.oid(file)}`);
  }
  return gitLib.hashText(JSON.stringify(spec.bundle.options || null));
}

function versionOf(summary) {
  return summary === 'missing' ? 'absent' : summary.split(' ')[0];
}

/** Bundled packages whose locked version or integrity differs. */
function packageChanges(deployedEntry, targetEntry, deployed, target) {
  const reasons = [];
  const paths = new Set();
  const items = new Set(deployedEntry.packages.concat(targetEntry.packages));
  const lockUnchanged = (lockPath) =>
    deployed.tree.oid(lockPath) === target.tree.oid(lockPath);
  for (const item of Array.from(items).sort(catalogLib.compareText)) {
    const [owner, key] = item.split('\t');
    const lockPath = owner ? `${owner}/package-lock.json` : 'package-lock.json';
    if (lockUnchanged(lockPath)) continue;
    const before = artifact.lockSummary(deployed.readJson(lockPath), key);
    const after = artifact.lockSummary(target.readJson(lockPath), key);
    if (before === after) continue;
    reasons.push(
      `dependency ${key.replace(/^node_modules\//, '')} ${versionOf(before)} -> ${versionOf(after)}`
    );
    paths.add(lockPath);
  }
  return { reasons, paths: Array.from(paths) };
}

function changedSources(deployedEntry, targetEntry, deployed, target) {
  const all = new Set(deployedEntry.sources.concat(targetEntry.sources));
  return Array.from(all)
    .filter((file) => deployed.tree.oid(file) !== target.tree.oid(file))
    .sort(catalogLib.compareText);
}

/**
 * Compares each service's deployable artifact at its deployed commit with
 * the target commit and reports which services would change, why, since
 * when, and through which pull requests.
 */
async function computeDrift(options) {
  const {
    repoRoot,
    environment,
    targetSha,
    deployed,
    cacheDir,
    concurrency = Math.max(2, os.cpus().length),
    now = Date.now(),
    services: serviceFilter = null,
    esbuild,
    parseYaml,
    lookupPullRequests = null,
    log = () => undefined
  } = options;
  const startedAt = Date.now();
  const shared = { text: new Map(), json: new Map(), parseYaml };
  const readers = new Map();
  const readerFor = (sha) => {
    if (!readers.has(sha)) {
      readers.set(sha, createCommitReader(repoRoot, sha, shared));
    }
    return readers.get(sha);
  };
  const target = readerFor(targetSha);
  const catalog = catalogLib.loadCatalog(
    target.readJson('src/config/deploy-services.json')
  );
  const services = catalogLib
    .servicesForEnvironment(catalog, environment)
    .filter((service) => !serviceFilter || serviceFilter.has(service.name));
  const roots = bundles.nodeModulesRoots(repoRoot);
  const envKey = bundles.environmentKey(repoRoot, roots, esbuild.version);
  const cache = new bundles.BundleCache(path.join(cacheDir, 'bundles'));
  const treesDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'deploy-drift-trees-')
  );
  const bundler = bundles.createBundler({ repoRoot, treesDir, esbuild, roots });
  const stats = { builds: 0, cache_hits: 0, reused_target_bundle: 0 };
  const entries = new Map();
  const changesByBase = new Map();

  const entryFor = (name, spec, reader) => {
    const key = `${name}@${reader.sha}`;
    if (!entries.has(key)) {
      entries.set(
        key,
        (async () => {
          const keyOfSpec = specKey(spec, reader, name);
          const cached = cache.find(name, keyOfSpec, envKey, reader.tree);
          if (cached) {
            stats.cache_hits += 1;
            return cached;
          }
          stats.builds += 1;
          log(`building ${name} at ${reader.sha.slice(0, 10)}`);
          const built = await bundler.build(name, spec, reader.sha);
          const entry = {
            format: bundles.CACHE_FORMAT,
            service: name,
            specKey: keyOfSpec,
            envKey,
            builtAt: reader.sha,
            bundleSha256: built.bundleSha256,
            bytes: built.bytes,
            sources: built.sources,
            packages: built.packages,
            ...bundles.validityFor(built.sources, reader.tree)
          };
          cache.store(name, entry);
          return entry;
        })()
      );
    }
    return entries.get(key);
  };

  const changesSince = (base) => {
    if (!changesByBase.has(base)) {
      changesByBase.set(
        base,
        gitLib.firstParentChanges(repoRoot, base, targetSha)
      );
    }
    return changesByBase.get(base);
  };

  async function attribute(record, base, paths) {
    const commits = changesSince(base);
    const exact = new Set(paths);
    const prefixes = paths.filter((item) => target.tree.type(item) === 'tree');
    const touches = (file) =>
      exact.has(file) ||
      prefixes.some((prefix) => file.startsWith(`${prefix}/`));
    const touching = commits.filter((commit) => commit.files.some(touches));
    const pulls = new Set();
    const unattributed = [];
    for (const commit of touching) {
      const number = pullRequestFromSubject(commit.subject);
      if (number) {
        pulls.add(number);
        continue;
      }
      const looked = lookupPullRequests
        ? await lookupPullRequests(commit.sha)
        : [];
      if (looked.length > 0) looked.forEach((pull) => pulls.add(pull));
      else unattributed.push(commit.sha);
    }
    const dated = touching.length > 0 ? touching : commits;
    record.commits = touching.length;
    record.prs = Array.from(pulls).sort((left, right) => left - right);
    record.unattributed_commits = unattributed;
    record.behind_since =
      dated.length > 0
        ? dated[dated.length - 1].date
        : record.deployed.completed_at;
    record.attribution = touching.length > 0 ? 'paths' : 'range';
  }

  async function compareBundles(
    record,
    name,
    targetSpec,
    deployedSpec,
    base,
    paths
  ) {
    if (
      targetSpec.bundle.kind === 'none' &&
      deployedSpec.bundle.kind === 'none'
    ) {
      return;
    }
    if (targetSpec.bundle.kind !== deployedSpec.bundle.kind) {
      record.reasons.push('build changed (esbuild invocation differs)');
      return;
    }
    const targetEntry = await entryFor(name, targetSpec, target);
    let deployedEntry = targetEntry;
    if (
      specKey(deployedSpec, base, name) !== targetEntry.specKey ||
      !bundles.isValidFor(targetEntry, base.tree)
    ) {
      try {
        deployedEntry = await entryFor(name, deployedSpec, base);
      } catch (error) {
        record.reasons.push(
          `deployed bundle could not be rebuilt: ${error.message}`
        );
        return;
      }
    } else {
      stats.reused_target_bundle += 1;
    }
    if (deployedEntry.bundleSha256 !== targetEntry.bundleSha256) {
      const changed = changedSources(deployedEntry, targetEntry, base, target);
      record.reasons.push(
        `bundle changed (${changed.length} bundled source file${changed.length === 1 ? '' : 's'} differ)`
      );
      paths.push(...changed);
    }
    const dependencies = packageChanges(
      deployedEntry,
      targetEntry,
      base,
      target
    );
    record.reasons.push(...dependencies.reasons);
    paths.push(...dependencies.paths);
  }

  async function analyze(service) {
    const name = service.name;
    const info = deployed.get(name) || null;
    const record = {
      service: name,
      status: 'current',
      deployed: info,
      reasons: [],
      commits: 0,
      prs: [],
      unattributed_commits: [],
      behind_since: null,
      attribution: null,
      expects_db_auth: false,
      train: catalogLib.trainSettings(service)
    };
    const targetSpec = target.buildSpec(name);
    if (!targetSpec)
      throw new Error(`${name} has no package.json at the target`);
    if (targetSpec.bundle.kind !== 'none') {
      const targetEntry = await entryFor(name, targetSpec, target);
      record.expects_db_auth = targetEntry.sources.some((file) =>
        DB_MODULES.includes(file)
      );
    }
    if (!info) {
      record.status = 'never-deployed';
      return record;
    }
    if (info.sha === targetSha) return record;
    if (!gitLib.hasCommit(repoRoot, info.sha)) {
      record.status = 'behind';
      record.reasons.push(
        `deployed commit ${info.sha.slice(0, 10)} is not in this clone`
      );
      record.behind_since = info.completed_at;
      return record;
    }
    if (gitLib.isAncestor(repoRoot, targetSha, info.sha)) {
      record.status = 'ahead';
      record.reasons.push('deployed commit is newer than the target');
      return record;
    }
    const base = readerFor(info.sha);
    const deployedSpec = base.buildSpec(name) || {
      bundle: { kind: 'none' },
      copies: []
    };
    const components = artifact.compareComponents(
      artifact.collectComponents(
        name,
        environment,
        deployedSpec,
        base.side(name)
      ),
      artifact.collectComponents(
        name,
        environment,
        targetSpec,
        target.side(name)
      )
    );
    record.reasons.push(...components.reasons);
    const paths = components.paths.slice();
    await compareBundles(record, name, targetSpec, deployedSpec, base, paths);
    if (record.reasons.length > 0) {
      record.status = 'behind';
      await attribute(record, info.sha, paths);
    }
    return record;
  }

  try {
    const targetSpecs = services.map((service) => [
      service,
      target.buildSpec(service.name)
    ]);
    // Build every target bundle first; a failure here is reported per
    // service when analyze() awaits the same entry again.
    await mapLimit(targetSpecs, concurrency, async ([service, spec]) => {
      if (spec && spec.bundle.kind !== 'none') {
        await entryFor(service.name, spec, target).catch(() => undefined);
      }
    });
    const records = await mapLimit(services, concurrency, async (service) => {
      try {
        return await analyze(service);
      } catch (error) {
        return {
          service: service.name,
          status: 'error',
          deployed: deployed.get(service.name) || null,
          reasons: [error instanceof Error ? error.message : String(error)],
          commits: 0,
          prs: [],
          unattributed_commits: [],
          behind_since: null,
          attribution: null,
          expects_db_auth: false,
          train: catalogLib.trainSettings(service)
        };
      }
    });
    const byName = new Map(records.map((record) => [record.service, record]));
    const order = catalogLib.dependencyOrder(
      catalog,
      records.map((record) => record.service),
      (name) => {
        const since = byName.get(name).behind_since;
        return [since ? Date.parse(since) : Number.MAX_SAFE_INTEGER];
      }
    );
    return {
      environment,
      target_sha: targetSha,
      target_committed_at: gitLib.commitDate(repoRoot, targetSha),
      generated_at: new Date(now).toISOString(),
      stats: {
        services: records.length,
        ...stats,
        seconds: Math.round((Date.now() - startedAt) / 1000)
      },
      services: order.map((name) => byName.get(name))
    };
  } finally {
    bundler.cleanup();
    cache.prune();
  }
}

module.exports = {
  pullRequestFromSubject,
  mapLimit,
  createCommitReader,
  specKey,
  packageChanges,
  computeDrift
};
