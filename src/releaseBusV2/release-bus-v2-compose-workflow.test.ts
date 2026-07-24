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
    / {6}- name: Compose deterministic candidate set[\s\S]*? {8}run: \|\n([\s\S]*?)\n {6}- name: Create scoped GitHub App token/
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
        reused: false
      });
      expect(runGit(repository, 'rev-parse', 'HEAD')).toBe(baseSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
