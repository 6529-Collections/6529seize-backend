const { writeFileSync } = require('node:fs');
const path = require('node:path');

module.exports = function writeShardResults(results) {
  const { SHARD } = process.env;
  if (!/^[1-9]\d*$/.test(SHARD ?? '')) {
    throw new Error('Expected a positive SHARD number for the Jest CI results');
  }

  const suites = results.testResults.map(({ testFilePath, perfStats }) => {
    const suite = path
      .relative(process.cwd(), testFilePath)
      .split(path.sep)
      .join('/');
    return [suite, perfStats.runtime];
  });
  // Keep duplicate paths in the inventory so the aggregate gate can detect them.
  writeFileSync(
    `pr-ci-jest-inventory/shard-${SHARD}.txt`,
    suites.map(([suite]) => `${suite}\n`).join('')
  );
  const timings = Object.fromEntries(
    suites.filter(([, runtime]) => Number.isFinite(runtime) && runtime > 0)
  );
  writeFileSync(
    `pr-ci-jest-inventory/timings-${SHARD}.json`,
    `${JSON.stringify(timings, null, 2)}\n`
  );
  return results;
};
