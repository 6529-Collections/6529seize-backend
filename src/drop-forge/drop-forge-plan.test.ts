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
  it('rejects windows that overlap or lack a transaction gap', () => {
    expect(() =>
      buildLaunchPlan(
        testConfig,
        1,
        {
          ...testPlan,
          phases: [testPlan.phases[0], { ...testPlan.phases[1], start: 5000 }]
        },
        testSource,
        0
      )
    ).toThrow('transition gaps');
  });
});
