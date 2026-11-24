import path from 'node:path';
import CiTestSequencer = require('./pr-ci-jest-sequencer.cjs');

const slowSuites = [
  'largest.test.ts',
  'second.test.ts',
  'third.test.ts',
  'fourth.test.ts'
];
const newDbSuites = ['new-db-api.test.ts', 'new-db.test.ts'];
const newUnitSuites = ['alpha.test.ts', 'beta.test.ts', 'gamma.test.ts'];

function jestTests(rootDir: string, suites: string[]) {
  return suites.map((suite) => ({
    path: path.join(rootDir, suite),
    context: { config: { rootDir } }
  }));
}

function suitePaths(rootDir: string, tests: ReturnType<typeof jestTests>) {
  return tests.map((test) => path.relative(rootDir, test.path));
}

describe('Jest CI sequencer', () => {
  const sequencer = new CiTestSequencer(undefined, {
    'largest.test.ts': 300_000,
    'second.test.ts': 240_000,
    'third.test.ts': 220_000,
    'fourth.test.ts': 180_000,
    'removed.test.ts': 360_000,
    'alpha.test.ts': -10,
    'gamma.test.ts': 'invalid'
  });

  it('spreads expensive suites across separate shards and accounts for every suite', () => {
    const root = path.resolve('runner-a');
    const allSuites = [...newUnitSuites, ...slowSuites, ...newDbSuites];
    const tests = jestTests(root, allSuites);
    const shards = Array.from({ length: 6 }, (_, index) =>
      suitePaths(
        root,
        sequencer.shard(tests, { shardIndex: index + 1, shardCount: 6 })
      )
    );

    expect(shards.slice(0, 4)).toEqual(slowSuites.map((suite) => [suite]));
    expect(shards.flat()).toHaveLength(allSuites.length);
    expect(new Set(shards.flat())).toEqual(new Set(allSuites));
  });

  it('assigns identical shards across runner roots and discovery orders', () => {
    const assignShards = (root: string, suites: string[]) => {
      const tests = jestTests(root, suites);
      return Array.from({ length: 6 }, (_, index) =>
        suitePaths(
          root,
          sequencer.shard(tests, { shardIndex: index + 1, shardCount: 6 })
        )
      );
    };
    const suites = [...newUnitSuites, ...newDbSuites, ...slowSuites];
    expect(assignShards(path.resolve('runner-a'), suites)).toEqual(
      assignShards(path.resolve('runner-b'), [...suites].reverse())
    );
  });

  it('starts expensive suites early and breaks ties by repo-relative path', () => {
    const root = path.resolve('runner');
    const expected = [...slowSuites, ...newDbSuites, ...newUnitSuites];
    const tests = jestTests(root, [...expected].reverse());

    expect(suitePaths(root, sequencer.sort(tests))).toEqual(expected);
  });
});
