import { AreaManifest } from '@/rebuild/manifest.types';
import {
  exemptUntil,
  overdueLine,
  runDay,
  validUntil
} from '@/rebuild/run/exempt-until';

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
});
