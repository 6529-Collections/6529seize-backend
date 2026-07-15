import {
  isDependencyClosed,
  topologicallySort,
  transitiveDependants
} from '@/releaseBus/release-bus.dag';

describe('release bus DAG', () => {
  it('orders dependencies before dependants while keeping independent work', () => {
    expect(topologicallySort(['a', 'b', 'c'], [['b', 'a']]).order).toEqual([
      'b',
      'a',
      'c'
    ]);
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
