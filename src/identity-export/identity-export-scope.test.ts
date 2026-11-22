import * as fc from 'fast-check';
import {
  bulkKeys,
  compareCodePoints,
  findBulkCategories,
  isBulkEdge,
  isPlaceholderHandle,
  isRealHandle,
  publicExporterReach,
  RatingEdge,
  selectRatingScope
} from './identity-export.scope';

function rep(
  rater: string,
  target: string,
  category = 'Good',
  rating = 1
): RatingEdge {
  return {
    rater_profile_id: rater,
    target_profile_id: target,
    matter: 'REP',
    category,
    rating,
    last_modified_ms: null
  };
}

function cic(rater: string, target: string, rating = 1): RatingEdge {
  return { ...rep(rater, target, '', rating), matter: 'CIC' };
}

describe('handles', () => {
  it.each([
    ['id-0x' + 'a'.repeat(40), true],
    ['ID-0xABC', true],
    ['alice', false],
    ['id-alice', false],
    [null, false],
    ['', false]
  ])('%s is a placeholder: %s', (handle, placeholder) => {
    expect(isPlaceholderHandle(handle)).toBe(placeholder);
    expect(isRealHandle(handle)).toBe(!!handle && !placeholder);
  });
});

describe('findBulkCategories', () => {
  const edges = [
    rep('tagger', 'a', 'Holder'),
    rep('tagger', 'b', 'Holder'),
    rep('tagger', 'c', 'Holder'),
    rep('tagger', 'a', 'holder'),
    rep('other', 'a', 'Holder'),
    cic('tagger', 'a'),
    cic('tagger', 'b'),
    cic('tagger', 'c')
  ];

  it('counts one rater category (case kept) of REP only', () => {
    expect(findBulkCategories(edges, 2)).toEqual([
      { rater_profile_id: 'tagger', category: 'Holder', targets: 3 }
    ]);
  });

  it('finds none when off or under the threshold', () => {
    expect(findBulkCategories(edges, 0)).toEqual([]);
    expect(findBulkCategories(edges, 3)).toEqual([]);
  });

  it('marks only that rater and category as bulk', () => {
    const bulk = bulkKeys(findBulkCategories(edges, 2));
    expect(edges.map((it) => isBulkEdge(it, bulk))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false
    ]);
  });
});

describe('selectRatingScope', () => {
  const tagger = 'tagger';
  const core = new Set([tagger, 'alice']);
  const edges = [
    rep(tagger, 'p1', 'Holder'),
    rep(tagger, 'p2', 'Holder'),
    rep(tagger, 'alice', 'Holder'),
    rep('alice', 'p3'),
    cic('p4', 'p5'),
    rep('p6', 'p6'),
    rep('p7', 'missing')
  ];
  const bulk = bulkKeys(findBulkCategories(edges, 2));

  it('brings in the ends of non-bulk ratings and exports ratings inside', () => {
    const scope = selectRatingScope({
      core,
      edges,
      bulk,
      excluded: new Set(['missing'])
    });
    expect(Array.from(scope.profiles).sort(compareCodePoints)).toEqual(
      ['alice', 'p3', 'p4', 'p5', tagger].sort(compareCodePoints)
    );
    expect(scope.ratings).toEqual([
      rep(tagger, 'alice', 'Holder'),
      rep('alice', 'p3'),
      cic('p4', 'p5')
    ]);
    expect(scope.bulkLeftOut).toBe(2);
    expect(scope.rated.has('p7')).toBe(false);
    expect(scope.rated.has('p6')).toBe(false);
  });

  it('with the bulk rule off, brings in every end', () => {
    const scope = selectRatingScope({
      core,
      edges,
      bulk: new Set(),
      excluded: new Set(['missing'])
    });
    expect(scope.profiles.has('p1')).toBe(true);
    expect(scope.profiles.has('p2')).toBe(true);
    expect(scope.bulkLeftOut).toBe(0);
  });

  const arbitraryEdges = fc.array(
    fc.record({
      rater: fc.integer({ min: 0, max: 12 }),
      target: fc.integer({ min: 0, max: 12 }),
      cicMatter: fc.boolean(),
      category: fc.constantFrom('Holder', 'Good', 'Art')
    }),
    { maxLength: 80 }
  );

  it('keeps its invariants on any graph', () => {
    fc.assert(
      fc.property(
        arbitraryEdges,
        fc.subarray(Array.from({ length: 13 }, (_, i) => `p${i}`)),
        fc.subarray(Array.from({ length: 13 }, (_, i) => `p${i}`)),
        fc.integer({ min: 0, max: 4 }),
        (raw, coreList, excludedList, threshold) => {
          const graph = raw.map((it) =>
            it.cicMatter
              ? cic(`p${it.rater}`, `p${it.target}`)
              : rep(`p${it.rater}`, `p${it.target}`, it.category)
          );
          const bulkSet = bulkKeys(findBulkCategories(graph, threshold));
          const excluded = new Set(excludedList);
          const scope = selectRatingScope({
            core: new Set(coreList),
            edges: graph,
            bulk: bulkSet,
            excluded
          });
          for (const profile of Array.from(scope.profiles)) {
            expect(excluded.has(profile)).toBe(false);
            if (!coreList.includes(profile)) {
              expect(scope.rated.has(profile)).toBe(true);
            }
          }
          for (const edge of scope.ratings) {
            expect(scope.profiles.has(edge.rater_profile_id)).toBe(true);
            expect(scope.profiles.has(edge.target_profile_id)).toBe(true);
            expect(edge.rater_profile_id).not.toBe(edge.target_profile_id);
          }
          for (const edge of graph) {
            const usable =
              edge.rater_profile_id !== edge.target_profile_id &&
              !excluded.has(edge.rater_profile_id) &&
              !excluded.has(edge.target_profile_id);
            if (usable && !isBulkEdge(edge, bulkSet)) {
              expect(scope.ratings).toContain(edge);
            }
          }
        }
      )
    );
  });
});

describe('publicExporterReach', () => {
  it('reaches two rounds out over received and non-bulk given ratings', () => {
    const edges = [
      rep('core', 'a'),
      rep('b', 'core'),
      rep('a', 'c'),
      rep('c', 'd'),
      rep('core', 'e', 'Holder'),
      rep('core', 'f', 'Holder'),
      rep('core', 'g', 'Holder')
    ];
    const bulk = bulkKeys(findBulkCategories(edges, 2));
    const reach = publicExporterReach({
      core: new Set(['core']),
      edges,
      bulk
    });
    expect(Array.from(reach).sort(compareCodePoints)).toEqual([
      'a',
      'b',
      'c',
      'core'
    ]);
  });
});
