import {
  isDependencyClosed,
  topologicallySort,
  transitiveDependants
} from '@/releaseBus/release-bus.dag';

describe('release bus DAG', () => {
  it('orders dependencies before dependants while keeping independent work', () => {
    const graph = topologicallySort(['a', 'b', 'c'], [['b', 'a']]);
    expect(graph.order).toEqual(['b', 'a', 'c']);
    expect(graph.layers).toEqual([['b', 'c'], ['a']]);
    expect(graph.dependencies.get('a')).toEqual(['b']);
  });

  it('puts every independent node in the same deterministic frontier', () => {
    expect(topologicallySort(['c', 'a', 'b'], []).layers).toEqual([
      ['a', 'b', 'c']
    ]);
  });

  it('waits for both independent parents before unlocking a dependant', () => {
    expect(
      topologicallySort(
        ['d', 'b', 'a'],
        [
          ['a', 'd'],
          ['b', 'd']
        ]
      ).layers
    ).toEqual([['a', 'b'], ['d']]);
  });

  it('rejects cycles', () => {
    expect(() =>
      topologicallySort(
        ['a', 'b'],
        [
          ['a', 'b'],
          ['b', 'a']
        ]
      )
    ).toThrow('DAG cycle detected');
  });

  it('holds transitive dependants but not independent candidates', () => {
    const graph = topologicallySort(['a', 'b', 'c'], [['b', 'a']]);
    expect(
      Array.from(transitiveDependants(['b'], graph.dependants)).sort((a, b) =>
        a.localeCompare(b)
      )
    ).toEqual(['a', 'b']);
    expect(isDependencyClosed(new Set(['c']), [['b', 'a']])).toBe(true);
  });
});
