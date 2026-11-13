import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
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
    expect(searchSql).toContain(
      `from ${legacyGetView(WAVES_DECISIONS_TABLE)} wd`
    );
    expect(searchSql).toContain(
      `from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wdwd`
    );
    expect(searchSql).toContain(
      'd.is_additional_action_promised = :is_additional_action_promised'
    );
    expect(searchParams).toMatchObject({
      wave_id: 'wave-1',
      is_additional_action_promised: false
    });

    const [countSql, countParams] = oneOrNull.mock.calls[0];
    expect(countSql).toContain(
      `from ${legacyGetView(WAVES_DECISIONS_TABLE)} wd`
    );
    expect(countSql).toContain(
      `from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wdwd`
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
    expect(sql).toContain(
      `from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wdwd`
    );
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
});
