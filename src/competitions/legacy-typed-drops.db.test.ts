import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE
} from '@/constants/db-tables';
import { legacyCompetitionId } from '@/competitions/competition-id';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { legacyTypedDropsSql } from '@/competitions/legacy-typed-drops';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

/**
 * The legacy GET facade's drops view computes drop_type from competition
 * entries. These tests pin that the base-table replacements return exactly
 * the view's rows: native entries in every status, drops with no entry,
 * an unpublished competition, an entry whose drop was deleted, and waves
 * with no competition at all.
 */
const native = aWave({ type: WaveType.RANK }, { id: 'native', name: 'N' });
const unpublished = aWave(
  { type: WaveType.RANK },
  { id: 'unpublished', name: 'U' }
);
const legacyOnly = aWave({ type: WaveType.RANK }, { id: 'legacy', name: 'L' });
const AUTHORS = ['author-a', 'author-b', 'author-c'];

let serial = 1;
const drop = (
  id: string,
  waveId: string,
  dropType: string,
  authorId = 'author-a'
) => ({
  serial_no: serial++,
  id,
  wave_id: waveId,
  author_id: authorId,
  created_at: 1000 + serial,
  parts_count: 1,
  drop_type: dropType
});
let entrySeq = 1;
const entry = (wave: string, dropId: string, status: string) => ({
  id: `entry-${entrySeq++}`,
  competition_id: legacyCompetitionId(wave),
  wave_id: wave,
  drop_id: dropId,
  submitter_id: 'author-a',
  status,
  config_version: 1,
  submitted_at: 1
});

const identity = (profileId: string, level: number) =>
  anIdentity(
    { pfp: `https://pfp.example/${profileId}.png`, level_raw: level },
    {
      consolidation_key: `key-${profileId}`,
      profile_id: profileId,
      primary_address: `0x${profileId.padStart(40, '0').slice(-40)}`,
      handle: profileId
    }
  );

