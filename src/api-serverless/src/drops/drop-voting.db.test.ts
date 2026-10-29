import {
  legacyCompetitionId,
  legacyCompetitionEntryId,
  legacyCompetitionDecisionId
} from '@/competitions/competition-id';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE
} from '@/constants';
import { CompetitionRepository } from '@/competitions/competition.repository';
import 'reflect-metadata';
import fc from 'fast-check';
import {
  COMPETITIONS_TABLE,
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { Time } from '@/time';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropVotingDb } from './drop-voting.db';

describe('DropVotingDb.getDropV2SubmissionVotingSummaries', () => {
  function createSummaryRow(overrides: Record<string, unknown>) {
    return {
      drop_id: 'drop-1',
      status: DropType.PARTICIPATORY,
      wave_type: 'APPROVE',
      winning_min_threshold: 100,
      time_lock_ms: null,
      is_open: 1,
      over_threshold_since_ms: null,
      won_at: null,
      total_votes_given: 99,
      current_calculated_vote: 99,
      predicted_final_vote: 99,
      voters_count: 1,
      place: 1,
      forbid_negative_votes: 0,
      ...overrides
    };
  }

  it('does not query real vote history when no drop is currently over threshold', async () => {
    const execute = jest.fn().mockResolvedValueOnce([createSummaryRow({})]);
    const service = new DropVotingDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await service.getDropV2SubmissionVotingSummaries(
      ['drop-1'],
      {}
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).not.toContain(
      DROP_REAL_VOTE_IN_TIME_TABLE
    );
    expect(result['drop-1']?.over_threshold_since_ms).toBeNull();
  });

  it('queries real vote history only for current over-threshold candidates', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        createSummaryRow({
          drop_id: 'over-threshold-drop',
          total_votes_given: 101
        }),
        createSummaryRow({
          drop_id: 'below-threshold-drop',
          total_votes_given: 99
        })
      ])
      .mockResolvedValueOnce([
        {
          drop_id: 'over-threshold-drop',
          over_threshold_since_ms: 1234
        }
      ]);
    const service = new DropVotingDb(
      () =>
        ({
          execute
        }) as any
    );

    const result = await service.getDropV2SubmissionVotingSummaries(
      ['over-threshold-drop', 'below-threshold-drop'],
      {}
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toMatchObject({
      dropIds: ['over-threshold-drop']
    });
    expect(result['over-threshold-drop']?.over_threshold_since_ms).toBe(1234);
    expect(result['below-threshold-drop']?.over_threshold_since_ms).toBeNull();
  });
});

const repo = new DropVotingDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const realtimeWave = aWave(
  {
    type: WaveType.APPROVE,
    voting_period_start: 1,
    voting_period_end: 9999999999999,
    winning_min_threshold: 100,
    forbid_negative_votes: true
  },
  { id: 'summary-realtime-wave', serial_no: 1, name: 'Realtime Summary' }
);

const timeLockedWave = aWave(
  {
    type: WaveType.RANK,
    voting_period_start: 1,
    voting_period_end: 9999999999999,
    time_lock_ms: 1000
  },
  { id: 'summary-time-locked-wave', serial_no: 2, name: 'Weighted Summary' }
);

const winnerWave = aWave(
  {
    type: WaveType.APPROVE,
    voting_period_start: 1,
    voting_period_end: 9999999999999
  },
  { id: 'summary-winner-wave', serial_no: 3, name: 'Winner Summary' }
);

const otherTimeLockedWave = aWave(
  { type: WaveType.RANK, time_lock_ms: 1000 },
  { id: 'summary-other-weighted-wave', serial_no: 4, name: 'Other Weighted' }
);

