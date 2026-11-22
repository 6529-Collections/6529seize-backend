import * as fc from 'fast-check';
import { RebuildStep } from '@/rebuild/manifest.types';
import { orderSteps } from '@/rebuild/step-order';

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