describeWithSeed(
  'legacy GET facade hot paths read base tables with the view rows',
  [
    withWaves([native, unpublished, legacyOnly]),
    withIdentities([
      identity('author-a', 30),
      identity('author-b', 20),
      identity('author-c', 10)
    ]),
    {
      table: COMPETITIONS_TABLE,
      rows: [
        nativeOriginalPrimaryFixture(native),
        {
          ...nativeOriginalPrimaryFixture(unpublished),
          lifecycle: 'DRAFT',
          published_at: null
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        drop('n-active-competition', 'native', 'COMPETITION'),
        drop('n-active-participatory', 'native', 'PARTICIPATORY'),
        drop('n-legacy-participatory', 'native', 'PARTICIPATORY'),
        drop('n-withdrawn', 'native', 'PARTICIPATORY'),
        drop('n-disqualified', 'native', 'WINNER'),
        drop('n-winner', 'native', 'COMPETITION'),
        drop('n-winner-stored-participatory', 'native', 'PARTICIPATORY'),
        drop('n-legacy-winner', 'native', 'WINNER'),
        drop('n-chat', 'native', 'CHAT', 'author-b'),
        drop('n-other-author', 'native', 'COMPETITION', 'author-c'),
        drop('u-active', 'unpublished', 'COMPETITION'),
        drop('u-legacy-winner', 'unpublished', 'WINNER', 'author-b'),
        drop('l-participatory', 'legacy', 'PARTICIPATORY'),
        drop('l-winner', 'legacy', 'WINNER', 'author-b'),
        drop('l-chat', 'legacy', 'CHAT', 'author-c')
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        entry('native', 'n-active-competition', 'ACTIVE'),
        entry('native', 'n-active-participatory', 'ACTIVE'),
        entry('native', 'n-withdrawn', 'WITHDRAWN'),
        entry('native', 'n-disqualified', 'DISQUALIFIED'),
        entry('native', 'n-winner', 'WINNER'),
        entry('native', 'n-winner-stored-participatory', 'WINNER'),
        entry('native', 'n-other-author', 'ACTIVE'),
        entry('native', 'n-deleted-drop', 'ACTIVE'),
        entry('unpublished', 'u-active', 'ACTIVE')
      ]
    }
  ],
  () => {
    const sorted = (rows: { profile_id: string; drop_id: string }[]) =>
      rows
        .map((row) => `${row.profile_id}:${row.drop_id}`)
        .sort((a, b) => a.localeCompare(b));

    const viewRows = (dropType: string, waveId: string, profileIds: string[]) =>
      sqlExecutor.execute<{ profile_id: string; drop_id: string }>(
        `select author_id as profile_id, id as drop_id from legacy_get_drops
          where author_id in (:profileIds) and wave_id = :waveId and drop_type = :dropType`,
        { profileIds, waveId, dropType }
      );

    const baseRows = (
      dropType: DropType.PARTICIPATORY | DropType.WINNER,
      waveId: string,
      profileIds: string[]
    ) =>
      sqlExecutor.execute<{ profile_id: string; drop_id: string }>(
        legacyTypedDropsSql(dropType, {
          profileIds: ':profileIds',
          waveId: ':waveId'
        }),
        { profileIds, waveId }
      );

    it.each([
      [DropType.PARTICIPATORY, 'native'],
      [DropType.WINNER, 'native'],
      [DropType.PARTICIPATORY, 'unpublished'],
      [DropType.WINNER, 'unpublished'],
      [DropType.PARTICIPATORY, 'legacy'],
      [DropType.WINNER, 'legacy']
    ] as const)(
      'returns the view rows for %s drops in the %s wave',
      async (dropType, waveId) => {
        for (const profileIds of [AUTHORS, ['author-a'], ['author-b']]) {
          const expected = sorted(await viewRows(dropType, waveId, profileIds));
          const actual = sorted(await baseRows(dropType, waveId, profileIds));
          expect({ profileIds, actual }).toEqual({
            profileIds,
            actual: expected
          });
        }
      }
    );

    it('maps native entries by status and keeps legacy drops by stored type', async () => {
      expect(
        sorted(await baseRows(DropType.PARTICIPATORY, 'native', AUTHORS))
      ).toEqual([
        'author-a:n-active-competition',
        'author-a:n-active-participatory',
        'author-a:n-legacy-participatory',
        'author-c:n-other-author'
      ]);
      expect(
        sorted(await baseRows(DropType.WINNER, 'native', AUTHORS))
      ).toEqual([
        'author-a:n-legacy-winner',
        'author-a:n-winner',
        'author-a:n-winner-stored-participatory'
      ]);
    });

    it('lists the same wave contributors as the view, inside the facade', async () => {
      const waveIds = ['native', 'unpublished', 'legacy'];
      const viewContributors = await sqlExecutor.execute<{
        wave_id: string;
        contributor_identity: string;
        contributor_pfp: string;
      }>(
        `WITH distinct_authors AS (
            SELECT DISTINCT wave_id, author_id FROM legacy_get_drops
            WHERE wave_id IN (:waveIds)),
          authors_with_levels AS (
            SELECT da.wave_id, i.profile_id, i.primary_address, i.pfp, i.level_raw
            FROM distinct_authors da JOIN identities i ON i.profile_id = da.author_id
            WHERE i.pfp IS NOT NULL),
          ranked AS (
            SELECT wave_id, pfp AS contributor_pfp,
              primary_address AS contributor_identity,
              ROW_NUMBER() OVER (PARTITION BY wave_id ORDER BY level_raw DESC) AS rn
            FROM authors_with_levels)
         SELECT wave_id, contributor_pfp, contributor_identity
         FROM ranked WHERE rn <= 5 ORDER BY wave_id, rn`,
        { waveIds }
      );
      const expected = viewContributors.reduce(
        (acc, row) => {
          (acc[row.wave_id] ??= []).push({
            contributor_identity: row.contributor_identity,
            contributor_pfp: row.contributor_pfp
          });
          return acc;
        },
        {} as Record<
          string,
          { contributor_identity: string; contributor_pfp: string }[]
        >
      );
      const actual = await withLegacyCompetitionGetFacade(() =>
        wavesApiDb.getWavesContributorsOverviews(waveIds, {})
      );
      expect(actual).toEqual(expected);
      expect(Object.keys(actual).sort((a, b) => a.localeCompare(b))).toEqual(
        waveIds.sort((a, b) => a.localeCompare(b))
      );
    });
  }
);
