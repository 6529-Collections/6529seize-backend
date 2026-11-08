import 'reflect-metadata';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import {
  VIEWER_GROUP_SET_MEMBERS_TABLE,
  VIEWER_GROUP_SETS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { Time } from '@/time';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { viewerGroupSetHash, viewerGroupSets } from '@/waves/viewer-group-sets';
import { WavesApiDb } from './waves.api.db';

// Redis SET NX for the write lease, in process.
const leases = new Map<string, number>();
jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  redisSetIfAbsent: async (key: string, ttl: Time) => {
    const now = Date.now();
    const until = leases.get(key);
    if (until !== undefined && until > now) return false;
    leases.set(key, now + ttl.toMillis());
    return true;
  }
}));

const MEMBER = 'vgv-member-group';
const OTHER = 'vgv-other-group';
const roots = [
  aWave({}, { id: 'vgv-public', serial_no: 1, name: 'Public' }),
  aWave(
    { visibility_group_id: MEMBER },
    { id: 'vgv-member', serial_no: 2, name: 'Member' }
  ),
  aWave(
    { visibility_group_id: OTHER },
    { id: 'vgv-other', serial_no: 3, name: 'Other' }
  ),
  // Its only subwave is for members.
  aWave({}, { id: 'vgv-gated', serial_no: 4, name: 'Gated subwaves' })
];
const children = [
  aWave(
    { parent_wave_id: 'vgv-public' },
    { id: 'vgv-public-open', serial_no: 5, name: 'Public open' }
  ),
  aWave(
    { parent_wave_id: 'vgv-public', visibility_group_id: MEMBER },
    { id: 'vgv-public-members', serial_no: 6, name: 'Public members' }
  ),
  aWave(
    { parent_wave_id: 'vgv-member' },
    { id: 'vgv-member-open', serial_no: 7, name: 'Member open' }
  ),
  aWave(
    { parent_wave_id: 'vgv-other', visibility_group_id: OTHER },
    { id: 'vgv-other-others', serial_no: 8, name: 'Other others' }
  ),
  aWave(
    { parent_wave_id: 'vgv-gated', visibility_group_id: MEMBER },
    { id: 'vgv-gated-members', serial_no: 9, name: 'Gated members' }
  )
];
const allWaves = [...roots, ...children];

