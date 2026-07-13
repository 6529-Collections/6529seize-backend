import 'reflect-metadata';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { WaveDecisionsDb } from './wave-decisions.db';

const minute = Time.minutes(1).toMillis();
const tenMinutes = Time.minutes(10).toMillis();

function withRows(table: string, rows: Record<string, unknown>[]): Seed {
  return { table, rows };
}

function participatoryDrop({
  id,
  waveId,
  createdAt
}: {
  id: string;
  waveId: string;
  createdAt: number;
}) {
  return {
    id,
    wave_id: waveId,
    author_id: `author-${id}`,
    created_at: createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.PARTICIPATORY,
    signature: null,
    hide_link_preview: false
  };
}

function rank({
  dropId,
  waveId,
  vote
}: {
  dropId: string;
  waveId: string;
  vote: number;
}) {
  return {
    drop_id: dropId,
    wave_id: waveId,
    vote,
    last_increased: 0
  };
}

function aggregateVote({
  id,
  dropId,
  waveId,
  timestamp,
  vote
}: {
  id: number;
  dropId: string;
  waveId: string;
  timestamp: number;
  vote: number;
}) {
  return {
    id,
    drop_id: dropId,
    wave_id: waveId,
    timestamp,
    vote
  };
}

describe('WaveDecisionsDb decision filters', () => {
  const ctx: RequestContext = { timer: undefined };

  it('filters decision search and count by winner drop additional promise flag', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const oneOrNull = jest.fn().mockResolvedValue({ cnt: 0 });
    const repo = new WaveDecisionsDb(
      () =>
        ({
          execute,
          oneOrNull
        }) as any
    );

    await repo.searchForDecisions(
      {
        wave_id: 'wave-1',
        limit: 10,
        offset: 0,
        sort_direction: 'DESC',
        sort: 'decision_time',
        is_additional_action_promised: false
      },
      ctx
    );
    await repo.countDecisions(
      {
        wave_id: 'wave-1',
        is_additional_action_promised: false
      },
      ctx
    );

    const [searchSql, searchParams] = execute.mock.calls[0];
    expect(searchSql).toContain(`from ${WAVES_DECISIONS_TABLE} wd`);
    expect(searchSql).toContain(
      `from ${WAVES_DECISION_WINNER_DROPS_TABLE} wdwd`
    );
    expect(searchSql).toContain(
      'd.is_additional_action_promised = :is_additional_action_promised'
    );
    expect(searchParams).toMatchObject({
      wave_id: 'wave-1',
      is_additional_action_promised: false
    });

    const [countSql, countParams] = oneOrNull.mock.calls[0];
    expect(countSql).toContain(`from ${WAVES_DECISIONS_TABLE} wd`);
    expect(countSql).toContain(
      `from ${WAVES_DECISION_WINNER_DROPS_TABLE} wdwd`
    );
    expect(countSql).toContain(
      'd.is_additional_action_promised = :is_additional_action_promised'
    );
    expect(countParams).toMatchObject({
      wave_id: 'wave-1',
      is_additional_action_promised: false
    });
  });

  it('filters returned decision winners by additional promise flag', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        wave_id: 'wave-1',
        decision_time: 1000,
        drop_id: 'drop-1',
        ranking: 1,
        final_vote: 42,
        prizes: '[]'
      }
    ]);
    const repo = new WaveDecisionsDb(
      () =>
        ({
          execute
        }) as any
    );

    await repo.findAllDecisionWinners(
      [{ wave_id: 'wave-1', decision_time: 1000 }],
      true,
      ctx
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`from ${WAVES_DECISION_WINNER_DROPS_TABLE} wdwd`);
    expect(sql).toContain(`join ${DROPS_TABLE} d`);
    expect(sql).toContain(
      'd.is_additional_action_promised = :is_additional_action_promised'
    );
    expect(params).toMatchObject({
      waveIds: ['wave-1'],
      decisionTimes: [1000],
      is_additional_action_promised: true
    });
  });

  it('returns Meme card IDs scoped to the configured Main Stage wave', async () => {
    const execute = jest.fn().mockResolvedValue([
      { drop_id: 'drop-1', meme_card_id: 520 },
      { drop_id: 'drop-2', meme_card_id: 521 }
    ]);
    const repo = new WaveDecisionsDb(() => ({ execute }) as any);

    const result = await repo.findMemeCardIdsByDropIds(
      ['drop-1', 'drop-2'],
      'main-stage-wave',
      ctx
    );

    expect(result).toEqual({ 'drop-1': 520, 'drop-2': 521 });
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`from ${WAVES_DECISION_WINNER_DROPS_TABLE}`);
    expect(sql).toContain('wave_id = :mainStageWaveId');
    expect(params).toEqual({
      dropIds: ['drop-1', 'drop-2'],
      mainStageWaveId: 'main-stage-wave'
    });
  });

  it('writes a Meme card ID only for the configured Main Stage wave', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new WaveDecisionsDb(() => ({ execute }) as any);

    await repo.setMemeCardIdForDrop('drop-1', 521, 'main-stage-wave', ctx);

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`update ${WAVES_DECISION_WINNER_DROPS_TABLE}`);
    expect(sql).toContain('wave_id = :mainStageWaveId');
    expect(params).toEqual({
      dropId: 'drop-1',
      memeCardId: 521,
      mainStageWaveId: 'main-stage-wave'
    });
  });
});

