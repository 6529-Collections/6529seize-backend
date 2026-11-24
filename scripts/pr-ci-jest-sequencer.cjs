const { readFileSync } = require('node:fs');
const path = require('node:path');
const { default: TestSequencer } = require('@jest/test-sequencer');

function readTimingSnapshot() {
  try {
    const snapshot = JSON.parse(
      readFileSync(path.join(__dirname, 'pr-ci-jest-timings.json'), 'utf8')
    );
    return snapshot?.durationsMs ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
    console.warn('Jest CI timing snapshot unavailable. Using suite estimates.');
    return {};
  }
}

const durationsMs = readTimingSnapshot();

function weighTests(tests, timings) {
  return tests
    .map((test) => {
      const suite = path
        .relative(test.context.config.cwd, test.path)
        .split(path.sep)
        .join('/');
      const duration = timings[suite];
      const integration = path
        .basename(suite)
        .split(/[.-]/)
        .some((part) => part === 'db' || part === 'integration');
      const fallback = integration ? 10_000 : 2_000;
      return {
        test,
        suite,
        weight: Number.isFinite(duration) && duration > 0 ? duration : fallback
      };
    })
    .sort((a, b) => {
      if (a.weight !== b.weight) {
        return b.weight - a.weight;
      }
      return a.suite < b.suite ? -1 : Number(a.suite > b.suite);
    });
}

module.exports = class CiTestSequencer extends TestSequencer {
  constructor(options, timings = durationsMs) {
    super(options);
    this.timings = timings;
  }

  shard(tests, { shardIndex, shardCount }) {
    const shards = Array.from({ length: shardCount }, () => ({
      weight: 0,
      tests: []
    }));
    for (const { test, weight } of weighTests(tests, this.timings)) {
      const lightest = shards.reduce(
        (best, shard) => (shard.weight < best.weight ? shard : best),
        shards[0]
      );
      lightest.tests.push(test);
      lightest.weight += weight;
    }
    return shards[shardIndex - 1].tests;
  }

  sort(tests) {
    // Give the two workers the longest suites early to reduce the idle tail.
    return weighTests(tests, this.timings).map(({ test }) => test);
  }
};
