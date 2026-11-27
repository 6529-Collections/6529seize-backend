import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { stepsSkippedForSteps } from '@/rebuild/run/step-needs';
import { orderSeeds } from '@/rebuild/step-order';
import { writtenTables } from '@/rebuild/step-writes';

/** Every area's seeds: every run starts each of them. */
const SEEDS = AREA_MANIFESTS.flatMap((manifest) => manifest.seeds);
const inEveryRun = () => true;

describe("the top-up loop's cursor in the subscriptions seeds", () => {
  // Both seeds top up on anvil, and each top-up runs the loop's discovery,
  // which moves subscriptions_top_up_latest_block.
  it.each(['subs.seed', 'subs.switch'])(
    '%s declares it as a write, not a read',
    (id) => {
      const step = SEEDS.find((seed) => seed.id === id)!;
      expect(writtenTables(step)).toContain(
        'subscriptions_top_up_latest_block'
      );
      expect(step.reads ?? []).not.toContain(
        'subscriptions_top_up_latest_block'
      );
    }
  );
});

describe("the subscriptions redemption seed's need of the holdings seed", () => {
  it('is skipped as planned, and no other subscriptions seed, in a run where the holdings seed is', () => {
    // Main before the holdings seed's code lands: that seed is planned.
    const skipped = stepsSkippedForSteps(
      SEEDS,
      (step) => step.id !== 'holdings.seed',
      inEveryRun
    );
    expect(skipped.get('subs.redemptions')).toEqual({
      step: 'subs.redemptions',
      needs: 'holdings.seed',
      why: 'skipped',
      reason: 'it mints and indexes card 1, whose airdrop this seed charges'
    });
    expect(
      Array.from(skipped.keys()).filter((id) => id.startsWith('subs.'))
    ).toEqual(['subs.redemptions']);
  });

  it('orders the redemption seed after the holdings seed and before the mint seed', () => {
    // The need is the only edge that puts the holdings seed first.
    const order = orderSeeds(SEEDS).order.map((step) => step.id);
    expect(order.indexOf('holdings.seed')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('holdings.seed')).toBeLessThan(
      order.indexOf('subs.redemptions')
    );
    expect(order.indexOf('subs.redemptions')).toBeLessThan(
      order.indexOf('mint.probes.seed')
    );
  });
});
