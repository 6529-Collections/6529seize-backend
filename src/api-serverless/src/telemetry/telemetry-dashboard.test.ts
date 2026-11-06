import fc from 'fast-check';
import {
  completePeriod,
  dailyTotals,
  parseProps,
  productEventCells,
  productImpactRatios,
  SMALL_CELL_THRESHOLD,
  toSuppressedCells,
  vitalsSummaries
} from '@/api/telemetry/telemetry-dashboard';
import { vitalsBucket } from '@/api/telemetry/telemetry-vitals-buckets';

describe('small-cell suppression', () => {
  it('withholds every cell under 5 after aggregating', () => {
    const cells = toSuppressedCells(
      [
        { referrer_domain: 'news.example.org', count: 3 },
        { referrer_domain: 'news.example.org', count: 2 },
        { referrer_domain: 'alice.blog.example', count: 4 },
        { referrer_domain: 'big.example', count: 40 }
      ],
      ['referrer_domain']
    );
    expect(cells).toEqual([
      { dims: { referrer_domain: 'big.example' }, count: 40 },
      { dims: { referrer_domain: 'news.example.org' }, count: 5 }
    ]);
  });

  it('never returns a count under the threshold (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            route: fc.constantFrom('/', '/waves', '/[user]', '/about'),
            count: fc.integer({ min: 0, max: 20 })
          })
        ),
        (rows) =>
          toSuppressedCells(rows, ['route']).every(
            (cell) => cell.count >= SMALL_CELL_THRESHOLD
          )
      )
    );
  });

  it('suppresses small daily totals', () => {
    const [day] = dailyTotals(
      ['2026-11-05'],
      [{ day: '2026-11-05', count: 120 }],
      [{ day: '2026-11-05', count: 4 }],
      [
        { day: '2026-11-05', metric: 'anonymous_visitors', count: 60 },
        { day: '2026-11-05', metric: 'signed_in_dau', count: 3 }
      ]
    );
    expect(day).toMatchObject({
      day: '2026-11-05',
      page_views: 120,
      entries: null,
      anonymous_visitors: 60,
      signed_in_dau: null
    });
  });

  it('withholds ratios built on small counts', () => {
    const ratios = productImpactRatios([
      { name: 'Wave Feed Load Started', props: '', count: 100 },
      { name: 'Wave Feed Load Succeeded', props: '', count: 90 },
      { name: 'Wave Feed Load Failed', props: 'product_failure=true', count: 3 }
    ]);
    expect(
      ratios.find((r) => r.name === 'waves_succeeded_per_started')
    ).toEqual({
      name: 'waves_succeeded_per_started',
      numerator: 90,
      denominator: 100,
      value: 0.9
    });
    expect(
      ratios.find((r) => r.name === 'waves_product_failures_per_started')
    ).toEqual({
      name: 'waves_product_failures_per_started',
      numerator: null,
      denominator: 100,
      value: null
    });
  });

  it('projects product events onto props before suppressing', () => {
    const rows = [
      {
        name: 'Homepage action clicked',
        props: 'action=Mint&section=Latest drop&signed_in=true',
        count: 3
      },
      {
        name: 'Homepage action clicked',
        props: 'action=Mint&section=Latest drop&signed_in=false',
        count: 3
      },
      {
        name: 'Homepage action clicked',
        props: 'action=View all&section=Coming up',
        count: 2
      }
    ];
    expect(
      productEventCells(
        rows,
        ['Homepage action clicked'],
        ['section', 'action']
      )
    ).toEqual([
      {
        dims: {
          name: 'Homepage action clicked',
          section: 'Latest drop',
          action: 'Mint'
        },
        count: 6
      }
    ]);
    expect(parseProps('a=1&b=x y')).toEqual({ a: '1', b: 'x y' });
  });

  it('withholds vitals with fewer than five samples', () => {
    const rows = [
      { route: '/', metric: 'lcp', bucket: vitalsBucket(2000), count: 4 },
      { route: '/waves', metric: 'lcp', bucket: vitalsBucket(3000), count: 10 }
    ];
    const summaries = vitalsSummaries(rows, { perRoute: true });
    expect(summaries.map((s) => `${s.route}:${s.samples}`)).toEqual([
      '*:14',
      '/waves:10'
    ]);
    expect(vitalsSummaries(rows, { perRoute: false })).toHaveLength(1);
  });
});

describe('completePeriod', () => {
  it('returns the most recent complete week or month by default', () => {
    // 2026-11-06 is a Friday.
    expect(completePeriod('week', '2026-11-06')).toEqual({
      from: '2026-10-26',
      to: '2026-11-01'
    });
    expect(completePeriod('month', '2026-11-06')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31'
    });
    expect(completePeriod('month', '2026-03-01')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28'
    });
  });

  it('only accepts aligned, finished periods', () => {
    expect(completePeriod('week', '2026-11-06', '2026-10-19')).toEqual({
      from: '2026-10-19',
      to: '2026-10-25'
    });
    expect(completePeriod('week', '2026-11-06', '2026-10-20')).toBeNull();
    expect(completePeriod('week', '2026-11-06', '2026-11-02')).toBeNull();
    expect(completePeriod('month', '2026-11-06', '2026-11-01')).toBeNull();
    expect(completePeriod('month', '2026-11-06', '2026-09-15')).toBeNull();
  });
});
