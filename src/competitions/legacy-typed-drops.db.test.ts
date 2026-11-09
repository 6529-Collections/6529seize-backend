import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  DROPS_TABLE
} from '@/constants/db-tables';
import { legacyCompetitionId } from '@/competitions/competition-id';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import {
  legacyAuthorWaveParticipationSql,
  legacyTypedDropsSql
} from '@/competitions/legacy-typed-drops';
import { dropsDb } from '@/drops/drops.db';
import fc from 'fast-check';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { identitiesDb } from '@/identities/identities.db';
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
        drop('n-pending-participatory', 'native', 'PARTICIPATORY'),
        drop('n-pending-winner', 'native', 'WINNER', 'author-b'),
        drop('n-pending-competition', 'native', 'COMPETITION'),
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
        // A status the view does not map: the drop keeps its stored type,
        // except a stored COMPETITION drop, which the view shows as CHAT.
        entry('native', 'n-pending-participatory', 'PENDING'),
        entry('native', 'n-pending-winner', 'PENDING'),
        entry('native', 'n-pending-competition', 'PENDING'),
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
        'author-a:n-pending-participatory',
        'author-c:n-other-author'
      ]);
      expect(
        sorted(await baseRows(DropType.WINNER, 'native', AUTHORS))
      ).toEqual([
        'author-a:n-legacy-winner',
        'author-a:n-winner',
        'author-a:n-winner-stored-participatory',
        'author-b:n-pending-winner'
      ]);
    });

    it.each([
      ['getActiveMainStageDropIds', DropType.PARTICIPATORY],
      ['getMainStageWinnerDropIds', DropType.WINNER]
    ] as const)(
      '%s returns the view rows inside the facade',
      async (method, dropType) => {
        const previous = process.env.MAIN_STAGE_WAVE_ID;
        process.env.MAIN_STAGE_WAVE_ID = 'native';
        try {
          // The facade scope must be read before the query switches it off.
          const grouped = await withLegacyCompetitionGetFacade(() =>
            identitiesDb[method](AUTHORS, {})
          );
          const flat = Object.entries(grouped)
            .flatMap(([profileId, dropIds]) =>
              dropIds.map((dropId) => `${profileId}:${dropId}`)
            )
            .sort((a, b) => a.localeCompare(b));
          expect(flat).toEqual(
            sorted(await viewRows(dropType, 'native', AUTHORS))
          );
          // Outside the facade the stored types apply, which differ here.
          const outside = await identitiesDb[method](AUTHORS, {});
          expect(outside).not.toEqual(grouped);
        } finally {
          if (previous === undefined) delete process.env.MAIN_STAGE_WAVE_ID;
          else process.env.MAIN_STAGE_WAVE_ID = previous;
        }
      }
    );

    const WAVES = ['native', 'unpublished', 'legacy'];
    const PEOPLE = [...AUTHORS, 'author-none'];

    /** What the drop mapper read through the view before: 1/0 per pair. */
    const viewParticipation = async (waveIds: string[], authorIds: string[]) =>
      (
        await sqlExecutor.execute<{
          wave_id: string;
          author_id: string;
          is_participant: number;
          is_winner: number;
        }>(
          `select wave_id, author_id,
                  max(case when drop_type = 'PARTICIPATORY' then 1 else 0 end) as is_participant,
                  max(case when drop_type = 'WINNER' then 1 else 0 end) as is_winner
             from legacy_get_drops
            where wave_id in (:waveIds) and author_id in (:authorIds)
              and drop_type in ('PARTICIPATORY', 'WINNER')
            group by wave_id, author_id`,
          { waveIds, authorIds }
        )
      )
        .map(
          (row) =>
            `${row.wave_id}:${row.author_id}:${Number(row.is_participant)}${Number(row.is_winner)}`
        )
        .sort((a, b) => a.localeCompare(b));

    const baseParticipation = async (waveIds: string[], authorIds: string[]) =>
      (
        await sqlExecutor.execute<{
          wave_id: string;
          author_id: string;
          is_participant: number;
          is_winner: number;
        }>(
          legacyAuthorWaveParticipationSql({
            waveIds: ':waveIds',
            authorIds: ':authorIds'
          }),
          { waveIds, authorIds }
        )
      )
        .map(
          (row) =>
            `${row.wave_id}:${row.author_id}:${Number(row.is_participant)}${Number(row.is_winner)}`
        )
        .sort((a, b) => a.localeCompare(b));

    it('returns the view participation for every wave and author combination', async () => {
      const subsets = <T>(items: T[]): T[][] =>
        items
          .reduce<
            T[][]
          >((acc, item) => [...acc, ...acc.map((set) => [...set, item])], [[]])
          .filter((set) => set.length > 0);
      for (const waveIds of subsets(WAVES)) {
        for (const authorIds of subsets(PEOPLE)) {
          expect({
            waveIds,
            authorIds,
            rows: await baseParticipation(waveIds, authorIds)
          }).toEqual({
            waveIds,
            authorIds,
            rows: await viewParticipation(waveIds, authorIds)
          });
        }
      }
    });

    it('matches the view for random wave and author lists, duplicates included', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...WAVES), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(...PEOPLE), { minLength: 1, maxLength: 6 }),
          async (waveIds, authorIds) => {
            expect(await baseParticipation(waveIds, authorIds)).toEqual(
              await viewParticipation(waveIds, authorIds)
            );
          }
        ),
        { numRuns: 40 }
      );
    });

    it('pins the native wave flags the view computes from entry status', async () => {
      expect(await baseParticipation(WAVES, PEOPLE)).toEqual([
        // Legacy wave: stored types only.
        'legacy:author-a:10',
        'legacy:author-b:01',
        // author-a: ACTIVE and WINNER entries, plus stored PARTICIPATORY and
        // WINNER drops without a mapped entry.
        'native:author-a:11',
        // author-b: only a stored WINNER whose entry status the view ignores.
        'native:author-b:01',
        // author-c: a stored COMPETITION drop promoted by its ACTIVE entry.
        'native:author-c:10',
        // The unpublished competition is still the wave's native primary one:
        // the view maps its ACTIVE entry regardless of lifecycle.
        'unpublished:author-a:10',
        'unpublished:author-b:01'
      ]);
    });

    it('findAuthorWaveParticipationByDropContexts returns the view flags inside the facade', async () => {
      const contexts = WAVES.flatMap((wave_id) =>
        PEOPLE.map((author_id) => ({ wave_id, author_id }))
      );
      const inside = await withLegacyCompetitionGetFacade(() =>
        dropsDb.findAuthorWaveParticipationByDropContexts(contexts, {})
      );
      const flat = (
        result: Record<
          string,
          Record<string, { is_participant: boolean; is_winner: boolean }>
        >
      ) =>
        Object.entries(result)
          .flatMap(([waveId, byAuthor]) =>
            Object.entries(byAuthor)
              .filter(([, flags]) => flags.is_participant || flags.is_winner)
              .map(
                ([authorId, flags]) =>
                  `${waveId}:${authorId}:${Number(flags.is_participant)}${Number(flags.is_winner)}`
              )
          )
          .sort((a, b) => a.localeCompare(b));
      expect(flat(inside)).toEqual(await viewParticipation(WAVES, PEOPLE));
      // Outside the facade the stored types apply, which differ here.
      const outside = await dropsDb.findAuthorWaveParticipationByDropContexts(
        contexts,
        {}
      );
      expect(flat(outside)).not.toEqual(flat(inside));
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
