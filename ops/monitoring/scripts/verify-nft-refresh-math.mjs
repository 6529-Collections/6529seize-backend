import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { approvedAwsCli } from './aws-cli.mjs';
import { runAws } from './aws-run.mjs';

// Read-only acceptance against AWS's actual sparse-series semantics. No metrics
// are published, alarm states changed, or webhook notifications generated.
const awsCli = approvedAwsCli();
const environment = process.env.MONITORING_ENVIRONMENT;
assert.ok(
  ['prod', 'staging'].includes(environment),
  'Explicit environment required'
);
const resources = JSON.parse(
  readFileSync(`source-${environment}.json`, 'utf8')
).Resources;
const region = environment === 'prod' ? 'us-east-1' : 'eu-west-1';
const cases = [
  ['healthy', 'FailureRate', { s: 100, f: 1 }, 0],
  ['provider failure', 'FailureRate', { s: 0, f: 20 }, 1],
  ['low volume failure', 'FailureRate', { s: 0, f: 19 }, null],
  ['quiet', 'FailureRate', { s: 0, f: 0 }, null],
  [
    'persistent unavailable',
    'NewUnavailableSurge',
    { s: 0, c: 30, n: 0, p: 0 },
    null
  ],
  [
    'new unavailable surge',
    'NewUnavailableSurge',
    { s: 90, c: 100, n: 10, p: 0 },
    1
  ],
  [
    'previously working surge',
    'NewUnavailableSurge',
    { s: 15, c: 20, n: 5, p: 5 },
    1
  ],
  ['observed recovery', 'NewUnavailableSurge', { s: 50, c: 50, n: 0, p: 0 }, 0]
];
const end = new Date();
const start = new Date(end.getTime() - 15 * 60_000);
for (const [name, kind, values, expected] of cases) {
  const alarm = resources[`NftRefreshTRANSIENT${kind}`].Properties;
  const queries = Object.entries(values).map(([Id, value]) => ({
    Id,
    Expression: `TIME_SERIES(${value})`,
    Period: 300,
    ReturnData: false
  }));
  queries.push({ ...alarm.Metrics.at(-1), Period: 300 });
  const result = JSON.parse(
    runAws(
      awsCli,
      [
        'cloudwatch',
        'get-metric-data',
        '--region',
        region,
        '--start-time',
        start.toISOString(),
        '--end-time',
        end.toISOString(),
        '--metric-data-queries',
        JSON.stringify(queries)
      ],
      true
    )
  );
  const data = result.MetricDataResults.find((item) => item.Id === 'incident');
  assert.equal(data?.StatusCode, 'Complete', name);
  if (expected === null) assert.deepEqual(data.Values, [], name);
  else {
    assert.ok(data.Values.length > 0, name);
    assert.ok(
      data.Values.every((value) => value === expected),
      name
    );
  }
  process.stdout.write(`PASS: ${name}\n`);
}
