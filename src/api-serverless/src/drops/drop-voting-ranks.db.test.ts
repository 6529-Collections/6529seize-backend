import 'reflect-metadata';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  legacyGetView,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  DROP_RANK_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropVotingDb } from './drop-voting.db';

/**
 * The rank statements before they built the participant set from
 * competition entries and drops: every drop of the wave through the legacy
 * drops view. The new statements must return exactly these rows.
 */
const referenceRealtimeRanks = (dropIds: string[]) =>
  sqlExecutor.execute<{ drop_id: string; rnk: number }>(
    `WITH needed_waves AS (SELECT DISTINCT wave_id FROM ${legacyGetView(DROPS_TABLE)} WHERE id IN (:dropIds)),
     all_ranks AS (
       SELECT d.id AS drop_id,
              RANK() OVER (PARTITION BY d.wave_id
                           ORDER BY CAST(IFNULL(r.vote, 0) AS SIGNED) DESC,
                                    IFNULL(r.last_increased, d.created_at)) AS rnk
       FROM ${legacyGetView(DROPS_TABLE)} d
       LEFT JOIN ${legacyGetView(DROP_RANK_TABLE)} r ON r.drop_id = d.id
       WHERE d.drop_type = 'PARTICIPATORY'
         AND d.wave_id IN (SELECT wave_id FROM needed_waves))
     SELECT * FROM all_ranks WHERE drop_id IN (:dropIds)`,
    { dropIds }
  );

const referenceWeightedRanks = (dropIds: string[]) =>
  sqlExecutor.execute<{ drop_id: string; rnk: number }>(
    `with needed_waves as (select distinct wave_id from ${legacyGetView(DROPS_TABLE)} where id in (:dropIds)),
     weighted_waves as (
       select id as wave_id from ${legacyGetView(WAVES_TABLE)}
       where id in (select wave_id from needed_waves)
         and time_lock_ms is not null and time_lock_ms > 0),
     scoped_leaderboard as (
       select drop_id, vote, timestamp from ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)}
       where wave_id in (select wave_id from weighted_waves))
     select drop_id, rnk from (
       select /*+ NO_MERGE(r) */ d.id as drop_id,
              rank() over (partition by d.wave_id
                           order by cast(ifnull(r.vote, 0) as signed) desc,
                                    cast(ifnull(r.timestamp, d.created_at) as signed) asc) as rnk
       from ${legacyGetView(DROPS_TABLE)} d
       left join scoped_leaderboard r on r.drop_id = d.id
       where d.drop_type = 'PARTICIPATORY'
         and d.wave_id in (select wave_id from weighted_waves)) drop_ranks
     where drop_id in (:dropIds)`,
    { dropIds }
  );

const asRecord = (rows: { drop_id: string; rnk: number }[]) =>
  Object.fromEntries(rows.map((row) => [row.drop_id, Number(row.rnk)]));

const realtime = aWave(
  { type: WaveType.RANK, voting_period_start: 1, voting_period_end: 9e12 },
  { id: 'rk-realtime', serial_no: 1, name: 'Realtime' }
);
const other = aWave(
  { type: WaveType.RANK, voting_period_start: 1, voting_period_end: 9e12 },
  { id: 'rk-other', serial_no: 2, name: 'Other' }
);
const locked = aWave(
  {
    type: WaveType.RANK,
    voting_period_start: 1,
    voting_period_end: 9e12,
    time_lock_ms: 1000
  },
  { id: 'rk-locked', serial_no: 3, name: 'Locked' }
);
const waves = [realtime, other, locked];

