import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const { computeDrift, pullRequestFromSubject } = require('./drift');
const { BundleCache, CACHE_FORMAT } = require('./bundles');
const esbuild = require('esbuild');

const SERVICES = ['alphaLoop', 'betaLoop', 'gammaLoop', 'deltaLoop'];

function git(cwd: string, args: string[], date?: string) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      ...args
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {})
      }
    }
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, file: string, content: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function service(name: string) {
  return {
    name,
    allowed_environments: ['staging', 'prod'],
    deploy_adapter: 'serverless',
    aws_region: { staging: 'eu-west-1', prod: 'us-east-1' },
    verification_targets: [name],
    validation_profile: 'lambda-version',
    default_dependencies: name === 'betaLoop' ? ['alphaLoop'] : []
  };
}

function commit(root: string, subject: string, date: string) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', subject], date);
  return git(root, ['rev-parse', 'HEAD']);
}

describe('drift computation on a fixture repository', () => {
  let root: string;
  let cacheDir: string;
  const shas: string[] = [];

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'deploy-drift-fixture-'));
    cacheDir = mkdtempSync(path.join(tmpdir(), 'deploy-drift-cache-'));
    git(root, ['init', '-q', '-b', 'main']);
    write(root, 'package.json', '{"name":"fixture","private":true}\n');
    write(
      root,
      'tsconfig.json',
      '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n'
    );
    write(
      root,
      'src/config/deploy-services.json',
      JSON.stringify({
        default_environment: 'staging',
        default_service: 'alphaLoop',
        services: SERVICES.map(service)
      })
    );
    write(
      root,
      '.github/workflows/deploy.yml',
      'jobs:\n  build-and-deploy:\n    steps:\n      - name: Deploy service\n        run: sls deploy\n'
    );
    write(root, 'src/shared.ts', "export const greeting = 'hello';\n");
    write(root, 'src/db.ts', "export const connect = () => 'db';\n");
    for (const name of SERVICES) {
      // gammaLoop reaches the database module through a relative import.
      const db =
        name === 'gammaLoop'
          ? "import { connect } from '../db';\nexport const database = connect();\n"
          : '';
      write(
        root,
        `src/${name}/index.ts`,
        `import { greeting } from '@/shared';\n${db}export const handler = () => greeting + ' ${name}';\n`
      );
      write(
        root,
        `src/${name}/package.json`,
        JSON.stringify({
          scripts: {
            build:
              'esbuild index.ts --bundle --sourcemap --platform=node --target=es2020 --outfile=dist/index.js',
            postbuild: 'cd dist && zip -r index.zip index.js*'
          }
        })
      );
      write(root, `src/${name}/serverless.yaml`, `service: ${name}\n`);
    }
    shas.push(commit(root, 'Initial services (#1)', '2026-11-01T10:00:00Z'));
    write(
      root,
      'src/alphaLoop/index.ts',
      "import { greeting } from '@/shared';\nexport const handler = () => greeting + ' changed alpha';\n"
    );
    shas.push(
      commit(
        root,
        'Merge pull request #2 from fixture/alpha',
        '2026-11-02T10:00:00Z'
      )
    );
    write(
      root,
      'src/shared.ts',
      "// A comment esbuild drops.\nexport const greeting = 'hello';\n"
    );
    shas.push(
      commit(root, 'Document the greeting (#3)', '2026-11-03T10:00:00Z')
    );
    write(
      root,
      'src/betaLoop/serverless.yaml',
      'service: betaLoop\nmemory: 1024\n'
    );
    shas.push(
      commit(root, 'Give beta more memory (#4)', '2026-11-04T10:00:00Z')
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function deployedAt(entries: Record<string, number>) {
    return new Map(
      Object.keys(entries).map((name) => [
        name,
        {
          sha: shas[entries[name]],
          run_id: entries[name],
          completed_at: `2026-11-0${entries[name] + 1}T12:00:00Z`
        }
      ])
    );
  }

  function drift(target: number, deployed: Record<string, number>) {
    return computeDrift({
      repoRoot: root,
      environment: 'prod',
      targetSha: shas[target],
      deployed: deployedAt(deployed),
      cacheDir,
      esbuild,
      parseYaml: parse,
      now: Date.parse('2026-11-05T10:00:00Z')
    });
  }

  it('compares bundle bytes, serverless.yaml and attributes pull requests', async () => {
    const result = await drift(3, { alphaLoop: 0, betaLoop: 0, gammaLoop: 3 });
    const byName = new Map<string, any>(
      result.services.map((record: { service: string }) => [
        record.service,
        record
      ])
    );
    expect(
      result.services.map((record: { service: string }) => record.service)
    ).toEqual(['alphaLoop', 'betaLoop', 'gammaLoop', 'deltaLoop']);
    const alpha = byName.get('alphaLoop');
    expect(alpha.status).toBe('behind');
    expect(alpha.reasons).toEqual([
      'bundle changed (2 bundled source files differ)'
    ]);
    expect(alpha.prs).toEqual([2, 3]);
    expect(alpha.behind_since).toBe('2026-11-02T10:00:00Z');
    // The shared comment leaves beta's bundle byte-identical; only its
    // serverless.yaml differs.
    const beta = byName.get('betaLoop');
    expect(beta.status).toBe('behind');
    expect(beta.reasons).toEqual(['file src/betaLoop/serverless.yaml changed']);
    expect(beta.prs).toEqual([4]);
    expect(beta.behind_since).toBe('2026-11-04T10:00:00Z');
    expect(byName.get('gammaLoop').status).toBe('current');
    // Services that bundle src/db.ts must log the [AUTH IAM] login line.
    expect(byName.get('gammaLoop').expects_db_auth).toBe(true);
    expect(alpha.expects_db_auth).toBe(false);
    expect(byName.get('deltaLoop').status).toBe('never-deployed');
    expect(result.stats.builds).toBeGreaterThan(0);
  });

  it('treats comment-only drift as current and reuses cached bundles', async () => {
    const result = await drift(2, { alphaLoop: 1, betaLoop: 0, gammaLoop: 0 });
    const statuses = result.services.map(
      (record: { service: string; status: string }) => [
        record.service,
        record.status
      ]
    );
    expect(statuses).toEqual([
      ['alphaLoop', 'current'],
      ['betaLoop', 'current'],
      ['gammaLoop', 'current'],
      ['deltaLoop', 'never-deployed']
    ]);
    const again = await drift(2, { alphaLoop: 1, betaLoop: 0, gammaLoop: 0 });
    expect(again.stats.builds).toBe(0);
    expect(again.stats.cache_hits).toBeGreaterThan(0);
  });

  it('never ships a deployed commit that is newer than the target', async () => {
    const result = await drift(1, { alphaLoop: 3, betaLoop: 1, gammaLoop: 1 });
    expect(result.services[0]).toMatchObject({
      service: 'alphaLoop',
      status: 'ahead'
    });
  });

  it('reports an unparseable build script for its service only', async () => {
    write(
      root,
      'src/deltaLoop/package.json',
      JSON.stringify({ scripts: { build: "esbuild 'index.ts --bundle" } })
    );
    shas.push(
      commit(root, 'Break the delta build (#5)', '2026-11-05T10:00:00Z')
    );
    const result = await drift(shas.length - 1, {
      alphaLoop: 3,
      betaLoop: 3,
      gammaLoop: 3,
      deltaLoop: 3
    });
    const statuses = new Map(
      result.services.map((record: { service: string; status: string }) => [
        record.service,
        record.status
      ])
    );
    expect(statuses.get('deltaLoop')).toBe('error');
    expect(statuses.get('alphaLoop')).toBe('current');
  });

  it('reads pull request numbers from merge and squash subjects', () => {
    expect(
      pullRequestFromSubject('Merge pull request #2549 from org/branch')
    ).toBe(2549);
    expect(pullRequestFromSubject('Fix the thing (#12)')).toBe(12);
    expect(pullRequestFromSubject('Direct commit')).toBeNull();
  });
});

