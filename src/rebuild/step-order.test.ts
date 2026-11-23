import * as fc from 'fast-check';
import { RebuildStep } from '@/rebuild/manifest.types';
import { orderSeeds, orderSteps } from '@/rebuild/step-order';

function step(id: string, after: string[] = []): RebuildStep {
  return {
    id,
    run: { command: ['true'] },
    writes: [],
    after,
    sources: [],
    timeoutMinutes: 1
  };
}

describe('orderSteps', () => {
  it('runs each step after the steps it waits on, keeping input order otherwise', () => {
    const result = orderSteps([
      step('tdh', ['eth', 'mirror']),
      step('eth'),
      step('mirror'),
      step('notify', ['tdh'])
    ]);
    expect(result.order.map((s) => s.id)).toEqual([
      'eth',
      'mirror',
      'tdh',
      'notify'
    ]);
    expect(result.unknown).toEqual([]);
    expect(result.cyclic).toEqual([]);
  });

  it('reports unknown ids and cycles', () => {
    const result = orderSteps([
      step('a', ['b']),
      step('b', ['a']),
      step('c', ['ghost'])
    ]);
    expect(result.order.map((s) => s.id)).toEqual(['c']);
    expect(result.unknown).toEqual(['ghost']);
    expect(result.cyclic).toEqual(['a', 'b']);
  });

  it('runs a step ahead of the steps its before names, as their after would', () => {
    const result = orderSteps([
      step('holdings.seed'),
      { ...step('subs.seed'), before: ['holdings.seed'] },
      { ...step('subs.switch', ['subs.seed']), before: ['holdings.seed'] },
      step('mint.seed')
    ]);
    expect(result.order.map((s) => s.id)).toEqual([
      'subs.seed',
      'subs.switch',
      'mint.seed',
      'holdings.seed'
    ]);
    expect(result.unknown).toEqual([]);
    expect(result.cyclic).toEqual([]);
  });

  it('reports unknown before names, and cycles across before and after', () => {
    const result = orderSteps([
      { ...step('a', ['b']), before: ['b'] },
      step('b'),
      { ...step('c'), before: ['ghost'] }
    ]);
    expect(result.unknown).toEqual(['ghost']);
    expect(result.cyclic).toEqual(['a', 'b']);
  });

  it('never orders a step before one it waits on', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.nat(9), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 10
        }),
        (deps) => {
          // Waiting only on earlier ids keeps the graph acyclic.
          const steps = deps.map((list, i) =>
            step(
              `s${i}`,
              list.filter((d) => d < i).map((d) => `s${d}`)
            )
          );
          const { order, cyclic } = orderSteps(steps);
          expect(cyclic).toEqual([]);
          const position = new Map(order.map((s, i) => [s.id, i]));
          for (const s of steps) {
            for (const dep of s.after ?? []) {
              expect(position.get(dep)!).toBeLessThan(position.get(s.id)!);
            }
          }
        }
      )
    );
  });
});

describe('orderSeeds', () => {
  const last = (id: string, after: string[] = []): RebuildStep => ({
    ...step(id, after),
    last: true
  });

  it('runs the last seeds after every other one, in their own order', () => {
    const result = orderSeeds([
      last('holdings.catch-up', ['holdings.seed']),
      step('holdings.seed'),
      last('tdh.catch-up', ['holdings.catch-up']),
      step('subs.seed', ['holdings.seed']),
      step('mint.seed')
    ]);
    expect(result.order.map((s) => s.id)).toEqual([
      'holdings.seed',
      'subs.seed',
      'mint.seed',
      'holdings.catch-up',
      'tdh.catch-up'
    ]);
  });

  it('lets a seed run before a last one', () => {
    const result = orderSeeds([
      last('holdings.catch-up', ['holdings.seed']),
      step('holdings.seed'),
      { ...step('subs.seed'), before: ['holdings.seed', 'holdings.catch-up'] }
    ]);
    expect(result.order.map((s) => s.id)).toEqual([
      'subs.seed',
      'holdings.seed',
      'holdings.catch-up'
    ]);
  });

  it('still runs each seed after the seeds it waits on', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            deps: fc.array(fc.nat(9), { maxLength: 3 }),
            last: fc.boolean()
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (specs) => {
          // Earlier ids only, and a seed that isn't last never waits on
          // one that is: what the registry allows.
          const seeds = specs.map(({ deps, last: isLast }, i) => ({
            ...step(
              `s${i}`,
              deps
                .filter((d) => d < i && (isLast || !specs[d].last))
                .map((d) => `s${d}`)
            ),
            last: isLast
          }));
          const { order } = orderSeeds(seeds);
          const position = new Map(order.map((s, i) => [s.id, i]));
          const firstLast = order.findIndex((s) => s.last);
          for (const s of seeds) {
            for (const dep of s.after ?? []) {
              expect(position.get(dep)!).toBeLessThan(position.get(s.id)!);
            }
            if (!s.last && firstLast >= 0) {
              expect(position.get(s.id)!).toBeLessThan(firstLast);
            }
          }
        }
      )
    );
  });
});
