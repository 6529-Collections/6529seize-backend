import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type GitHubCall = string[];
type FakeRun = {
  databaseId: number;
  displayTitle: string;
  createdAt?: string;
  service?: string;
};

const repositoryRoot = path.resolve(__dirname, '..');
const deployRepository = '6529-Collections/6529seize-backend';
const fakeGitHub = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.MOCK_DEPLOY_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'api' && args[1] === 'user') {
  save();
  console.log('test-developer');
} else if (args[0] === 'run' && args[1] === 'list') {
  save();
  console.log(JSON.stringify(state.runs));
} else if (args[0] === 'workflow' && args[1] === 'run') {
  const fields = Object.fromEntries(args.flatMap((value, index) => {
    if (value !== '-f') return [];
    const field = args[index + 1];
    const separator = field.indexOf('=');
    return [[field.slice(0, separator), field.slice(separator + 1)]];
  }));
  const count = process.env.MOCK_DEPLOY_AMBIGUOUS === 'true' ? 2 : 1;
  if (process.env.MOCK_DEPLOY_LATE_OLD_RUN === 'true') {
    state.runs.push({
      databaseId: 999,
      displayTitle: 'Deploy ' + fields.service + ' to ' + fields.environment,
      createdAt: '2020-01-01T00:00:00Z'
    });
  }
  for (let index = 0; index < count; index++) {
    state.runs.push({
      databaseId: state.nextId++,
      displayTitle: 'Deploy ' + fields.service + ' to ' + fields.environment,
      createdAt: new Date().toISOString().replace(/\\.\\d{3}Z$/, 'Z'),
      service: fields.service
    });
  }
  save();
} else if (args[0] === 'run' && args[1] === 'watch') {
  const run = state.runs.find((entry) => String(entry.databaseId) === args[2]);
  save();
  if (!run || !args.includes('--exit-status')) process.exit(91);
  if (run.service === process.env.MOCK_DEPLOY_FAIL_SERVICE) process.exit(1);
} else {
  save();
  console.error('Unexpected mocked gh command: ' + JSON.stringify(args));
  process.exit(92);
}
`;

describe('ordinary backend deployment helpers', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), '6529-deploy-helpers-'));
    const githubPath = path.join(directory, 'gh');
    writeFileSync(githubPath, fakeGitHub);
    chmodSync(githubPath, 0o755);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function runHelper(
    script: 'deploy-lambda.sh' | 'deploy-all-lambdas.sh',
    args: string[],
    options: {
      runs?: FakeRun[];
      failService?: string;
      ambiguous?: boolean;
      lateOldRun?: boolean;
    } = {}
  ) {
    const statePath = path.join(directory, 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({ calls: [], runs: options.runs ?? [], nextId: 1001 })
    );
    const result = spawnSync(
      'bash',
      [path.join(repositoryRoot, 'scripts', script), ...args],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
          MOCK_DEPLOY_STATE: statePath,
          MOCK_DEPLOY_FAIL_SERVICE: options.failService ?? '',
          MOCK_DEPLOY_AMBIGUOUS: String(options.ambiguous ?? false),
          MOCK_DEPLOY_LATE_OLD_RUN: String(options.lateOldRun ?? false)
        }
      }
    );
    if (result.error) throw result.error;
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      calls: GitHubCall[];
    };
    return { ...result, calls: state.calls };
  }

  function mutationCalls(calls: GitHubCall[]) {
    return calls.filter(
      ([command, subcommand]) =>
        (command === 'workflow' && subcommand === 'run') ||
        (command === 'run' && subcommand === 'watch')
    );
  }

  it('identifies and watches the new service run while excluding prior runs', () => {
    const result = runHelper(
      'deploy-lambda.sh',
      ['1a-staging', 'staging', 'api'],
      {
        runs: [{ databaseId: 1000, displayTitle: 'Deploy api to staging' }]
      }
    );

    expect(result.status).toBe(0);
    expect(mutationCalls(result.calls)).toEqual([
      [
        'workflow',
        'run',
        'deploy.yml',
        '--repo',
        deployRepository,
        '--ref',
        '1a-staging',
        '-f',
        'environment=staging',
        '-f',
        'service=api'
      ],
      ['run', 'watch', '1001', '--repo', deployRepository, '--exit-status']
    ]);
    const listings = result.calls.filter(
      ([command, subcommand]) => command === 'run' && subcommand === 'list'
    );
    expect(listings).toHaveLength(2);
    for (const listing of listings) {
      expect(listing).toEqual([
        'run',
        'list',
        '--repo',
        deployRepository,
        '--workflow',
        'deploy.yml',
        '--branch',
        '1a-staging',
        '--event',
        'workflow_dispatch',
        '--user',
        'test-developer',
        '--limit',
        '100',
        '--json',
        'databaseId,displayTitle,createdAt'
      ]);
    }
  });

  it('ignores an older matching run first returned after dispatch', () => {
    const result = runHelper(
      'deploy-lambda.sh',
      ['1a-staging', 'staging', 'api'],
      { lateOldRun: true }
    );

    expect(result.status).toBe(0);
    expect(mutationCalls(result.calls)).toHaveLength(2);
    expect(mutationCalls(result.calls)[1]).toEqual([
      'run',
      'watch',
      '1001',
      '--repo',
      deployRepository,
      '--exit-status'
    ]);
  });

  it('waits for each production service before dispatching the next and preserves group inputs', () => {
    const result = runHelper('deploy-all-lambdas.sh', [
      'main',
      'prod',
      'dbMigrationsLoop',
      'api',
      '--',
      'release_pull_request=1801',
      'release_group_services=dbMigrationsLoop,api',
      'release_note_publish=true'
    ]);

    expect(result.status).toBe(0);
    const mutations = mutationCalls(result.calls);
    expect(mutations.map((args) => args.slice(0, 3))).toEqual([
      ['workflow', 'run', 'deploy.yml'],
      ['run', 'watch', '1001'],
      ['workflow', 'run', 'deploy.yml'],
      ['run', 'watch', '1002']
    ]);
    ['dbMigrationsLoop', 'api'].forEach((service, index) => {
      expect(mutations[index * 2]).toEqual([
        'workflow',
        'run',
        'deploy.yml',
        '--repo',
        deployRepository,
        '--ref',
        'main',
        '-f',
        'environment=prod',
        '-f',
        `service=${service}`,
        '-f',
        'release_pull_request=1801',
        '-f',
        'release_group_services=dbMigrationsLoop,api',
        '-f',
        'release_note_publish=true'
      ]);
    });
  });

  it('stops the service sequence when the preceding deployment fails', () => {
    const result = runHelper(
      'deploy-all-lambdas.sh',
      ['1a-staging', 'staging', 'dbMigrationsLoop', 'api'],
      { failService: 'dbMigrationsLoop' }
    );

    expect(result.status).toBe(1);
    const mutations = mutationCalls(result.calls);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toContain('service=dbMigrationsLoop');
    expect(mutations[1]).toEqual([
      'run',
      'watch',
      '1001',
      '--repo',
      deployRepository,
      '--exit-status'
    ]);
  });

  it('fails ambiguous new runs without redispatching or guessing a run to watch', () => {
    const result = runHelper(
      'deploy-all-lambdas.sh',
      ['1a-staging', 'staging', 'dbMigrationsLoop', 'api'],
      { ambiguous: true }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Multiple matching deployments started');
    expect(mutationCalls(result.calls)).toHaveLength(1);
    expect(mutationCalls(result.calls)[0]).toContain(
      'service=dbMigrationsLoop'
    );
  });

  it.each([
    ['main', 'staging', 'api'],
    ['1a-staging', 'prod', 'api'],
    ['feature/deploy', 'staging', 'api'],
    ['main', 'development', 'api']
  ])(
    'rejects a noncanonical branch or environment before gh: %j',
    (...args) => {
      const result = runHelper('deploy-lambda.sh', args);

      expect(result.status).toBe(2);
      expect(result.calls).toEqual([]);
    }
  );

  it('rejects unsupported workflow inputs before dispatch', () => {
    const result = runHelper('deploy-lambda.sh', [
      'main',
      'prod',
      'api',
      'unrecognized_input=true'
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unsupported deployment input');
    expect(result.calls).toEqual([]);
  });
});
