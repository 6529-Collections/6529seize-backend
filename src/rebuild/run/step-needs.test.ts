import { RebuildStep } from '@/rebuild/manifest.types';
import {
  stepsSkippedForSteps,
  stepSkipLine,
  stepSkipReason
} from '@/rebuild/run/step-needs';
import { orderSeeds, orderSteps } from '@/rebuild/step-order';

function step(
  id: string,
  needs: string[] = [],
  parts: Partial<RebuildStep> = {}
): RebuildStep {
  return {
    id,
    run: { module: 'src/x', exportName: 'run' },
    writes: [],
    sources: ['repo'],
    timeoutMinutes: 5,
    needsSteps: needs.map((need) => ({ step: need, reason: `needs ${need}` })),
    ...parts
  };
}

const ids = (skipped: ReadonlyMap<string, unknown>) =>
  Array.from(skipped.keys()).sort((a, b) => a.localeCompare(b));

describe('steps skipped for the steps they need', () => {
  const everyStepRuns = () => true;
  const allInRun = () => true;

  it('skips nothing when every needed step runs', () => {
    const steps = [
      step('holdings.seed'),
      step('subs.redemptions', ['holdings.seed'])
    ];
    expect(ids(stepsSkippedForSteps(steps, everyStepRuns, allInRun))).toEqual(
      []
    );
  });

  it('skips a step whose needed step is planned or waits for a table', () => {
    const steps = [
      step('holdings.seed'),
      step('subs.redemptions', ['holdings.seed'])
    ];
    const skipped = stepsSkippedForSteps(
      steps,
      (s) => s.id !== 'holdings.seed',
      allInRun
    );
    expect(Array.from(skipped.values())).toEqual([
      {
        step: 'subs.redemptions',
        needs: 'holdings.seed',
        why: 'skipped',
        reason: 'needs holdings.seed'
      }
    ]);
    expect(stepSkipLine(skipped.get('subs.redemptions')!)).toBe(
      'subs.redemptions needs holdings.seed, which is skipped as planned (needs holdings.seed)'
    );
    // The reason alone, as an owned column's note gives it after the owner.
    expect(stepSkipReason(skipped.get('subs.redemptions')!)).toBe(
      'needs holdings.seed, which is skipped as planned (needs holdings.seed)'
    );
  });

  it('carries a skip down a chain, whatever order the steps come in', () => {
    const steps = [step('c', ['b']), step('b', ['a']), step('a'), step('d')];
    const skipped = stepsSkippedForSteps(steps, (s) => s.id !== 'a', allInRun);
    expect(ids(skipped)).toEqual(['b', 'c']);
    expect(skipped.get('c')).toMatchObject({ needs: 'b', why: 'skipped' });
  });

  it('skips a rebuilder whose needed rebuilder is outside the area run', () => {
    const steps = [step('mint.log'), step('subs.top-ups', ['mint.log'])];
    const skipped = stepsSkippedForSteps(
      steps,
      everyStepRuns,
      (id) => id !== 'mint.log'
    );
    expect(Array.from(skipped.values())).toEqual([
      {
        step: 'subs.top-ups',
        needs: 'mint.log',
        why: 'outside',
        reason: 'needs mint.log'
      }
    ]);
    expect(stepSkipLine(skipped.get('subs.top-ups')!)).toBe(
      'subs.top-ups needs mint.log, outside this area run (needs mint.log)'
    );
    expect(stepSkipReason(skipped.get('subs.top-ups')!)).toBe(
      'needs mint.log, outside this area run (needs mint.log)'
    );
  });

  it('lists only steps the run would start and that could run on their own', () => {
    const steps = [step('a'), step('b', ['a']), step('c', ['a'])];
    const skipped = stepsSkippedForSteps(
      steps,
      (s) => s.id !== 'a' && s.id !== 'b',
      (id) => id !== 'c'
    );
    // b is skipped for its own reason, c isn't in the run: neither is a
    // skip for a needed step.
    expect(ids(skipped)).toEqual([]);
  });

  it('leaves an unknown step and a cycle to the registry', () => {
    const steps = [step('a', ['nowhere']), step('b', ['c']), step('c', ['b'])];
    expect(ids(stepsSkippedForSteps(steps, everyStepRuns, allInRun))).toEqual(
      []
    );
  });

  it('orders a needed step first, like after', () => {
    const steps = [
      step('subs.redemptions', ['holdings.seed']),
      step('holdings.seed')
    ];
    expect(orderSeeds(steps).order.map((s) => s.id)).toEqual([
      'holdings.seed',
      'subs.redemptions'
    ]);
    // A rebuilder's need on a seed doesn't hold back the rebuilders' order.
    expect(
      orderSteps([step('r', ['holdings.seed'])]).order.map((s) => s.id)
    ).toEqual(['r']);
  });
});