async function insertDrop({
  id,
  waveId,
  dropType,
  createdAt
}: {
  id: string;
  waveId: string;
  dropType: DropType;
  createdAt: number;
}) {
  await sqlExecutor.execute(
    `
      insert into ${DROPS_TABLE} (
        id,
        wave_id,
        author_id,
        created_at,
        updated_at,
        title,
        parts_count,
        reply_to_drop_id,
        reply_to_part_id,
        drop_type,
        signature,
        hide_link_preview
      )
      values (
        :id,
        :waveId,
        'summary-author',
        :createdAt,
        null,
        null,
        1,
        null,
        null,
        :dropType,
        null,
        false
      )
    `,
    { id, waveId, createdAt, dropType }
  );
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at) values (:entryId,:competitionId,:waveId,:id,'summary-author',:status,1,:createdAt)`,
    {
      entryId: legacyCompetitionEntryId(competitionId, id),
      competitionId,
      waveId,
      id,
      createdAt,
      status: dropType === DropType.WINNER ? 'WINNER' : 'ACTIVE'
    }
  );
}

async function insertDropRank({
  dropId,
  waveId,
  vote,
  lastIncreased
}: {
  dropId: string;
  waveId: string;
  vote: number;
  lastIncreased: number;
}) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_ENTRY_RUNTIME_TABLE} (competition_id,entry_id,real_time_rating,last_increased_at,updated_at) values (:competitionId,:entryId,:vote,:lastIncreased,:lastIncreased)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      vote,
      lastIncreased
    }
  );
}

async function insertVoteState({
  voterId,
  dropId,
  waveId,
  votes
}: {
  voterId: string;
  dropId: string;
  waveId: string;
  votes: number;
}) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (uuid(),:competitionId,:entryId,:voterId,:votes,abs(:votes),1,1)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      voterId,
      votes
    }
  );
}

async function insertRealVote({
  dropId,
  waveId,
  timestamp,
  vote
}: {
  dropId: string;
  waveId: string;
  timestamp: number;
  vote: number;
}) {
  const competitionId = legacyCompetitionId(waveId);
  const [row] = await sqlExecutor.execute<{ sequence: number }>(
    `select coalesce(max(sequence),0)+1 as sequence from ${COMPETITION_SCORE_HISTORY_TABLE} where competition_id=:competitionId and kind='AGGREGATE'`,
    { competitionId }
  );
  await sqlExecutor.execute(
    `insert into ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at) values (:competitionId,'AGGREGATE',:sequence,:entryId,:dropId,'',:vote,:timestamp)`,
    {
      competitionId,
      sequence: row.sequence,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      dropId,
      vote,
      timestamp
    }
  );
}

async function insertLeaderboardEntry({
  dropId,
  waveId,
  vote,
  timestamp,
  voteOnDecisionTime
}: {
  dropId: string;
  waveId: string;
  vote: number;
  timestamp: number;
  voteOnDecisionTime: number;
}) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} (competition_id,entry_id,drop_id,rating,real_time_rating,submitted_at,updated_at,ordering_time,decision_rating,published_at) values (:competitionId,:entryId,:dropId,:vote,0,1,:timestamp,:timestamp,:voteOnDecisionTime,:timestamp)`,
    {
      competitionId,
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      dropId,
      vote,
      timestamp,
      voteOnDecisionTime
    }
  );
}

