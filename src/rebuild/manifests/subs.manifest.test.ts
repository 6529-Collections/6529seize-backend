import { AREA_MANIFESTS } from '@/rebuild/manifests';
import { stepsSkippedForSteps } from '@/rebuild/run/step-needs';

/** Every area's seeds: every run starts each of them. */
const SEEDS = AREA_MANIFESTS.flatMap((manifest) => manifest.seeds);
const inEveryRun = () => true;

describe("the subscriptions redemption seed's need of the holdings seed", () => {
  it('is skipped as planned in a run where the holdings seed is', () => {
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
    // The seeds before the holdings seed run as before.
    expect(skipped.has('subs.seed')).toBe(false);
    expect(skipped.has('subs.switch')).toBe(false);
  });

  it('runs once the holdings seed runs, and then refuses on its own when no airdrop was charged', () => {
    // With the holdings seed here, nothing skips the redemption seed; the
    // seed's own refusal of a run where card 1's airdrop wasn't charged is
    // tested against MySQL in src/rebuild/areas/subs.seed.db.test.ts.
    const skipped = stepsSkippedForSteps(SEEDS, () => true, inEveryRun);
    expect(skipped.has('subs.redemptions')).toBe(false);
  });
});
