import 'reflect-metadata';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { BackendWavesExportSource } from './waves-export.backend-source';

// Dates read and written in UTC, as runExport sets it.
process.env.TZ = 'UTC';

/**
 * A primary decision's native entries keep their votes in
 * competition_vote_history. The legacy GET facade shows such an entry's drop
 * as PARTICIPATORY (active) or WINNER, so the export reads the drop as
 * stored, as the API's own vote log does, or every native entry's log
 * would come out empty. A legacy entry's log stays the activity log's.
 * Made-up rows only.
 */
const NATIVE_WAVE = aWave(
  { type: WaveType.RANK },
  { id: 'b0000000-0000-4000-8000-000000000001', name: 'Native', serial_no: 31 }
);
const LEGACY_WAVE = aWave(
  { type: WaveType.RANK },
  { id: 'b0000000-0000-4000-8000-000000000002', name: 'Legacy', serial_no: 32 }
);
const COMPETITION_ID = legacyCompetitionId(NATIVE_WAVE.id);
const ACTIVE_DROP = 'b1000000-0000-4000-8000-000000000001';
const WINNER_DROP = 'b1000000-0000-4000-8000-000000000002';
const LEGACY_DROP = 'b1000000-0000-4000-8000-000000000003';
const ACTIVE_ENTRY = legacyCompetitionEntryId(COMPETITION_ID, ACTIVE_DROP);
const WINNER_ENTRY = legacyCompetitionEntryId(COMPETITION_ID, WINNER_DROP);
const ARTIST = 'made-up-artist';
const VOTER_A = 'made-up-voter-a';
const VOTER_B = 'made-up-voter-b';

function drop(id: string, waveId: string, dropType: string, serial: number) {
  return {
    id,
    serial_no: serial,
    wave_id: waveId,
    author_id: ARTIST,
    created_at: 1_000 + serial,
    parts_count: 0,
    drop_type: dropType,
    hide_link_preview: false
  };
}

function entry(id: string, dropId: string, status: string) {
  return {
    id,
    competition_id: COMPETITION_ID,
    wave_id: NATIVE_WAVE.id,
    drop_id: dropId,
    submitter_id: ARTIST,
    status,
    config_version: 1,
    submitted_at: 1_000
  };
}

function history(
  sequence: number,
  entryId: string,
  dropId: string,
  voter: string,
  previous: number,
  value: number,
  aggregate: number,
  at: number
) {
  return {
    sequence,
    competition_id: COMPETITION_ID,
    entry_id: entryId,
    drop_id: dropId,
    submitter_id: ARTIST,
    voter_profile_id: voter,
    value,
    previous_value: previous,
    aggregate_value: aggregate,
    credit_delta: value - previous,
    occurred_at: at
  };
}

function vote(id: string, entryId: string, voter: string, value: number) {
  return {
    id,
    competition_id: COMPETITION_ID,
    entry_id: entryId,
    voter_profile_id: voter,
    value,
    credit_spent: Math.abs(value),
    created_at: 2_000,
    updated_at: 4_000
  };
}

describeWithSeed(
  "the waves export's vote logs",
  [
    withWaves([NATIVE_WAVE, LEGACY_WAVE]),
    {
      table: DROPS_TABLE,
      rows: [
        // Native entries: stored as COMPETITION drops.
        drop(ACTIVE_DROP, NATIVE_WAVE.id, 'COMPETITION', 1),
        drop(WINNER_DROP, NATIVE_WAVE.id, 'COMPETITION', 2),
        // A legacy entry: a PARTICIPATORY drop, its votes in the activity log.
        drop(LEGACY_DROP, LEGACY_WAVE.id, 'PARTICIPATORY', 3)
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        entry(ACTIVE_ENTRY, ACTIVE_DROP, 'ACTIVE'),
        entry(WINNER_ENTRY, WINNER_DROP, 'WINNER')
      ]
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: [
        vote('made-up-vote-1', ACTIVE_ENTRY, VOTER_A, 8),
        vote('made-up-vote-2', ACTIVE_ENTRY, VOTER_B, 3)
      ]
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        // The active entry's votes at three times: A votes 5, B votes 3,
        // A raises to 8.
        history(1, ACTIVE_ENTRY, ACTIVE_DROP, VOTER_A, 0, 5, 5, 2_000),
        history(2, ACTIVE_ENTRY, ACTIVE_DROP, VOTER_B, 0, 3, 8, 3_000),
        history(3, ACTIVE_ENTRY, ACTIVE_DROP, VOTER_A, 5, 8, 11, 4_000),
        history(4, WINNER_ENTRY, WINNER_DROP, VOTER_B, 0, 2, 2, 2_500)
      ]
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'made-up-log-1',
          profile_id: VOTER_A,
          target_id: LEGACY_DROP,
          proxy_id: null,
          contents: JSON.stringify({ oldVote: 0, newVote: 4 }),
          type: ProfileActivityLogType.DROP_VOTE_EDIT,
          additional_data_1: null,
          additional_data_2: LEGACY_WAVE.id,
          created_at: new Date(5_000)
        }
      ]
    }
  ],
  () => {
    const source = new BackendWavesExportSource();

    it("exports a native entry's stored votes, active or a winner, and a legacy entry's activity log", async () => {
      await seedNativeOriginalPrimaryFixture(NATIVE_WAVE);
      const active = await source.entryVoteLog({
        competition_id: COMPETITION_ID,
        wave_id: NATIVE_WAVE.id,
        entry_id: ACTIVE_ENTRY,
        drop_id: ACTIVE_DROP
      });
      // Newest first, as the API's vote log gives it.
      expect(active).toEqual([
        {
          id: '3',
          voter_profile_id: VOTER_A,
          old_vote: 5,
          new_vote: 8,
          created_at: 4_000
        },
        {
          id: '2',
          voter_profile_id: VOTER_B,
          old_vote: 0,
          new_vote: 3,
          created_at: 3_000
        },
        {
          id: '1',
          voter_profile_id: VOTER_A,
          old_vote: 0,
          new_vote: 5,
          created_at: 2_000
        }
      ]);
      // The log adds up to the entry's vote total.
      const [{ total }] = await sqlExecutor.execute<{ total: number }>(
        `select cast(sum(value) as signed) as total from ${COMPETITION_VOTES_TABLE}
          where competition_id = :competitionId and entry_id = :entryId`,
        { competitionId: COMPETITION_ID, entryId: ACTIVE_ENTRY }
      );
      expect(
        active.reduce((sum, row) => sum + row.new_vote - row.old_vote, 0)
      ).toBe(Number(total));

      // A winner: the facade shows it as WINNER; its votes are still native.
      expect(
        await source.entryVoteLog({
          competition_id: COMPETITION_ID,
          wave_id: NATIVE_WAVE.id,
          entry_id: WINNER_ENTRY,
          drop_id: WINNER_DROP
        })
      ).toEqual([
        {
          id: '4',
          voter_profile_id: VOTER_B,
          old_vote: 0,
          new_vote: 2,
          created_at: 2_500
        }
      ]);

      // A legacy entry: the activity log, as before.
      expect(
        await source.entryVoteLog({
          competition_id: legacyCompetitionId(LEGACY_WAVE.id),
          wave_id: LEGACY_WAVE.id,
          entry_id: 'made-up-legacy-entry',
          drop_id: LEGACY_DROP
        })
      ).toEqual([
        {
          id: 'made-up-log-1',
          voter_profile_id: VOTER_A,
          old_vote: 0,
          new_vote: 4,
          created_at: 5_000
        }
      ]);
    });
  }
);
