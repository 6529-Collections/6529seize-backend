import 'reflect-metadata';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROPS_TABLE
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
      })
    ]),
    withRows(DROP_RANK_TABLE, [
      rank({ dropId: 'immediate-drop', waveId: 'immediate-wave', vote: 100 }),
      rank({ dropId: 'ready-drop', waveId: 'duration-wave', vote: 150 }),
      rank({ dropId: 'waiting-drop', waveId: 'duration-wave', vote: 150 }),
      rank({ dropId: 'reset-drop', waveId: 'duration-wave', vote: 150 })
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
      expect(candidateDropIds).not.toContain('waiting-drop');
      expect(candidateDropIds).not.toContain('reset-drop');
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
