import 'reflect-metadata';
import {
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
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  DropVotingDb,
  buildMergedDropRealVoteHistoryStates
} from './drop-voting.db';

describe('buildMergedDropRealVoteHistoryStates', () => {
  it('sums overlapping voters across both merged nominations', () => {
    expect(
      buildMergedDropRealVoteHistoryStates({
        targetDropId: 'target-drop',
        waveId: 'wave-1',
        voteChanges: [
          {
            id: 1,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 5,
            timestamp: 100
          },
          {
            id: 2,
            original_drop_id: 'source-drop',
            voter_id: 'voter-1',
            vote: 3,
            timestamp: 200
          },
          {
            id: 3,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 6,
            timestamp: 300
          }
        ]
      })
    ).toEqual([
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 100,
        vote: 5
      },
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 200,
        vote: 8
      },
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 300,
        vote: 9
      }
    ]);
  });

  it('collapses same-timestamp changes to the final total at that timestamp', () => {
    expect(
      buildMergedDropRealVoteHistoryStates({
        targetDropId: 'target-drop',
        waveId: 'wave-1',
        voteChanges: [
          {
            id: 1,
            original_drop_id: 'target-drop',
            voter_id: 'voter-1',
            vote: 5,
            timestamp: 100
          },
          {
            id: 2,
            original_drop_id: 'source-drop',
            voter_id: 'voter-1',
            vote: 3,
            timestamp: 100
          }
        ]
      })
    ).toEqual([
      {
        drop_id: 'target-drop',
        wave_id: 'wave-1',
        timestamp: 100,
        vote: 8
      }
    ]);
  });
});

describe('DropVotingDb leaderboard threshold clears', () => {
  it('invalidates the snapshot timestamp when clearing one drop threshold state', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const db = new DropVotingDb(
      () =>
        ({
          execute
        }) as any
    );

    await db.clearWaveLeaderboardEntryOverThresholdSince('drop-id', {});

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('timestamp = 0'),
      { dropId: 'drop-id' },
      { wrappedConnection: undefined }
    );
  });

  it('invalidates snapshot timestamps when clearing wave threshold state', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    const db = new DropVotingDb(
      () =>
        ({
          execute
        }) as any
    );

    await db.clearWaveLeaderboardEntriesOverThresholdSinceByWaveId(
      'wave-id',
      {}
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('timestamp = 0'),
      { waveId: 'wave-id' },
      { wrappedConnection: undefined }
    );
  });

  it('locks and reads the live leaderboard threshold state', async () => {
    const connection = { id: 'connection' };
    const oneOrNull = jest.fn().mockResolvedValue({
      leaderboard_timestamp: 1_234,
      over_threshold_since_ms: 567
    });
    const db = new DropVotingDb(
      () =>
        ({
          oneOrNull
        }) as any
    );

    const result = await db.getWaveLeaderboardEntryThresholdStateForUpdate(
      {
        dropId: 'drop-id',
        waveId: 'wave-id'
      },
      { connection: connection as any }
    );

    expect(result).toEqual({
      leaderboard_timestamp: 1_234,
      over_threshold_since_ms: 567
    });
    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('for update'),
      {
        dropId: 'drop-id',
        waveId: 'wave-id'
      },
      { wrappedConnection: connection }
    );
  });
});