async function insertDrop(
  waveId: string,
  id: string,
  {
    baseType = DropType.COMPETITION,
    entry = 'ACTIVE' as string | null,
    createdAt = 100
  } = {}
) {
  await sqlExecutor.execute(
    `insert into ${DROPS_TABLE} (id, wave_id, author_id, created_at, updated_at, title, parts_count, reply_to_drop_id, reply_to_part_id, drop_type, signature, hide_link_preview)
     values (:id, :waveId, 'rk-author', :createdAt, null, null, 1, null, null, :baseType, null, false)`,
    { id, waveId, createdAt, baseType }
  );
  if (entry === null) return;
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_ENTRIES_TABLE} (id, competition_id, wave_id, drop_id, submitter_id, status, config_version, submitted_at)
     values (:entryId, :competitionId, :waveId, :id, 'rk-author', :entry, 1, :createdAt)`,
    {
      entryId: legacyCompetitionEntryId(competitionId, id),
      competitionId,
      waveId,
      id,
      entry,
      createdAt
    }
  );
}

async function setRating(
  waveId: string,
  dropId: string,
  rating: number,
  lastIncreased: number | null
) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_ENTRY_RUNTIME_TABLE} (competition_id, entry_id, real_time_rating, last_increased_at, updated_at)
     values (:competitionId, :entryId, :rating, :lastIncreased, 1)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      rating,
      lastIncreased
    }
  );
}

async function setLeaderboard(
  waveId: string,
  dropId: string,
  rating: number,
  timestamp: number
) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} (competition_id, entry_id, drop_id, rating, real_time_rating, submitted_at, updated_at, ordering_time, decision_rating, published_at)
     values (:competitionId, :entryId, :dropId, :rating, 0, 1, :timestamp, :timestamp, :rating, :timestamp)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      dropId,
      rating,
      timestamp
    }
  );
}

async function setEntryStatus(waveId: string, dropId: string, status: string) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `update ${COMPETITION_ENTRIES_TABLE} set status = :status where id = :entryId`,
    { status, entryId: legacyCompetitionEntryId(competitionId, dropId) }
  );
}

/** Every kind of drop the participant set must include or leave out. */
async function seedWave(waveId: string, ranked: 'runtime' | 'leaderboard') {
  const id = (name: string) => `${waveId}-${name}`;
  const score = (name: string, rating: number, at: number | null) =>
    ranked === 'runtime'
      ? setRating(waveId, id(name), rating, at)
      : setLeaderboard(waveId, id(name), rating, at ?? 0);
  // Ties on vote, and on both keys (same rank, then a gap).
  for (const [name, rating, at] of [
    ['top', 10, 2_000],
    ['tie-early', 10, 1_000],
    ['tie-both', 10, 1_000],
    ['mid', 5, 3_000],
    ['negative', -3, 500]
  ] as const) {
    await insertDrop(waveId, id(name));
    await score(name, rating, at);
  }
  // Zero votes, no increase: no rank row (vote 0, ordered by created_at).
  await insertDrop(waveId, id('zero'), { createdAt: 50 });
  if (ranked === 'runtime') await setRating(waveId, id('zero'), 0, null);
  // An entry without any score row.
  await insertDrop(waveId, id('unscored'), { createdAt: 60 });
  // A base PARTICIPATORY drop with no entry is participatory in the view.
  await insertDrop(waveId, id('legacy'), {
    baseType: DropType.PARTICIPATORY,
    entry: null,
    createdAt: 70
  });
  // Not participatory: withdrawn, disqualified, winner, chat.
  await insertDrop(waveId, id('withdrawn'), {
    baseType: DropType.PARTICIPATORY,
    entry: 'WITHDRAWN'
  });
  await insertDrop(waveId, id('disqualified'), { entry: 'DISQUALIFIED' });
  await insertDrop(waveId, id('winner'), { entry: 'WINNER' });
  for (let i = 0; i < 20; i++)
    await insertDrop(waveId, id(`chat-${i}`), {
      baseType: DropType.CHAT,
      entry: null
    });
  // An active entry whose drop row was deleted.
  await insertDrop(waveId, id('deleted'));
  await score('deleted', 7, 100);
  await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = :id`, {
    id: id('deleted')
  });
  return [
    'top',
    'tie-early',
    'tie-both',
    'mid',
    'negative',
    'zero',
    'unscored',
    'legacy',
    'withdrawn',
    'disqualified',
    'winner',
    'chat-0',
    'deleted'
  ].map(id);
}

describeWithSeed('DropVotingDb rank participants', withWaves(waves), () => {
  // Called as the API calls them: inside the legacy facade scope, where the
  // executor rewrites base legacy tables into their views.
  const inner = new DropVotingDb(() => sqlExecutor);
  const repo = {
    getParticipationDropsRealtimeRanks: (ids: string[], ctx: object) =>
      withLegacyCompetitionGetFacade(() =>
        inner.getParticipationDropsRealtimeRanks(ids, ctx)
      ),
    getTimeLockedDropsWeightedVotes: (ids: string[], ctx: object) =>
      withLegacyCompetitionGetFacade(() =>
        inner.getTimeLockedDropsWeightedVotes(ids, ctx)
      )
  };

  beforeEach(async () => {
    for (const wave of waves) await seedNativeOriginalPrimaryFixture(wave);
  });

  it('ranks realtime participants exactly as the whole-wave view query does', async () => {
    const requested = [
      ...(await seedWave(realtime.id, 'runtime')),
      ...(await seedWave(other.id, 'runtime')).slice(0, 4)
    ];
    const reference = asRecord(await referenceRealtimeRanks(requested));
    expect(
      await repo.getParticipationDropsRealtimeRanks(requested, {})
    ).toEqual(reference);
    // The cases are really there: ties share a rank, then a gap.
    expect(reference[`${realtime.id}-tie-early`]).toBe(1);
    expect(reference[`${realtime.id}-tie-both`]).toBe(1);
    expect(reference[`${realtime.id}-top`]).toBe(3);
    expect(reference[`${realtime.id}-legacy`]).toBeDefined();
    for (const excluded of ['withdrawn', 'winner', 'chat-0', 'deleted'])
      expect(reference[`${realtime.id}-${excluded}`]).toBeUndefined();
  });

  it('follows an entry withdrawn between two reads', async () => {
    const requested = await seedWave(realtime.id, 'runtime');
    expect(
      await repo.getParticipationDropsRealtimeRanks(requested, {})
    ).toEqual(asRecord(await referenceRealtimeRanks(requested)));
    await setEntryStatus(realtime.id, `${realtime.id}-tie-early`, 'WITHDRAWN');
    const after = await repo.getParticipationDropsRealtimeRanks(requested, {});
    expect(after).toEqual(asRecord(await referenceRealtimeRanks(requested)));
    expect(after[`${realtime.id}-tie-early`]).toBeUndefined();
    expect(after[`${realtime.id}-tie-both`]).toBe(1);
  });

  it('ranks time-locked participants exactly as the whole-wave view query does', async () => {
    const requested = [
      ...(await seedWave(locked.id, 'leaderboard')),
      ...(await seedWave(realtime.id, 'runtime')).slice(0, 3)
    ];
    const reference = asRecord(await referenceWeightedRanks(requested));
    expect(await repo.getTimeLockedDropsWeightedVotes(requested, {})).toEqual(
      reference
    );
    expect(Object.keys(reference).length).toBeGreaterThan(5);
    await setEntryStatus(locked.id, `${locked.id}-top`, 'WITHDRAWN');
    expect(await repo.getTimeLockedDropsWeightedVotes(requested, {})).toEqual(
      asRecord(await referenceWeightedRanks(requested))
    );
  });
});
