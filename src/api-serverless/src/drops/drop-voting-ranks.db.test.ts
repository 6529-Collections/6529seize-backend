import 'reflect-metadata';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  legacyGetView,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { SqlExecutor, sqlExecutor } from '@/sql-executor';
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

/**
 * The submission voting summaries statement before its ranks read the
 * waves' participant candidates: every drop of the wave through the legacy
 * drops view. The new statement must return exactly these rows.
 */
const referenceSummariesSql = `
  with target_submissions as (
    select id, wave_id, drop_type, created_at
    from ${legacyGetView(DROPS_TABLE)}
    where id in (:dropIds)
      and drop_type in ('${DropType.PARTICIPATORY}', '${DropType.WINNER}')
  ),
  target_waves as (
    select distinct wave_id
    from target_submissions
  ),
  rank_waves as (
    select distinct t.wave_id,
      (w.time_lock_ms is not null and w.time_lock_ms > 0) as weighted
    from target_submissions t
    join ${legacyGetView(WAVES_TABLE)} w on w.id = t.wave_id
    where t.drop_type = '${DropType.PARTICIPATORY}'
  ),
  scoped_realtime_votes as (
    select drop_id, vote, last_increased
    from ${legacyGetView(DROP_RANK_TABLE)}
    where wave_id in (select wave_id from rank_waves where weighted = 0)
  ),
  scoped_leaderboard as (
    select drop_id, vote, vote_on_decision_time, timestamp,
      over_threshold_since_ms
    from ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)}
    where wave_id in (select wave_id from rank_waves)
  ),
  vote_counts as (
    select
      drop_id,
      sum(votes) as tally,
      count(distinct voter_id) as voters_count
    from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
    where drop_id in (:dropIds)
      and votes <> 0
    group by 1
  ),
  winner_voter_counts as (
    select drop_id, count(nullif(votes, 0)) as voters_count
    from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)}
    where drop_id in (:dropIds)
    group by 1
  ),
  decision_counts as (
    select wave_id, count(*) as decisions_done
    from ${legacyGetView(WAVES_DECISIONS_TABLE)}
    where wave_id in (select wave_id from target_waves)
    group by 1
  ),
  realtime_ranks as (
    select drop_id, rnk
    from (
      select /*+ NO_MERGE(r) */
        d.id as drop_id,
        rank() over (
          partition by d.wave_id
          order by cast(ifnull(r.vote, 0) as signed) desc,
            ifnull(r.last_increased, d.created_at) asc
        ) as rnk
      from ${legacyGetView(DROPS_TABLE)} d
      left join scoped_realtime_votes r on r.drop_id = d.id
      where d.drop_type = '${DropType.PARTICIPATORY}'
        and d.wave_id in (select wave_id from rank_waves where weighted = 0)
    ) ranked
    where drop_id in (:dropIds)
  ),
  weighted_ranks as (
    select drop_id, rnk
    from (
      select /*+ NO_MERGE(lb) */
        d.id as drop_id,
        rank() over (
          partition by d.wave_id
          order by cast(ifnull(lb.vote, 0) as signed) desc,
            cast(ifnull(lb.timestamp, d.created_at) as signed) asc
        ) as rnk
      from ${legacyGetView(DROPS_TABLE)} d
      left join scoped_leaderboard lb on lb.drop_id = d.id
      where d.drop_type = '${DropType.PARTICIPATORY}'
        and d.wave_id in (select wave_id from rank_waves where weighted = 1)
    ) ranked
    where drop_id in (:dropIds)
  )
  select /*+ NO_MERGE(lb) */
    t.id as drop_id,
    t.drop_type as status,
    w.type as wave_type,
    w.winning_min_threshold as winning_min_threshold,
    w.time_lock_ms as time_lock_ms,
    case
      when t.drop_type = '${DropType.WINNER}' then 0
      when w.type <> 'CHAT'
        and (w.voting_period_start is null or w.voting_period_start < :now)
        and (w.voting_period_end is null or w.voting_period_end > :now)
        and not (
          w.type = 'APPROVE'
          and w.max_winners is not null
          and coalesce(dc.decisions_done, 0) >= w.max_winners
        )
      then 1
      else 0
    end as is_open,
    case
      when t.drop_type = '${DropType.WINNER}' then null
      when w.type = 'APPROVE'
        and w.time_lock_ms is not null
        and w.time_lock_ms > 0
      then lb.over_threshold_since_ms
      else null
    end as over_threshold_since_ms,
    case
      when t.drop_type = '${DropType.WINNER}' then wd.decision_time
      else null
    end as won_at,
    case
      when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
      else coalesce(vc.tally, 0)
    end as total_votes_given,
    case
      when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
      else coalesce(lb.vote, vc.tally, 0)
    end as current_calculated_vote,
    case
      when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
      else coalesce(lb.vote_on_decision_time, vc.tally, 0)
    end as predicted_final_vote,
    case
      when t.drop_type = '${DropType.WINNER}' then coalesce(wvc.voters_count, 0)
      else coalesce(vc.voters_count, 0)
    end as voters_count,
    (t.drop_type <> '${DropType.WINNER}' or wvc.drop_id is not null) as voters_count_available,
    case
      when t.drop_type = '${DropType.WINNER}' then coalesce(wd.ranking, 0)
      else coalesce(wr.rnk, rr.rnk, 0)
    end as place,
    w.forbid_negative_votes as forbid_negative_votes
  from target_submissions t
  join ${legacyGetView(WAVES_TABLE)} w on w.id = t.wave_id
  left join vote_counts vc on vc.drop_id = t.id
  left join scoped_leaderboard lb on lb.drop_id = t.id
  left join realtime_ranks rr on rr.drop_id = t.id
  left join weighted_ranks wr on wr.drop_id = t.id
  left join ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wd on wd.drop_id = t.id
  left join winner_voter_counts wvc on wvc.drop_id = t.id
  left join decision_counts dc on dc.wave_id = t.wave_id
`;