describe('bundle cache', () => {
  const tree = (oids: Record<string, string>) => ({
    oid: (file: string) => oids[file] ?? null,
    listingHash: () => 'listing',
    children: () => []
  });

  function entry(builtAt: string) {
    return {
      format: CACHE_FORMAT,
      service: 'alphaLoop',
      specKey: 'spec',
      envKey: 'env',
      builtAt,
      bundleSha256: builtAt,
      sources: ['src/a.ts'],
      packages: [],
      inputs: { 'src/a.ts': `oid-${builtAt}` },
      dirs: { src: 'listing', '': 'listing' }
    };
  }

  it('finds only entries whose inputs match, and evicts by count and age', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-drift-prune-'));
    try {
      const cache = new BundleCache(dir, {
        maxEntriesPerService: 2,
        maxAgeDays: 1
      });
      ['one', 'two', 'three'].forEach((name) =>
        cache.store('alphaLoop', entry(name))
      );
      expect(
        cache.find('alphaLoop', 'spec', 'env', tree({ 'src/a.ts': 'oid-two' }))
          .builtAt
      ).toBe('two');
      expect(
        cache.find('alphaLoop', 'other', 'env', tree({ 'src/a.ts': 'oid-two' }))
      ).toBeNull();
      expect(
        cache.find('alphaLoop', 'spec', 'env', tree({ 'src/a.ts': 'x' }))
      ).toBeNull();
      const files = readdirSync(path.join(dir, 'alphaLoop'));
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      utimesSync(path.join(dir, 'alphaLoop', files[0]), old, old);
      cache.prune();
      const left = readdirSync(path.join(dir, 'alphaLoop'));
      expect(left.length).toBeLessThanOrEqual(2);
      expect(left).not.toContain(files[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
