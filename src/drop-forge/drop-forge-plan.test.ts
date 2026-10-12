import { formatLaunchReport } from '@/drop-forge/drop-forge.reports';
import {
  buildLaunchPlan,
  hashLaunchSource
} from '@/drop-forge/drop-forge.plan';
import { encodeLaunchAction, claimAbi } from '@/drop-forge/drop-forge.chain';
import {
  testConfig,
  testPlan,
  testSource
} from '@/drop-forge/drop-forge.test-fixtures';

describe('Drop Forge launch planning', () => {
  it('uses prepared subscriber allocations and leaves payment receiver fixed', () => {
    const plan = buildLaunchPlan(testConfig, 1, testPlan, testSource, 0);
    expect(plan.distribution_hash).toBe(hashLaunchSource(testSource));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'INITIALIZE',
      'AIRDROP',
      'UPDATE'
    ]);
    expect(plan.actions[1].recipients[0].amount).toBe(1);
    const parameters = claimAbi.decodeFunctionData(
      'initializeClaim',
      encodeLaunchAction(plan, plan.actions[0])
    )[2];
    expect(parameters.paymentReceiver.toLowerCase()).toBe(testConfig.receiver);
    expect(parameters.cost.toString()).toBe('100');
    expect(parameters.startDate.toString()).toBe('4000');
    expect(plan.actions[2].due).toBe(testPlan.phases[0].end + 1);
  });
  it('requires explicit inclusion of artist and team allocations', () => {
    const source = {
      ...testSource,
      rows: [
        ...testSource.rows,
        {
          phase: 'Airdrop - Artist',
          wallet: '0x' + '66'.repeat(20),
          count: 2,
          count_airdrop: 2,
          count_allowlist: 0
        }
      ]
    };
    expect(
      buildLaunchPlan(testConfig, 1, testPlan, source, 0).actions[1].recipients
    ).toHaveLength(1);
    expect(
      buildLaunchPlan(
        testConfig,
        1,
        { ...testPlan, include_artist_airdrops: true },
        source,
        0
      ).actions[1].recipients
    ).toHaveLength(2);
  });
  it('rejects a public phase containing an allowlist and an unmapped phase', () => {
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        { ...testPlan, phases: [{ ...testPlan.phases[0], is_public: true }] },
        testSource,
        0
      )
    ).toThrow('Public');
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        { ...testPlan, phases: [testPlan.phases[1]] },
        testSource,
        0
      )
    ).toThrow('Every prepared');
  });
  it('rejects overlapping windows', () => {
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        {
          ...testPlan,
          phases: [testPlan.phases[0], { ...testPlan.phases[1], start: 4999 }]
        },
        testSource,
        0
      )
    ).toThrow('non-overlapping');
  });
  it('preserves phase allocations and schedules both public and Phase 2 subscriptions in the second transition gap', () => {
    const window = (
      name: string,
      start: number,
      end: number,
      is_public = false
    ) => ({ name, start, end, price_wei: '100', is_public });
    // 17:40/18:20, 18:30/18:50, 19:00/19:20, public from 19:20.
    const input = {
      ...testPlan,
      phases: [
        window('Phase 0', 4000, 6400),
        window('Phase 1', 7000, 8200),
        window('Phase 2', 8800, 10000),
        window('Public', 10000, 88000, true)
      ]
    };
    const source = {
      ...testSource,
      rows: [
        testSource.rows[0],
        { ...testSource.rows[0], phase: 'Phase 1', count_airdrop: 2 },
        { ...testSource.rows[0], phase: 'Phase 2', count_airdrop: 3 },
        {
          ...testSource.rows[0],
          phase: 'Public',
          count_airdrop: 4,
          count_allowlist: 0
        }
      ]
    };
    const plan = buildLaunchPlan(testConfig, 1, input, source, 0);
    expect(plan.actions.map(({ kind, phase }) => [kind, phase])).toEqual([
      ['INITIALIZE', 0],
      ['AIRDROP', 0],
      ['UPDATE', 1],
      ['AIRDROP', 1],
      ['UPDATE', 2],
      ['AIRDROP', 2],
      ['UPDATE', 3]
    ]);
    const batches = plan.actions.filter((it) => it.kind === 'AIRDROP');
    expect(batches.map((it) => it.recipients[0].amount)).toEqual([1, 2, 7]);
    expect(batches.map((it) => [it.due, it.deadline])).toEqual([
      [1000, 4000],
      [6401, 7000],
      [8201, 8800]
    ]);
    const publicUpdate = plan.actions[6];
    expect(publicUpdate.due).toBe(10001);
    expect(publicUpdate.deadline).toBeGreaterThan(publicUpdate.due);
    expect(publicUpdate.deadline).toBeLessThan(input.phases[3].end);
  });
  it('rejects unmapped subscriber-only phases rather than airdropping them early', () => {
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        testPlan,
        {
          ...testSource,
          rows: [
            ...testSource.rows,
            { ...testSource.rows[0], phase: 'Unknown', count_allowlist: 0 }
          ]
        },
        0
      )
    ).toThrow('Every prepared');
  });
  it('budgets each transition independently for its batch count', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      phase: 'Public',
      wallet: '0x' + (index + 100).toString(16).padStart(40, '0'),
      count: 1,
      count_airdrop: 1,
      count_allowlist: 0
    }));
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        {
          ...testPlan,
          phases: [testPlan.phases[0], { ...testPlan.phases[1], start: 5600 }]
        },
        { ...testSource, edition: 1000, rows: [...testSource.rows, ...rows] },
        0
      )
    ).toThrow('2 airdrop batches');
  });
  it('reports batch quantities and descriptive links on the correct chain', () => {
    const data = buildLaunchPlan(testConfig, 1, testPlan, testSource, 0);
    const hash = '0x' + 'aa'.repeat(32);
    const event = {
      id: 'event',
      content: 'Confirmed phase-0-airdrop-0: ' + hash,
      at: 1,
      error: false
    };
    const sepolia = formatLaunchReport(data, event);
    expect(sepolia).toContain(
      '[Transaction](https://sepolia.etherscan.io/tx/' + hash + ')'
    );
    expect(sepolia).toContain('recipient wallets: 1; tokens: 1');
    expect(formatLaunchReport({ ...data, chain_id: 1 }, event)).toContain(
      '[Transaction](https://etherscan.io/tx/'
    );
  });
});