/**
 * The repository's executor, with the summaries statement replaced by the
 * reference when `useReference` is set: everything around it (the row
 * mapping, the over-threshold history read) is the same code. Records the
 * summaries statement's rows.
 */
function summariesExecutor(
  useReference: boolean,
  rows: Record<string, unknown>[][]
): SqlExecutor {
  return new Proxy(sqlExecutor, {
    get(target, property, receiver) {
      if (property !== 'execute') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (sql: string, params?: object, options?: object) => {
        const isSummaries = sql.includes('target_submissions');
        const result = await target.execute<Record<string, unknown>>(
          isSummaries && useReference ? referenceSummariesSql : sql,
          params as Record<string, unknown>,
          options
        );
        if (isSummaries) rows.push(result);
        return result;
      };
    }
  });
}

const byDropId = (rows: Record<string, unknown>[]) =>
  Object.fromEntries(rows.map((row) => [row.drop_id, row]));

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
const approve = aWave(
  {
    type: WaveType.APPROVE,
    voting_period_start: 1,
    voting_period_end: 9e12,
    time_lock_ms: 1000,
    winning_min_threshold: 5,
    max_winners: 2,
    forbid_negative_votes: true
  },
  { id: 'rk-approve', serial_no: 4, name: 'Approve' }
);
const waves = [realtime, other, locked, approve];

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

async function setVote(
  waveId: string,
  dropId: string,
  voterId: string,
  votes: number
) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_VOTES_TABLE} (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at)
     values (uuid(), :competitionId, :entryId, :voterId, :votes, abs(:votes), 1, 1)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      voterId,
      votes
    }
  );
}

