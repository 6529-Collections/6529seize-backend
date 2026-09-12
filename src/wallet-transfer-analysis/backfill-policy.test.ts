import {
  BACKFILL_METRICS,
  BackfillMetric,
  BackfillMetricName,
  backfillCooldown,
  backfillLoadGate
} from './backfill-policy';

const NOW = Date.UTC(2026, 8, 12);
const limits = {
  cpu: 35,
  connections: 200,
  read: 0.02,
  write: 0.02,
  memory: 2e9
};
const healthy = () =>
  Object.fromEntries(
    Object.keys(BACKFILL_METRICS).map((name) => [
      name,
      {
        timestamps: [1, 2, 3].map(
          (minutes) => new Date(NOW - minutes * 60_000)
        ),
        values: Array(3).fill(name === 'memory' ? 4e9 : 0),
        complete: true
      }
    ])
  ) as Record<BackfillMetricName, BackfillMetric>;

it('requires all monitored metrics and three recent samples before work', () => {
  expect(backfillLoadGate(healthy(), limits, NOW).healthy).toBe(true);
  expect(backfillLoadGate({}, limits, NOW).healthy).toBe(false);
  const samples = healthy();
  samples.cpu.timestamps = [new Date(NOW - 60_000)];
  expect(backfillLoadGate(samples, limits, NOW).healthy).toBe(false);
  samples.cpu = healthy().cpu;
  samples.cpu.complete = false;
  expect(backfillLoadGate(samples, limits, NOW).healthy).toBe(false);
});

it('pauses on an earlier spike, stale monitoring, or low memory', () => {
  const samples = healthy();
  samples.cpu.values[1] = 36;
  expect(backfillLoadGate(samples, limits, NOW).reasons).toContain(
    'cpu: load threshold exceeded'
  );
  expect(backfillLoadGate(healthy(), limits, NOW + 10 * 60_000).healthy).toBe(
    false
  );
  samples.cpu.values[1] = 0;
  samples.memory.values[0] = 1e9;
  expect(backfillLoadGate(samples, limits, NOW).reasons).toContain(
    'memory: load threshold exceeded'
  );
});

it('paces elapsed work with a minimum rest and at most ten percent duty', () => {
  expect(backfillCooldown(100, 5)).toBe(2_000);
  expect(backfillCooldown(1_000, 5)).toBe(19_000);
  expect(backfillCooldown(1_000, 10)).toBe(9_000);
  expect(() => backfillCooldown(100, 11)).toThrow();
});
