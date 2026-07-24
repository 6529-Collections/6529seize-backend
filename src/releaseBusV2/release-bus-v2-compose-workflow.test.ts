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
  const match = workflow.match(
    /\n {8}id: compose\n[\s\S]*?\n {8}run: \|\n([\s\S]*?)(?=\n {6}- )/
  );
  if (!match) throw new Error('Compose workflow script was not found');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

describe('Release Bus v2 backend composition workflow', () => {
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
});