/** A decision that made `dropId` a winner, with one winner vote. */
async function decideWinner(waveId: string, dropId: string, rank: number) {
  const competitionId = legacyCompetitionId(waveId);
  const entryId = legacyCompetitionEntryId(competitionId, dropId);
  const decisionId = legacyCompetitionDecisionId(competitionId, 1000);
  await sqlExecutor.execute(
    `insert ignore into ${COMPETITION_DECISIONS_TABLE} (id, competition_id, scheduled_at, decided_at, status, execution_key, created_at)
     values (:decisionId, :competitionId, 1000, 1000, 'COMPLETED', :decisionId, 1000)`,
    { decisionId, competitionId }
  );
  await sqlExecutor.execute(
    `insert into ${COMPETITION_DECISION_WINNERS_TABLE} (decision_id, entry_id, competition_id, \`rank\`, final_rating, created_at)
     values (:decisionId, :entryId, :competitionId, :rank, 42, 1000)`,
    { decisionId, entryId, competitionId, rank }
  );
  await sqlExecutor.execute(
    `update ${COMPETITION_ENTRIES_TABLE} set status = 'WINNER', won_at = 1000, decision_id = :decisionId, \`rank\` = :rank where id = :entryId`,
    { decisionId, rank, entryId }
  );
  await sqlExecutor.execute(
    `insert into ${COMPETITION_WINNER_VOTES_TABLE} (competition_id, decision_id, entry_id, voter_profile_id, value)
     values (:competitionId, :decisionId, :entryId, 'rk-voter-1', 3)`,
    { competitionId, decisionId, entryId }
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

  /** Votes and a decided winner, so every summary field has data. */
  async function seedVotingState(waveId: string) {
    await setVote(waveId, `${waveId}-top`, 'rk-voter-1', 6);
    await setVote(waveId, `${waveId}-top`, 'rk-voter-2', 4);
    await setVote(waveId, `${waveId}-mid`, 'rk-voter-1', 5);
    await setVote(waveId, `${waveId}-negative`, 'rk-voter-2', -3);
    await decideWinner(waveId, `${waveId}-winner`, 1);
  }

  /** Summaries from the new statement and from the reference statement. */
  async function summariesAndReference(requested: string[]) {
    const rows: Record<string, unknown>[][] = [];
    const referenceRows: Record<string, unknown>[][] = [];
    const summaries = await withLegacyCompetitionGetFacade(() =>
      new DropVotingDb(() =>
        summariesExecutor(false, rows)
      ).getDropV2SubmissionVotingSummaries(requested, {})
    );
    const reference = await withLegacyCompetitionGetFacade(() =>
      new DropVotingDb(() =>
        summariesExecutor(true, referenceRows)
      ).getDropV2SubmissionVotingSummaries(requested, {})
    );
    expect(rows).toHaveLength(1);
    expect(referenceRows).toHaveLength(1);
    return {
      summaries,
      reference,
      rows: byDropId(rows[0]),
      referenceRows: byDropId(referenceRows[0])
    };
  }

  it('returns the same voting summaries, every field, as the whole-wave statement', async () => {
    const requested: string[] = [];
    for (const [wave, ranked] of [
      [realtime, 'runtime'],
      [locked, 'leaderboard'],
      [approve, 'leaderboard']
    ] as const) {
      requested.push(...(await seedWave(wave.id, ranked)));
      await seedVotingState(wave.id);
    }
    requested.push(...(await seedWave(other.id, 'runtime')).slice(0, 3));
    const { summaries, reference, rows, referenceRows } =
      await summariesAndReference(requested);
    // Every column of every row, then every field of the mapped summaries.
    expect(rows).toEqual(referenceRows);
    expect(summaries).toEqual(reference);
    // The cases are really there.
    expect(reference[`${realtime.id}-tie-early`].place).toBe(1);
    expect(reference[`${realtime.id}-top`].place).toBe(3);
    expect(reference[`${realtime.id}-top`].total_votes_given).toBe(10);
    expect(reference[`${realtime.id}-top`].voters_count).toBe(2);
    expect(reference[`${locked.id}-top`].place).toBeGreaterThan(0);
    expect(reference[`${approve.id}-top`].place).toBeGreaterThan(0);
    expect(reference[`${realtime.id}-winner`]).toMatchObject({
      status: DropType.WINNER,
      place: 1,
      current_calculated_vote: 42
    });
    expect(reference[`${realtime.id}-legacy`].status).toBe(
      DropType.PARTICIPATORY
    );
    for (const excluded of ['withdrawn', 'disqualified', 'chat-0', 'deleted'])
      expect(reference[`${realtime.id}-${excluded}`]).toBeUndefined();
  });

  it('follows an entry withdrawn between two summary reads', async () => {
    const requested = await seedWave(realtime.id, 'runtime');
    await seedVotingState(realtime.id);
    const before = await summariesAndReference(requested);
    expect(before.rows).toEqual(before.referenceRows);
    expect(before.summaries).toEqual(before.reference);
    await setEntryStatus(realtime.id, `${realtime.id}-tie-early`, 'WITHDRAWN');
    const after = await summariesAndReference(requested);
    expect(after.rows).toEqual(after.referenceRows);
    expect(after.summaries).toEqual(after.reference);
    expect(after.reference[`${realtime.id}-tie-early`]).toBeUndefined();
    expect(after.reference[`${realtime.id}-tie-both`].place).toBe(1);
  });
});
