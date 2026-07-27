import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function composeScript(): string {
  const workflow = readFileSync(
    path.join(process.cwd(), '.github/workflows/release-bus-v2-compose.yml'),
    'utf8'
  );
  // This executes the workflow's shell verbatim; keep the expression coupled
  // to the YAML step indentation so formatting drift fails the test loudly.
  const match = workflow.match(
    /\n {8}id: compose\n[\s\S]*?\n {8}run: \|\n([\s\S]*?)(?=\n {6}- )/
  );
  if (!match) throw new Error('Compose workflow script was not found');
  const script = match[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  if (
    !script.includes('existing="$(git ls-remote') ||
    !script.includes('git fsck --no-dangling')
  )
    throw new Error('Compose workflow script anchors were not preserved');
  return script;
}

describe('Release Bus v2 backend composition workflow', () => {
  it('accepts immutable rollback branches for forward-only staging recovery', () => {
    const workflow = readFileSync(
      path.join(process.cwd(), '.github/workflows/release-bus-v2-compose.yml'),
      'utf8'
    );
    expect(workflow).toContain(
      '(staging|production|qualification|rollback)-train-'
    );
  });

  it('successfully reuses current main when every candidate is already an ancestor', () => {
    const root = mkdtempSync(
      path.join(tmpdir(), 'release-bus-v2-compose-ancestor-')
    );
    const origin = path.join(root, 'origin.git');
    const repository = path.join(root, 'repository');
    const runnerTemp = path.join(root, 'runner-temp');
    try {
      execFileSync('git', ['init', '--bare', origin]);
      execFileSync('git', ['init', '--initial-branch=main', repository]);
      mkdirSync(runnerTemp);
      runGit(repository, 'config', 'user.name', 'Release Bus Test');
      runGit(
        repository,
        'config',
        'user.email',
        'release-bus-test@example.com'
      );
      runGit(repository, 'remote', 'add', 'origin', origin);
      writeFileSync(path.join(repository, 'candidate.txt'), 'candidate\n');
      runGit(repository, 'add', 'candidate.txt');
      runGit(repository, 'commit', '-m', 'candidate');
      const candidateSha = runGit(repository, 'rev-parse', 'HEAD');
      writeFileSync(path.join(repository, 'main.txt'), 'newer main\n');
      runGit(repository, 'add', 'main.txt');
      runGit(repository, 'commit', '-m', 'newer main');
      const baseSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'main');

      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CANDIDATE_SHAS: JSON.stringify([candidateSha]),
          RELEASE_BRANCH:
            'release-bus-v2/production-train-already-merged-backend',
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'already-merged'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      expect(
        JSON.parse(
          readFileSync(path.join(runnerTemp, 'composition.json'), 'utf8')
        )
      ).toEqual({
        composed_sha: baseSha,
        excluded_shas: [],
        // A newly-created release branch is not the immutable-branch reuse
        // path, even when every candidate is already present in its base.
        reused: false
      });
      expect(runGit(repository, 'rev-parse', 'HEAD')).toBe(baseSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips an ancestor while still merging a new candidate', () => {
    const root = mkdtempSync(
      path.join(tmpdir(), 'release-bus-v2-compose-mixed-')
    );
    const origin = path.join(root, 'origin.git');
    const repository = path.join(root, 'repository');
    const runnerTemp = path.join(root, 'runner-temp');
    try {
      execFileSync('git', ['init', '--bare', origin]);
      execFileSync('git', ['init', '--initial-branch=main', repository]);
      mkdirSync(runnerTemp);
      runGit(repository, 'config', 'user.name', 'Release Bus Test');
      runGit(
        repository,
        'config',
        'user.email',
        'release-bus-test@example.com'
      );
      runGit(repository, 'remote', 'add', 'origin', origin);
      writeFileSync(path.join(repository, 'ancestor.txt'), 'ancestor\n');
      runGit(repository, 'add', 'ancestor.txt');
      runGit(repository, 'commit', '-m', 'ancestor candidate');
      const ancestorSha = runGit(repository, 'rev-parse', 'HEAD');
      writeFileSync(path.join(repository, 'main.txt'), 'main\n');
      runGit(repository, 'add', 'main.txt');
      runGit(repository, 'commit', '-m', 'main after ancestor');
      const baseSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'main');

      runGit(repository, 'switch', '-c', 'new-candidate', baseSha);
      writeFileSync(path.join(repository, 'new.txt'), 'new candidate\n');
      runGit(repository, 'add', 'new.txt');
      runGit(repository, 'commit', '-m', 'new candidate');
      const newCandidateSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'new-candidate');
      runGit(repository, 'switch', 'main');

      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CANDIDATE_SHAS: JSON.stringify([ancestorSha, newCandidateSha]),
          RELEASE_BRANCH: 'release-bus-v2/production-train-mixed-backend',
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'mixed'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const composedSha = runGit(repository, 'rev-parse', 'HEAD');
      expect(composedSha).not.toBe(baseSha);
      expect(
        JSON.parse(
          readFileSync(path.join(runnerTemp, 'composition.json'), 'utf8')
        )
      ).toEqual({
        composed_sha: composedSha,
        excluded_shas: [],
        reused: false
      });
      expect(
        runGit(
          repository,
          'merge-base',
          '--is-ancestor',
          ancestorSha,
          composedSha
        )
      ).toBe('');
      expect(
        runGit(
          repository,
          'merge-base',
          '--is-ancestor',
          newCandidateSha,
          composedSha
        )
      ).toBe('');
      expect(
        runGit(repository, 'rev-list', '--parents', '-n', '1', 'HEAD')
      ).toBe(`${composedSha} ${baseSha} ${newCandidateSha}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates an immutable release commit that fast-forwards the exact staging parent', () => {
    const root = mkdtempSync(
      path.join(tmpdir(), 'release-bus-v2-compose-staging-parent-')
    );
    const origin = path.join(root, 'origin.git');
    const repository = path.join(root, 'repository');
    const runnerTemp = path.join(root, 'runner-temp');
    try {
      execFileSync('git', ['init', '--bare', origin]);
      execFileSync('git', ['init', '--initial-branch=main', repository]);
      mkdirSync(runnerTemp);
      runGit(repository, 'config', 'user.name', 'Release Bus Test');
      runGit(
        repository,
        'config',
        'user.email',
        'release-bus-test@example.com'
      );
      runGit(repository, 'remote', 'add', 'origin', origin);
      writeFileSync(path.join(repository, 'common.txt'), 'common\n');
      runGit(repository, 'add', 'common.txt');
      runGit(repository, 'commit', '-m', 'common');
      const commonSha = runGit(repository, 'rev-parse', 'HEAD');
      writeFileSync(path.join(repository, 'main.txt'), 'main after common\n');
      runGit(repository, 'add', 'main.txt');
      runGit(repository, 'commit', '-m', 'main after common');
      const baseSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'main');

      runGit(repository, 'switch', '-c', 'staging-parent', commonSha);
      writeFileSync(path.join(repository, 'admitted-a.txt'), 'candidate a\n');
      runGit(repository, 'add', 'admitted-a.txt');
      runGit(repository, 'commit', '-m', 'staging candidate a');
      const stagingParentSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'staging-parent');

      runGit(repository, 'switch', '-c', 'candidate-b', baseSha);
      writeFileSync(path.join(repository, 'candidate-b.txt'), 'candidate b\n');
      runGit(repository, 'add', 'candidate-b.txt');
      runGit(repository, 'commit', '-m', 'candidate b');
      const candidateSha = runGit(repository, 'rev-parse', 'HEAD');
      runGit(repository, 'push', 'origin', 'candidate-b');
      runGit(repository, 'switch', 'main');

      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CANDIDATE_SHAS: JSON.stringify([stagingParentSha, candidateSha]),
          RELEASE_BRANCH: 'release-bus-v2/staging-train-cumulative-backend',
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RELEASE_PARENT_SHA: stagingParentSha,
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'cumulative'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const releaseSha = runGit(repository, 'rev-parse', 'HEAD');
      const parents = runGit(
        repository,
        'rev-list',
        '--parents',
        '-n',
        '1',
        releaseSha
      ).split(' ');
      expect(parents).toHaveLength(3);
      expect(parents[1]).toBe(stagingParentSha);
      expect(
        runGit(
          repository,
          'merge-base',
          '--is-ancestor',
          candidateSha,
          releaseSha
        )
      ).toBe('');
      expect(runGit(repository, 'show', `${releaseSha}:admitted-a.txt`)).toBe(
        'candidate a'
      );
      expect(runGit(repository, 'show', `${releaseSha}:candidate-b.txt`)).toBe(
        'candidate b'
      );

      const releaseBranch = 'release-bus-v2/staging-train-cumulative-backend';
      runGit(
        repository,
        'push',
        'origin',
        `${releaseSha}:refs/heads/${releaseBranch}`
      );
      runGit(repository, 'switch', 'main');
      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CANDIDATE_SHAS: JSON.stringify([stagingParentSha, candidateSha]),
          RELEASE_BRANCH: releaseBranch,
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RELEASE_PARENT_SHA: stagingParentSha,
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'cumulative'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      expect(
        JSON.parse(
          readFileSync(path.join(runnerTemp, 'composition.json'), 'utf8')
        )
      ).toEqual({
        composed_sha: releaseSha,
        excluded_shas: [],
        reused: true
      });

      expect(() =>
        execFileSync('bash', ['-c', composeScript()], {
          cwd: repository,
          env: {
            ...process.env,
            BASE_SHA: baseSha,
            CANDIDATE_SHAS: JSON.stringify([stagingParentSha, candidateSha]),
            RELEASE_BRANCH: releaseBranch,
            RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
            RELEASE_BUS_GIT_NAME: 'Release Bus Test',
            RUNNER_TEMP: runnerTemp,
            TRAIN_ID: 'missing-parent'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      ).toThrow();

      expect(() =>
        execFileSync('bash', ['-c', composeScript()], {
          cwd: repository,
          env: {
            ...process.env,
            BASE_SHA: baseSha,
            CANDIDATE_SHAS: JSON.stringify([stagingParentSha, candidateSha]),
            RELEASE_BRANCH: releaseBranch,
            RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
            RELEASE_BUS_GIT_NAME: 'Release Bus Test',
            RELEASE_PARENT_SHA: baseSha,
            RUNNER_TEMP: runnerTemp,
            TRAIN_ID: 'wrong-parent'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      ).toThrow();

      runGit(repository, 'switch', '--detach', stagingParentSha);
      const emptyBranch =
        'release-bus-v2/staging-train-empty-cumulative-backend';
      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: stagingParentSha,
          CANDIDATE_SHAS: JSON.stringify([stagingParentSha]),
          RELEASE_BRANCH: emptyBranch,
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RELEASE_PARENT_SHA: stagingParentSha,
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'empty-cumulative'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const emptyReleaseSha = runGit(repository, 'rev-parse', 'HEAD');
      expect(emptyReleaseSha).not.toBe(stagingParentSha);
      expect(
        runGit(repository, 'rev-list', '--parents', '-n', '1', emptyReleaseSha)
      ).toBe(`${emptyReleaseSha} ${stagingParentSha}`);
      expect(
        runGit(repository, 'show', '-s', '--format=%B', emptyReleaseSha)
      ).toContain(`Release-Parent-SHA: ${stagingParentSha}`);

      runGit(repository, 'switch', '--detach', baseSha);
      execFileSync('bash', ['-c', composeScript()], {
        cwd: repository,
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CANDIDATE_SHAS: JSON.stringify([baseSha]),
          RELEASE_BRANCH: 'release-bus-v2/rollback-train-cumulative-backend',
          RELEASE_BUS_GIT_EMAIL: 'release-bus-test@example.com',
          RELEASE_BUS_GIT_NAME: 'Release Bus Test',
          RELEASE_PARENT_SHA: releaseSha,
          RUNNER_TEMP: runnerTemp,
          TRAIN_ID: 'rollback-cumulative'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const rollbackSha = runGit(repository, 'rev-parse', 'HEAD');
      const rollbackParents = runGit(
        repository,
        'rev-list',
        '--parents',
        '-n',
        '1',
        rollbackSha
      ).split(' ');
      expect(rollbackParents).toEqual([rollbackSha, releaseSha, baseSha]);
      expect(runGit(repository, 'rev-parse', `${rollbackSha}^{tree}`)).toBe(
        runGit(repository, 'rev-parse', `${baseSha}^{tree}`)
      );
      expect(() =>
        runGit(repository, 'show', `${rollbackSha}:candidate-b.txt`)
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