describeWithSeed(
  'WaveDecisionsDb.getApproveWinnerCandidates',
  [
    withWaves([
      aWave(
        {
          type: WaveType.APPROVE,
          winning_min_threshold: 100,
          winning_threshold_min_duration_ms: 0
        },
        { id: 'immediate-wave', name: 'Immediate', serial_no: 1 }
      ),
      aWave(
        {
          type: WaveType.APPROVE,
          winning_min_threshold: 100,
          winning_threshold_min_duration_ms: tenMinutes
        },
        { id: 'duration-wave', name: 'Duration', serial_no: 2 }
      ),
      aWave(
        {
          type: WaveType.APPROVE,
          winning_min_threshold: 100,
          winning_threshold_min_duration_ms: tenMinutes,
          time_lock_ms: tenMinutes
        },
        {
          id: 'weighted-duration-wave',
          name: 'Weighted Duration',
          serial_no: 3
        }
      )
    ]),
    withRows(DROPS_TABLE, [
      participatoryDrop({
        id: 'immediate-drop',
        waveId: 'immediate-wave',
        createdAt: 1
      }),
      participatoryDrop({
        id: 'ready-drop',
        waveId: 'duration-wave',
        createdAt: 2
      }),
      participatoryDrop({
        id: 'waiting-drop',
        waveId: 'duration-wave',
        createdAt: 3
      }),
      participatoryDrop({
        id: 'reset-drop',
        waveId: 'duration-wave',
        createdAt: 4
      }),
      participatoryDrop({
        id: 'weighted-ready-drop',
        waveId: 'weighted-duration-wave',
        createdAt: 5
      }),
      participatoryDrop({
        id: 'weighted-waiting-drop',
        waveId: 'weighted-duration-wave',
        createdAt: 6
      }),
      participatoryDrop({
        id: 'weighted-below-drop',
        waveId: 'weighted-duration-wave',
        createdAt: 7
      })
    ]),
    withRows(DROP_RANK_TABLE, [
      rank({ dropId: 'immediate-drop', waveId: 'immediate-wave', vote: 100 }),
      rank({ dropId: 'ready-drop', waveId: 'duration-wave', vote: 150 }),
      rank({ dropId: 'waiting-drop', waveId: 'duration-wave', vote: 150 }),
      rank({ dropId: 'reset-drop', waveId: 'duration-wave', vote: 150 })
    ]),
    withRows(WAVE_LEADERBOARD_ENTRIES_TABLE, [
      {
        drop_id: 'weighted-ready-drop',
        wave_id: 'weighted-duration-wave',
        timestamp: 15 * minute,
        vote: 150,
        vote_on_decision_time: 150,
        over_threshold_since_ms: 5 * minute
      },
      {
        drop_id: 'weighted-waiting-drop',
        wave_id: 'weighted-duration-wave',
        timestamp: 15 * minute,
        vote: 150,
        vote_on_decision_time: 150,
        over_threshold_since_ms: 10 * minute
      },
      {
        drop_id: 'weighted-below-drop',
        wave_id: 'weighted-duration-wave',
        timestamp: 15 * minute,
        vote: 99,
        vote_on_decision_time: 99,
        over_threshold_since_ms: null
      }
    ]),
    withRows(DROP_REAL_VOTE_IN_TIME_TABLE, [
      aggregateVote({
        id: 1,
        dropId: 'ready-drop',
        waveId: 'duration-wave',
        timestamp: 0,
        vote: 0
      }),
      aggregateVote({
        id: 2,
        dropId: 'ready-drop',
        waveId: 'duration-wave',
        timestamp: 5 * minute,
        vote: 101
      }),
      aggregateVote({
        id: 3,
        dropId: 'ready-drop',
        waveId: 'duration-wave',
        timestamp: 10 * minute,
        vote: 150
      }),
      aggregateVote({
        id: 4,
        dropId: 'waiting-drop',
        waveId: 'duration-wave',
        timestamp: 0,
        vote: 0
      }),
      aggregateVote({
        id: 5,
        dropId: 'waiting-drop',
        waveId: 'duration-wave',
        timestamp: 10 * minute,
        vote: 150
      }),
      aggregateVote({
        id: 6,
        dropId: 'reset-drop',
        waveId: 'duration-wave',
        timestamp: 0,
        vote: 0
      }),
      aggregateVote({
        id: 7,
        dropId: 'reset-drop',
        waveId: 'duration-wave',
        timestamp: minute,
        vote: 101
      }),
      aggregateVote({
        id: 8,
        dropId: 'reset-drop',
        waveId: 'duration-wave',
        timestamp: 8 * minute,
        vote: 99
      }),
      aggregateVote({
        id: 9,
        dropId: 'reset-drop',
        waveId: 'duration-wave',
        timestamp: 10 * minute,
        vote: 150
      })
    ])
  ],
  () => {
    const repo = new WaveDecisionsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('keeps duration 0 immediate and uses first passing row for duration waves', async () => {
      const candidates = await repo.getApproveWinnerCandidates(
        15 * minute,
        ctx
      );

      const candidateDropIds = candidates.map((candidate) => candidate.drop_id);
      expect(candidateDropIds).toContain('immediate-drop');
      expect(candidateDropIds).toContain('ready-drop');
      expect(candidateDropIds).toContain('weighted-ready-drop');
      expect(candidateDropIds).not.toContain('waiting-drop');
      expect(candidateDropIds).not.toContain('reset-drop');
      expect(candidateDropIds).not.toContain('weighted-waiting-drop');
      expect(candidateDropIds).not.toContain('weighted-below-drop');
    });

    it('restarts the duration after the latest below-threshold aggregate vote', async () => {
      const candidates = await repo.getApproveWinnerCandidates(
        20 * minute,
        ctx
      );

      expect(candidates.map((candidate) => candidate.drop_id)).toContain(
        'reset-drop'
      );
    });
  }
);
