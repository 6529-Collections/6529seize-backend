import { AreaManifest, validUntil } from '@/rebuild/manifest.types';
import { exemptUntil, overdueLine, runDay } from '@/rebuild/run/exempt-until';

const manifest = (tables: AreaManifest['tables']): AreaManifest =>
  ({
    area: 'waves',
    tables,
    seeds: [],
    rebuilders: [],
    probes: []
  }) as unknown as AreaManifest;

describe('EXEMPT until a day', () => {
  it('takes only a real day written YYYY-MM-DD', () => {
    expect(validUntil('2026-12-04')).toBe(true);
    expect(validUntil('2028-02-29')).toBe(true);
    for (const bad of [
      '2026-12-4',
      '2026-02-30',
      '2026-13-01',
      '04/12/2026',
      '2026-12-04T00:00:00Z',
      ''
    ]) {
      expect(validUntil(bad)).toBe(false);
    }
    expect(runDay(new Date('2026-12-05T23:59:59Z'))).toBe('2026-12-05');
  });

  it('lists EXEMPT tables with an until, overdue only past the day', () => {
    const manifests = [
      manifest({
        chain_entry_holds: {
          class: 'EXEMPT',
          why: 'held entries move later',
          until: '2026-12-04'
        },
        other_exempt: { class: 'EXEMPT', why: 'no end' },
        a_index: { class: 'INDEX' }
      })
    ];
    const on = (day: string) => exemptUntil(manifests, day);
    expect(on('2026-12-04')).toEqual([
      {
        table: 'chain_entry_holds',
        until: '2026-12-04',
        why: 'held entries move later',
        overdue: false
      }
    ]);
    expect(overdueLine(on('2026-12-04'))).toBeNull();
    expect(on('2026-12-05')[0].overdue).toBe(true);
    expect(overdueLine(on('2026-12-05'))).toBe(
      'EXEMPT overdue: chain_entry_holds since 2026-12-04'
    );
  });

  it("leaves out an until that isn't a real day, which the registry refuses", () => {
    // Compared as text, '2026-1-5' would read as overdue on 2026-12-05.
    const manifests = [
      manifest({
        loose_day: { class: 'EXEMPT', why: 'a loose day', until: '2026-1-5' }
      })
    ];
    expect(exemptUntil(manifests, '2026-12-05')).toEqual([]);
  });

  it('puts overdue plans of planned rows on the same line, after the tables', () => {
    const table = { table: 'chain_entry_holds', until: '2026-12-04' };
    const plan = { table: 'team', until: '2026-12-01' };
    expect(
      overdueLine(
        [{ ...table, overdue: true }],
        [
          { ...plan, overdue: true },
          // Two plans of one table on one day read once.
          { ...plan, overdue: true },
          { table: 'artists', until: '2026-12-31', overdue: false }
        ]
      )
    ).toBe(
      'EXEMPT overdue: chain_entry_holds since 2026-12-04; planned rows overdue: team since 2026-12-01'
    );
    expect(overdueLine([], [{ ...plan, overdue: true }])).toBe(
      'planned rows overdue: team since 2026-12-01'
    );
    expect(overdueLine([{ ...table, overdue: false }], [])).toBeNull();
  });
});
