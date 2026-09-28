import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    path.resolve(__dirname, '../.github/workflows/on-pull-request.yml'),
    'utf8'
  )
);
const finalSteps: { name?: string; run?: string }[] = workflow.jobs.build.steps;

/** Finds an executable gate step and reports workflow renames explicitly. */
function getRunScript(name: string): string {
  const step = finalSteps.find((candidate) => candidate.name === name);
  if (typeof step?.run !== 'string') {
    throw new Error(`Expected workflow step "${name}" to contain a run script`);
  }
  return step.run;
}

const gateScript = getRunScript('Require all checks and shards to pass');
const inventoryScript = getRunScript(
  'Verify every test belongs to exactly one shard'
);

/** Exercises the script's own fail-fast guards without implicit Bash options. */
function runScript(
  script: string,
  cwd: string,
  env: Record<string, string> = {}
) {
  return spawnSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, LC_ALL: 'C', ...env },
    encoding: 'utf8'
  });
}

describe('parallel PR workflow', () => {
  it('runs all four shards independently of builds and keeps the required gate', () => {
    expect(workflow.jobs.checks.needs).toBeUndefined();
    expect(workflow.jobs.test.needs).toBeUndefined();
    expect(workflow.jobs.test.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(workflow.jobs.test.strategy['fail-fast']).toBe(false);
    expect(workflow.jobs.build.name).toBe('Build backend and API');
    expect(workflow.jobs.build.needs).toEqual(['checks', 'test']);
    expect(workflow.jobs.build.if).toBe('${{ always() }}');
  });

  it('accepts successful builds and shards', () => {
    expect(
      runScript(gateScript, __dirname, {
        CHECKS_RESULT: 'success',
        TEST_RESULT: 'success'
      }).status
    ).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'rejects %j from either prerequisite',
    (result) => {
      for (const prerequisite of ['CHECKS_RESULT', 'TEST_RESULT']) {
        expect(
          runScript(gateScript, __dirname, {
            CHECKS_RESULT: 'success',
            TEST_RESULT: 'success',
            [prerequisite]: result
          }).status
        ).not.toBe(0);
      }
    }
  );

  it.each(['CHECKS_RESULT', 'TEST_RESULT'])(
    'rejects an unset prerequisite result: %s',
    (prerequisite) => {
      expect(
        runScript(`unset ${prerequisite}\n${gateScript}`, __dirname, {
          CHECKS_RESULT: 'success',
          TEST_RESULT: 'success'
        }).status
      ).not.toBe(0);
    }
  );
});

describe('cross-runner test inventory', () => {
  let directory: string;
  let inventoryDirectory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'pr-ci-inventory-'));
    inventoryDirectory = path.join(directory, 'pr-ci-jest-inventory');
    // Use the same directory layout as download-artifact's merge-multiple mode.
    mkdirSync(inventoryDirectory);
    const complete = 'a.test.ts\nb.test.ts\nc.test.ts\nd.test.ts\n';
    for (let shard = 1; shard <= 4; shard++) {
      writeFileSync(
        path.join(inventoryDirectory, `complete-${shard}.txt`),
        complete
      );
      writeFileSync(
        path.join(inventoryDirectory, `shard-${shard}.txt`),
        `${String.fromCodePoint(96 + shard)}.test.ts\n`
      );
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('accepts complete, disjoint inventories', () => {
    expect(runScript(inventoryScript, directory).status).toBe(0);
  });

  it.each([
    ['missing test', 'shard-4.txt', ''],
    ['duplicate test', 'shard-4.txt', 'a.test.ts\n'],
    ['unexpected test', 'shard-4.txt', 'other.test.ts\n'],
    ['extra test', 'shard-4.txt', 'd.test.ts\nother.test.ts\n'],
    ['inconsistent discovery', 'complete-4.txt', 'other.test.ts\n'],
    ['corrupt comparison baseline', 'complete-1.txt', 'a.test.ts\n']
  ])('rejects %s', (_reason, file, content) => {
    writeFileSync(path.join(inventoryDirectory, file), content);
    expect(runScript(inventoryScript, directory).status).not.toBe(0);
  });

  it.each(['complete-4.txt', 'shard-4.txt'])(
    'rejects a missing artifact file: %s',
    (file) => {
      rmSync(path.join(inventoryDirectory, file));
      expect(runScript(inventoryScript, directory).status).not.toBe(0);
    }
  );
});