async function insertWinner(
  dropId: string,
  waveId: string,
  rank: number,
  value: number
) {
  const competitionId = legacyCompetitionId(waveId),
    entryId = legacyCompetitionEntryId(competitionId, dropId),
    decisionId = legacyCompetitionDecisionId(competitionId, 1000);
  await sqlExecutor.execute(
    `insert ignore into ${COMPETITION_DECISIONS_TABLE} (id,competition_id,scheduled_at,decided_at,status,execution_key,created_at) values (:decisionId,:competitionId,1000,1000,'COMPLETED',:decisionId,1000)`,
    { decisionId, competitionId }
  );
  await sqlExecutor.execute(
    `insert into ${COMPETITION_DECISION_WINNERS_TABLE} (decision_id,entry_id,competition_id,\`rank\`,final_rating,created_at) values (:decisionId,:entryId,:competitionId,:rank,:value,1000)`,
    { decisionId, entryId, competitionId, rank, value }
  );
  await sqlExecutor.execute(
    `update ${COMPETITION_ENTRIES_TABLE} set status='WINNER',won_at=1000,decision_id=:decisionId,\`rank\`=:rank where id=:entryId`,
    { decisionId, rank, entryId }
  );
}
async function insertWinnerVoter(
  dropId: string,
  waveId: string,
  voter: string,
  value: number
) {
  const competitionId = legacyCompetitionId(waveId);
  await sqlExecutor.execute(
    `insert into ${COMPETITION_WINNER_VOTES_TABLE} (competition_id,decision_id,entry_id,voter_profile_id,value) values (:competitionId,:decisionId,:entryId,:voter,:value)`,
    {
      competitionId,
      decisionId: legacyCompetitionDecisionId(competitionId, 1000),
      entryId: legacyCompetitionEntryId(competitionId, dropId),
      voter,
      value
    }
  );
}
describeWithSeed(
  'DropVotingDb.getDropV2SubmissionVotingSummaries',
  withWaves([realtimeWave, timeLockedWave, winnerWave, otherTimeLockedWave]),
  () => {
    beforeEach(async () => {
      for (const wave of [
        realtimeWave,
        timeLockedWave,
        winnerWave,
        otherTimeLockedWave
      ])
        await seedNativeOriginalPrimaryFixture(wave);
    });

    it('ranks subsets independently across multiple time-locked waves', async () => {
      for (const wave of [timeLockedWave, otherTimeLockedWave]) {
        for (const [index, vote] of Array.from([10, 5, 5].entries())) {
          const dropId = `${wave.id}-peer-${index}`;
          await insertDrop({
            id: dropId,
            waveId: wave.id,
            dropType: DropType.PARTICIPATORY,
            createdAt: 100
          });
          await insertLeaderboardEntry({
            dropId,
            waveId: wave.id,
            vote,
            timestamp: 1000,
            voteOnDecisionTime: vote
          });
        }
      }
      const requested = [
        `${timeLockedWave.id}-peer-1`,
        `${otherTimeLockedWave.id}-peer-0`
      ];
      const result = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          repo.getTimeLockedDropsWeightedVotes(requested, { connection })
      );
      expect(result).toEqual({ [requested[0]]: 2, [requested[1]]: 1 });
    });
    it('keeps ranks scoped to each wave in a mixed submission and winner batch', async () => {
      for (const wave of [realtimeWave, timeLockedWave]) {
        for (const [index, vote] of Array.from([5, 10, 5].entries())) {
          const dropId = `${wave.id}-mixed-${index}`;
          await insertDrop({
            id: dropId,
            waveId: wave.id,
            dropType: DropType.PARTICIPATORY,
            createdAt: 100 + index
          });
          // Realtime and weighted orders intentionally disagree.
          await insertDropRank({
            dropId,
            waveId: wave.id,
            vote: -vote,
            lastIncreased: 1000
          });
          await insertLeaderboardEntry({
            dropId,
            waveId: wave.id,
            vote,
            timestamp: 1000,
            voteOnDecisionTime: vote + 1
          });
        }
      }
      await insertDrop({
        id: 'mixed-winner',
        waveId: winnerWave.id,
        dropType: DropType.WINNER,
        createdAt: 100
      });
      await insertWinner('mixed-winner', winnerWave.id, 7, 42);
      const ids = [
        `${realtimeWave.id}-mixed-0`,
        `${realtimeWave.id}-mixed-1`,
        `${realtimeWave.id}-mixed-2`,
        `${timeLockedWave.id}-mixed-0`,
        `${timeLockedWave.id}-mixed-1`,
        `${timeLockedWave.id}-mixed-2`,
        'mixed-winner'
      ];
      const summaries = await repo.getDropV2SubmissionVotingSummaries(ids, ctx);
      // Exact score/time ties share a rank, including the resulting rank gap.
      expect(ids.map((id) => summaries[id].place)).toEqual([
        1, 3, 1, 2, 1, 2, 7
      ]);
      expect(summaries[ids[0]].current_calculated_vote).toBe(5);
      expect(summaries[ids[0]].predicted_final_vote).toBe(6);
      expect(summaries[ids[3]].current_calculated_vote).toBe(5);
      expect(summaries[ids[3]].predicted_final_vote).toBe(6);
      expect(summaries['mixed-winner'].current_calculated_vote).toBe(42);
      const weightedRanks = await repo.getTimeLockedDropsWeightedVotes(
        [ids[0], ids[3], ids[4], 'mixed-winner', 'missing-drop'],
        ctx
      );
      expect(weightedRanks).toEqual({ [ids[3]]: 2, [ids[4]]: 1 });
    });

    it.each([WaveType.RANK, WaveType.APPROVE])(
      'uses creation-time ranks before a time-locked %s wave has a leaderboard',
      async (waveType) => {
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set type = :waveType where id = :id`,
          { waveType, id: legacyCompetitionId(timeLockedWave.id) }
        );
        const createdAt = [300, 100, 100];
        const ids = createdAt.map(
          (_, index) => `unpublished-weighted-${index}`
        );
        for (const [index, dropId] of Array.from(ids.entries())) {
          await insertDrop({
            id: dropId,
            waveId: timeLockedWave.id,
            dropType: DropType.PARTICIPATORY,
            createdAt: createdAt[index]
          });
          // Live scores must not replace the absent weighted snapshot.
          await insertDropRank({
            dropId,
            waveId: timeLockedWave.id,
            vote: 100 - index,
            lastIncreased: 1000 + index
          });
        }
        const summaries = await repo.getDropV2SubmissionVotingSummaries(
          ids,
          ctx
        );
        expect(ids.map((id) => summaries[id].place)).toEqual([3, 1, 1]);
        const weightedRanks = await repo.getTimeLockedDropsWeightedVotes(
          ids,
          ctx
        );
        expect(ids.map((id) => weightedRanks[id])).toEqual([3, 1, 1]);
        expect(ids.map((id) => summaries[id].current_calculated_vote)).toEqual([
          0, 0, 0
        ]);
      }
    );

    it.each([false, true])(
      'preserves numeric ranks, exact ties and missing scores (weighted=%s)',
      async (weighted) => {
        const wave = weighted ? timeLockedWave : realtimeWave;
        await fc.assert(
          fc.asyncProperty(
            fc.array(
              fc.record({
                vote: fc.integer({ min: -12, max: 12 }),
                timestamp: fc.integer({ min: 100, max: 103 }),
                scored: fc.boolean()
              }),
              { minLength: 2, maxLength: 8 }
            ),
            async (entries) => {
              for (const table of [
                COMPETITION_ENTRY_RUNTIME_TABLE,
                COMPETITION_LEADERBOARD_ENTRIES_TABLE,
                COMPETITION_ENTRIES_TABLE,
                DROPS_TABLE
              ]) {
                await sqlExecutor.execute(`delete from ${table}`);
              }
              for (const [index, entry] of Array.from(entries.entries())) {
                const dropId = `generated-rank-${index}`;
                await insertDrop({
                  id: dropId,
                  waveId: wave.id,
                  dropType: DropType.PARTICIPATORY,
                  createdAt: entry.timestamp
                });
                if (!entry.scored) continue;
                await insertDropRank({
                  dropId,
                  waveId: wave.id,
                  vote: entry.vote,
                  lastIncreased: entry.timestamp
                });
                if (weighted) {
                  await insertLeaderboardEntry({
                    dropId,
                    waveId: wave.id,
                    vote: entry.vote,
                    timestamp: entry.timestamp,
                    voteOnDecisionTime: entry.vote
                  });
                }
              }
              // Request a subset: unrequested competitors must still affect rank.
              const requested = [0, entries.length - 1];
              const summaries = await repo.getDropV2SubmissionVotingSummaries(
                requested.map((index) => `generated-rank-${index}`),
                ctx
              );
              const weightedRanks = weighted
                ? await repo.getTimeLockedDropsWeightedVotes(
                    requested.map((index) => `generated-rank-${index}`),
                    ctx
                  )
                : {};
              for (const index of requested) {
                const entry = entries[index];
                const vote = entry.scored ? entry.vote : 0;
                const expectedRank =
                  1 +
                  entries.filter((other) => {
                    const otherVote = other.scored ? other.vote : 0;
                    return (
                      otherVote > vote ||
                      (otherVote === vote && other.timestamp < entry.timestamp)
                    );
                  }).length;
                expect(summaries[`generated-rank-${index}`].place).toBe(
                  expectedRank
                );
                if (weighted) {
                  expect(weightedRanks[`generated-rank-${index}`]).toBe(
                    expectedRank
                  );
                }
              }
            }
          ),
          { numRuns: 12 }
        );
      }
    );

    it('returns participatory realtime rank and voting summary', async () => {
      await insertDrop({
        id: 'realtime-drop-1',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 100
      });
      await insertDrop({
        id: 'realtime-drop-2',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 200
      });
      await insertDrop({
        id: 'realtime-drop-3',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 300
      });
      await insertDrop({
        id: 'realtime-drop-4',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 400
      });

      await insertDropRank({
        dropId: 'realtime-drop-1',
        waveId: realtimeWave.id,
        vote: 10,
        lastIncreased: 1000
      });
      await insertDropRank({
        dropId: 'realtime-drop-2',
        waveId: realtimeWave.id,
        vote: 15,
        lastIncreased: 2000
      });
      await insertDropRank({
        dropId: 'realtime-drop-3',
        waveId: realtimeWave.id,
        vote: 10,
        lastIncreased: 900
      });
      await insertDropRank({
        dropId: 'realtime-drop-4',
        waveId: realtimeWave.id,
        vote: 10,
        lastIncreased: 900
      });
      await insertVoteState({
        voterId: 'voter-1',
        dropId: 'realtime-drop-1',
        waveId: realtimeWave.id,
        votes: 3
      });
      await insertVoteState({
        voterId: 'voter-2',
        dropId: 'realtime-drop-1',
        waveId: realtimeWave.id,
        votes: 4
      });

      const result = await repo.getDropV2SubmissionVotingSummaries(
        ['realtime-drop-1', 'realtime-drop-3'],
        ctx
      );

      expect(result['realtime-drop-1']).toMatchObject({
        drop_id: 'realtime-drop-1',
        status: DropType.PARTICIPATORY,
        is_open: true,
        total_votes_given: 7,
        current_calculated_vote: 7,
        predicted_final_vote: 7,
        voters_count: 2,
        place: 4,
        forbid_negative_votes: true
      });
      expect(result['realtime-drop-3']).toMatchObject({
        drop_id: 'realtime-drop-3',
        place: 2
      });
    });

    it('orders text-backed realtime vote totals numerically in submission badges and legacy drop ranks', async () => {
      const votes = [9, 12, -2, -5, -14];
      const dropIds = votes.map((_, index) => `numeric-summary-${index}`);
      for (let index = 0; index < votes.length; index++) {
        const vote = votes[index];
        await insertDrop({
          id: dropIds[index],
          waveId: realtimeWave.id,
          dropType: DropType.PARTICIPATORY,
          createdAt: 100 + index
        });
        await insertDropRank({
          dropId: dropIds[index],
          waveId: realtimeWave.id,
          vote,
          lastIncreased: 1000 + index
        });
      }
      const result = await repo.getDropV2SubmissionVotingSummaries(
        dropIds,
        ctx
      );
      expect(dropIds.map((id) => result[id].place)).toEqual([2, 1, 3, 4, 5]);
      const legacyRanks = await repo.getParticipationDropsRealtimeRanks(
        dropIds,
        ctx
      );
      expect(dropIds.map((id) => legacyRanks[id])).toEqual([2, 1, 3, 4, 5]);
    });

    it('uses weighted rank and rates for time-locked participatory drops', async () => {
      await insertDrop({
        id: 'weighted-drop-1',
        waveId: timeLockedWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 100
      });
      await insertDrop({
        id: 'weighted-drop-2',
        waveId: timeLockedWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 200
      });
      await insertDrop({
        id: 'weighted-drop-3',
        waveId: timeLockedWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 300
      });
      await insertLeaderboardEntry({
        dropId: 'weighted-drop-1',
        waveId: timeLockedWave.id,
        vote: 5,
        timestamp: 1000,
        voteOnDecisionTime: 6
      });
      await insertLeaderboardEntry({
        dropId: 'weighted-drop-2',
        waveId: timeLockedWave.id,
        vote: 10,
        timestamp: 2000,
        voteOnDecisionTime: 10
      });
      await insertLeaderboardEntry({
        dropId: 'weighted-drop-3',
        waveId: timeLockedWave.id,
        vote: 5,
        timestamp: 900,
        voteOnDecisionTime: 5
      });

      const result = await repo.getDropV2SubmissionVotingSummaries(
        ['weighted-drop-1'],
        ctx
      );

      expect(result['weighted-drop-1']).toMatchObject({
        drop_id: 'weighted-drop-1',
        status: DropType.PARTICIPATORY,
        current_calculated_vote: 5,
        predicted_final_vote: 6,
        place: 3
      });
    });

    it('returns over-threshold start only for active approve drops currently over threshold', async () => {
      await insertDrop({
        id: 'over-threshold-drop',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 100
      });
      await insertDrop({
        id: 'below-threshold-drop',
        waveId: realtimeWave.id,
        dropType: DropType.PARTICIPATORY,
        createdAt: 200
      });
      await insertDrop({
        id: 'winner-threshold-drop',
        waveId: realtimeWave.id,
        dropType: DropType.WINNER,
        createdAt: 300
      });
      await insertVoteState({
        voterId: 'voter-1',
        dropId: 'over-threshold-drop',
        waveId: realtimeWave.id,
        votes: 150
      });
      await insertVoteState({
        voterId: 'voter-2',
        dropId: 'below-threshold-drop',
        waveId: realtimeWave.id,
        votes: 99
      });
      await insertRealVote({
        dropId: 'over-threshold-drop',
        waveId: realtimeWave.id,
        timestamp: 1_000,
        vote: 0
      });
      await insertRealVote({
        dropId: 'over-threshold-drop',
        waveId: realtimeWave.id,
        timestamp: 2_000,
        vote: 101
      });
      await insertRealVote({
        dropId: 'over-threshold-drop',
        waveId: realtimeWave.id,
        timestamp: 3_000,
        vote: 150
      });
      await insertRealVote({
        dropId: 'below-threshold-drop',
        waveId: realtimeWave.id,
        timestamp: 1_000,
        vote: 99
      });
      await insertWinner('winner-threshold-drop', realtimeWave.id, 1, 150);

      const result = await repo.getDropV2SubmissionVotingSummaries(
        [
          'over-threshold-drop',
          'below-threshold-drop',
          'winner-threshold-drop'
        ],
        ctx
      );

      expect(result['over-threshold-drop'].over_threshold_since_ms).toBe(2_000);
      expect(result['below-threshold-drop'].over_threshold_since_ms).toBeNull();
      expect(
        result['winner-threshold-drop'].over_threshold_since_ms
      ).toBeNull();
    });

    it.each([false, true])(
      'distinguishes absent winner history from saved zero votes (saved=%s)',
      async (saved) => {
        const dropId = 'winner-with-zero-voters';
        await insertDrop({
          id: dropId,
          waveId: winnerWave.id,
          dropType: DropType.WINNER,
          createdAt: 100
        });
        await insertWinner(dropId, winnerWave.id, 1, 42);
        // Current allocations must not be presented as the missing frozen decision snapshot.
        await insertVoteState({
          voterId: 'current-voter',
          dropId,
          waveId: winnerWave.id,
          votes: 42
        });
        if (saved)
          await insertWinnerVoter(dropId, winnerWave.id, 'saved-voter', 0);
        const result = await repo.getDropV2SubmissionVotingSummaries(
          [dropId],
          ctx
        );
        expect(result[dropId]).toMatchObject({
          current_calculated_vote: 42,
          voters_count: 0,
          voters_count_available: saved
        });
        const counts = await repo.getWinningDropsRatersCount([dropId], ctx);
        expect(counts[dropId]).toBe(saved ? 0 : undefined);
      }
    );

    it('returns final voting summary for winner drops', async () => {
      await insertDrop({
        id: 'winner-drop-1',
        waveId: winnerWave.id,
        dropType: DropType.WINNER,
        createdAt: 100
      });
      await insertWinner('winner-drop-1', winnerWave.id, 2, 25);
      await insertWinnerVoter(
        'winner-drop-1',
        winnerWave.id,
        'winner-voter-1',
        10
      );
      await insertWinnerVoter(
        'winner-drop-1',
        winnerWave.id,
        'winner-voter-2',
        15
      );

      const result = await repo.getDropV2SubmissionVotingSummaries(
        ['winner-drop-1'],
        ctx
      );

      expect(result['winner-drop-1']).toMatchObject({
        drop_id: 'winner-drop-1',
        status: DropType.WINNER,
        is_open: false,
        total_votes_given: 25,
        current_calculated_vote: 25,
        predicted_final_vote: 25,
        voters_count: 2,
        voters_count_available: true,
        place: 2
      });
    });
  }
);