// One inlined copy of these passes the pinning size, so a stored set is
// worth reading.
const filler = Array.from(
  { length: 400 },
  (_, i) => `vgv-filler-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const heavyViewers = [
  [MEMBER],
  [OTHER],
  [MEMBER, OTHER],
  ['vgv-unrelated-group'],
  // Matching follows the column collation (case-insensitive), as the
  // inlined literal list does.
  [MEMBER.toUpperCase()]
].map((groups) => [...groups, ...filler]);
const smallViewer = [MEMBER, 'vgv-small-1', 'vgv-small-2'];

type Read = (waves: WavesApiDb, groups: string[]) => Promise<unknown>;
const reads: [string, string, Read][] = [
  [
    'visible parents by child wave ids',
    'vp_viewer_groups',
    async (waves, groups) => {
      const parents = await waves.findVisibleParentWavesByChildWaveIds(
        children.map((it) => it.id),
        groups,
        {}
      );
      return Object.entries(parents)
        .map(([child, parent]) => [child, parent.id])
        .sort(([a], [b]) => a.localeCompare(b));
    }
  ],
  [
    'wave ids with visible subwaves',
    'vs_viewer_groups',
    async (waves, groups) =>
      Array.from(
        await waves.findWaveIdsWithVisibleSubwaves(
          roots.map((it) => it.id),
          groups,
          {}
        )
      ).sort()
  ]
];

const FLAG = 'FEATURE_VIEWER_GROUP_SET_TABLE';

describeWithSeed(
  'Visible parents and subwaves read stored viewer group sets',
  withWaves(allWaves),
  () => {
    let statements: [string, Record<string, unknown>][] = [];
    /** One read as the API makes it: inside the legacy facade scope. */
    const run = async (read: Read, groups: string[], flag: boolean) => {
      if (flag) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      statements = [];
      const original = sqlExecutor.execute.bind(sqlExecutor);
      jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation((sql, params, opts) => {
          if (/child_wave_id|parent_wave_id as wave_id/.test(sql))
            statements.push([sql, (params ?? {}) as Record<string, unknown>]);
          return original(sql, params, opts);
        });
      try {
        return await withLegacyCompetitionGetFacade(() =>
          read(new WavesApiDb(() => sqlExecutor), groups)
        );
      } finally {
        jest.restoreAllMocks();
      }
    };
    const setCount = async () =>
      Number(
        (
          await sqlExecutor.execute<{ n: number }>(
            `select count(*) as n from ${VIEWER_GROUP_SETS_TABLE}`
          )
        )[0].n
      );
    const readsStoredSet = (cte: string) =>
      statements.length > 0 &&
      statements.every(
        ([sql, params]) =>
          sql.includes(`${cte} as (`) &&
          sql.includes(VIEWER_GROUP_SET_MEMBERS_TABLE) &&
          !sql.includes(':groupIdsUserIsEligibleFor') &&
          `${cte}_set` in params
      );
    const inlines = () =>
      statements.length > 0 &&
      statements.every(
        ([sql]) =>
          sql.includes(':groupIdsUserIsEligibleFor') &&
          !sql.includes('_viewer_groups')
      );

    beforeEach(() => {
      leases.clear();
      viewerGroupSets.reset();
      resetViewerGroupsCteSupport(true);
    });
    afterEach(() => {
      delete process.env[FLAG];
      viewerGroupSets.reset();
      resetViewerGroupsCteSupport();
    });

    it.each(reads)(
      '%s: with the flag on, first sight inlines and stores the set, then reads it; every result equals the flag-off read',
      async (_name, cte, read) => {
        const results = new Set<string>();
        for (const groups of heavyViewers) {
          const off = await run(read, groups, false);
          expect(inlines()).toBe(true);
          results.add(JSON.stringify(off));
          const sets = await setCount();
          // First sight: the inlined list, and the set is written.
          expect({ groups, firstSight: await run(read, groups, true) }).toEqual(
            { groups, firstSight: off }
          );
          expect(inlines()).toBe(true);
          expect(await setCount()).toBe(sets + 1);
          // From now on the statement reads the stored set.
          expect({ groups, stored: await run(read, groups, true) }).toEqual({
            groups,
            stored: off
          });
          expect(readsStoredSet(cte)).toBe(true);
        }
        // The viewers really see different things.
        expect(results.size).toBeGreaterThan(1);
      },
      120_000
    );

    it.each(reads)(
      '%s: a small viewer keeps the inlined list and stores nothing',
      async (_name, _cte, read) => {
        const off = await run(read, smallViewer, false);
        expect(await run(read, smallViewer, true)).toEqual(off);
        expect(inlines()).toBe(true);
        expect(await run(read, smallViewer, true)).toEqual(off);
        expect(inlines()).toBe(true);
        expect(await setCount()).toBe(0);
      }
    );

    it.each(reads)(
      '%s: a membership change reads a new set, never the old one',
      async (_name, cte, read) => {
        const [before, after] = [heavyViewers[0], heavyViewers[1]];
        const offBefore = await run(read, before, false);
        const offAfter = await run(read, after, false);
        expect(offAfter).not.toEqual(offBefore);
        await run(read, before, true);
        expect(await run(read, before, true)).toEqual(offBefore);
        expect(readsStoredSet(cte)).toBe(true);
        // The viewer's groups change: a new hash, so first sight again.
        expect(await run(read, after, true)).toEqual(offAfter);
        expect(inlines()).toBe(true);
        expect(await run(read, after, true)).toEqual(offAfter);
        expect(readsStoredSet(cte)).toBe(true);
        expect(statements[0][1][`${cte}_set`]).toBe(viewerGroupSetHash(after));
        expect(await run(read, before, true)).toEqual(offBefore);
        expect(await setCount()).toBe(2);
      }
    );

    it.each(reads)(
      '%s: the stored-set plan looks the set up by hash, with no JSON table',
      async (_name, cte, read) => {
        const groups = heavyViewers[0];
        await run(read, groups, true);
        await run(read, groups, true);
        expect(readsStoredSet(cte)).toBe(true);
        for (const [sql, params] of statements) {
          const [row] = await sqlExecutor.execute<Record<string, string>>(
            `explain format=tree ${sql}`,
            params
          );
          const plan = Object.values(row)[0];
          expect(plan).not.toContain('Materialize table function');
          expect(plan).toMatch(/lookup on m using PRIMARY \(set_hash=/);
        }
      }
    );
  }
);