describe('DropVotingDb.mergeDropVoteState', () => {
  function createDb() {
    const execute = jest.fn().mockResolvedValue([]);
    const oneOrNull = jest.fn().mockResolvedValue(null);
    const transactionalConnection = { connection: { id: 'tx' } };
    const executeNativeQueriesInTransaction = jest.fn(async (fn) =>
      fn(transactionalConnection)
    );
    const db = {
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction
    };
    return {
      service: new DropVotingDb(() => db as any),
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction,
      transactionalConnection
    };
  }

  it('wraps merge in a transaction when no connection is provided', async () => {
    const {
      service,
      execute,
      oneOrNull,
      executeNativeQueriesInTransaction,
      transactionalConnection
    } = createDb();

    await service.mergeDropVoteState(
      {
        sourceDropId: 'source-drop',
        targetDropId: 'target-drop',
        waveId: 'wave-1'
      },
      {}
    );

    expect(executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(oneOrNull).toHaveBeenCalled();
    for (const call of [...execute.mock.calls, ...oneOrNull.mock.calls]) {
      expect(call[2]).toEqual({ wrappedConnection: transactionalConnection });
    }
  });

  it('reuses the caller connection when one is already provided', async () => {
    const { service, execute, oneOrNull, executeNativeQueriesInTransaction } =
      createDb();
    const existingConnection = { connection: { id: 'existing' } };

    await service.mergeDropVoteState(
      {
        sourceDropId: 'source-drop',
        targetDropId: 'target-drop',
        waveId: 'wave-1'
      },
      { connection: existingConnection }
    );

    expect(executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(oneOrNull).toHaveBeenCalled();
    for (const call of [...execute.mock.calls, ...oneOrNull.mock.calls]) {
      expect(call[2]).toEqual({ wrappedConnection: existingConnection });
    }
  });
});

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
  await sqlExecutor.execute(
    `
      insert into ${DROP_RANK_TABLE} (
        drop_id,
        wave_id,
        vote,
        last_increased
      )
      values (:dropId, :waveId, :vote, :lastIncreased)
    `,
    { dropId, waveId, vote, lastIncreased }
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
  await sqlExecutor.execute(
    `
      insert into ${DROP_VOTER_STATE_TABLE} (
        voter_id,
        drop_id,
        wave_id,
        votes
      )
      values (:voterId, :dropId, :waveId, :votes)
    `,
    { voterId, dropId, waveId, votes }
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
  await sqlExecutor.execute(
    `
      insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (
        drop_id,
        wave_id,
        timestamp,
        vote
      )
      values (:dropId, :waveId, :timestamp, :vote)
    `,
    { dropId, waveId, timestamp, vote }
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
  await sqlExecutor.execute(
    `
      insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (
        drop_id,
        wave_id,
        vote,
        timestamp,
        vote_on_decision_time
      )
      values (:dropId, :waveId, :vote, :timestamp, :voteOnDecisionTime)
    `,
    { dropId, waveId, vote, timestamp, voteOnDecisionTime }
  );
}

describeWithSeed(
  'DropVotingDb.getDropV2SubmissionVotingSummaries',
  withWaves([realtimeWave, timeLockedWave, winnerWave]),
  () => {
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
      await sqlExecutor.execute(
        `
          insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (
            decision_time,
            drop_id,
            wave_id,
            ranking,
            final_vote,
            prizes
          )
          values (
            1000,
            'winner-threshold-drop',
            :waveId,
            1,
            150,
            '[]'
          )
        `,
        { waveId: realtimeWave.id }
      );

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

    it('returns final voting summary for winner drops', async () => {
      await insertDrop({
        id: 'winner-drop-1',
        waveId: winnerWave.id,
        dropType: DropType.WINNER,
        createdAt: 100
      });
      await sqlExecutor.execute(
        `
          insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (
            decision_time,
            drop_id,
            wave_id,
            ranking,
            final_vote,
            prizes
          )
          values (
            1000,
            'winner-drop-1',
            :waveId,
            2,
            25,
            '[]'
          )
        `,
        { waveId: winnerWave.id }
      );
      await sqlExecutor.execute(
        `
          insert into ${WINNER_DROP_VOTER_VOTES_TABLE} (
            voter_id,
            drop_id,
            wave_id,
            votes
          )
          values
            ('winner-voter-1', 'winner-drop-1', :waveId, 10),
            ('winner-voter-2', 'winner-drop-1', :waveId, 15)
        `,
        { waveId: winnerWave.id }
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
        place: 2
      });
    });
  }
);
