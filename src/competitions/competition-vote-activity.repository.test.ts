import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CompetitionVoteActivityRepository } from './competition-vote-activity.repository';

const transferredAt = Date.UTC(2026, 9, 9, 7);
const competitionId = 'competition';
const waveId = 'wave';
const contents = { reason: 'CREDIT_OVERSPENT', oldVote: '85192', newVote: 555 };

function entry(id: string, competition = competitionId, withdrawn = false) {
  return {
    id,
    competition_id: competition,
    wave_id: waveId,
    drop_id: `drop-${id}`,
    submitter_id: 'submitter',
    status: withdrawn
      ? CompetitionEntryStatus.WITHDRAWN
      : CompetitionEntryStatus.ACTIVE,
    config_version: 1,
    submitted_at: transferredAt
  };
}

function native(sequence: number, time: number, entryId = 'entry') {
  return {
    sequence,
    competition_id: competitionId,
    entry_id: entryId,
    voter_profile_id: 'voter',
    previous_value: 0,
    value: 100,
    aggregate_value: 100,
    credit_delta: 100,
    occurred_at: time
  };
}

function legacy(
  id: string,
  time: number,
  wave = waveId,
  type = ProfileActivityLogType.DROP_VOTE_EDIT
) {
  return {
    id,
    profile_id: 'voter',
    target_id: 'historical-deleted-drop',
    additional_data_1: 'submitter',
    additional_data_2: wave,
    proxy_id: 'proxy',
    type,
    created_at: new Date(time).toISOString().slice(0, 23).replace('T', ' '),
    contents
  };
}

describeWithSeed(
  'transferred competition vote activity',
  [
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [entry('entry'), entry('hidden', competitionId, true)]
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        native(1, transferredAt - 2000),
        native(2, transferredAt + 1000),
        native(3, transferredAt + 1000),
        native(4, transferredAt + 2000, 'hidden'),
        native(5, transferredAt - 1000)
      ]
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        legacy('legacy-a', transferredAt - 1000),
        legacy('legacy-z', transferredAt - 1000),
        legacy('legacy-old', transferredAt - 3000),
        legacy('at-transfer', transferredAt),
        legacy('wrong-wave', transferredAt - 1000, 'another-wave'),
        legacy('after-transfer', transferredAt + 1000),
        legacy(
          'reaction',
          transferredAt - 1000,
          waveId,
          ProfileActivityLogType.DROP_REACTED
        )
      ]
    }
  ],
  () => {
    const repository = new CompetitionVoteActivityRepository(() => sqlExecutor);
    const list = (offset: number, limit: number) =>
      repository.listTransferred(
        competitionId,
        waveId,
        transferredAt,
        offset,
        limit,
        {}
      );

    it('combines retained logs and native changes before applying stable pagination', async () => {
      const pages = [];
      for (const offset of [0, 2, 4, 6]) pages.push(await list(offset, 2));
      expect(
        pages.flat().map((row) => row.legacy_id ?? Number(row.sequence))
      ).toEqual([
        3,
        2,
        'at-transfer',
        5,
        'legacy-z',
        'legacy-a',
        1,
        'legacy-old'
      ]);
      expect(await list(8, 2)).toEqual([]);
    });

    it('preserves original adjustment contents, proxy, author and deleted-drop references', async () => {
      const rows = await list(4, 1);
      expect(rows[0]).toMatchObject({
        legacy_id: 'legacy-z',
        drop_id: 'historical-deleted-drop',
        voter_profile_id: 'voter',
        submitter_id: 'submitter',
        proxy_id: 'proxy'
      });
      expect(Number(rows[0].occurred_at)).toBe(transferredAt - 1000);
      expect(JSON.parse(rows[0].legacy_contents!)).toEqual(contents);
    });

    it('keeps ordinary native activity isolated from legacy logs and hidden entries', async () => {
      const rows = await repository.list(competitionId, 0, 10, {});
      expect(rows.map((row) => Number(row.sequence))).toEqual([3, 2, 5, 1]);
      expect(await repository.list('another-competition', 0, 10, {})).toEqual(
        []
      );
    });

    it('paginates deep mixed histories when both sources exceed the page candidate count', async () => {
      const sequences = Array.from({ length: 40 }, (_, index) => index + 10);
      const nativeRows = sequences.map((sequence) =>
        native(sequence, transferredAt - sequence * 1000)
      );
      const legacyRows = sequences.map((sequence) => ({
        ...legacy(`deep-${sequence}`, transferredAt - sequence * 1000),
        contents: JSON.stringify(contents)
      }));
      await sqlExecutor.bulkInsert(
        COMPETITION_VOTE_HISTORY_TABLE,
        nativeRows,
        Object.keys(nativeRows[0]),
        {}
      );
      await sqlExecutor.bulkInsert(
        PROFILES_ACTIVITY_LOGS_TABLE,
        legacyRows,
        Object.keys(legacyRows[0]),
        {}
      );
      const expected = [
        3,
        2,
        'at-transfer',
        5,
        'legacy-z',
        'legacy-a',
        1,
        'legacy-old',
        ...sequences.flatMap((sequence) => [sequence, `deep-${sequence}`])
      ];
      const actual: (number | string)[] = [];
      for (let offset = 0; offset < expected.length; offset += 7) {
        actual.push(
          ...(await list(offset, 7)).map(
            (row) => row.legacy_id ?? Number(row.sequence)
          )
        );
      }
      expect(actual).toEqual(expected);
      expect(new Set(actual).size).toBe(expected.length);
      expect(await list(expected.length, 7)).toEqual([]);
    });

    it('keeps the exact UTC transfer boundary under a different MySQL session timezone', async () => {
      const expected = await list(0, 20);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          const [{ zone }] = await sqlExecutor.execute<{ zone: string }>(
            'SELECT @@session.time_zone AS zone',
            {},
            options
          );
          try {
            await sqlExecutor.execute("SET time_zone = '+05:00'", {}, options);
            expect(
              await repository.listTransferred(
                competitionId,
                waveId,
                transferredAt,
                0,
                20,
                { connection }
              )
            ).toEqual(expected);
          } finally {
            await sqlExecutor.execute(
              'SET time_zone = :zone',
              { zone },
              options
            );
          }
        }
      );
    });

    it('rejects malformed or null legacy JSON at the storage boundary', async () => {
      await expect(
        sqlExecutor.execute(
          `UPDATE ${PROFILES_ACTIVITY_LOGS_TABLE} SET contents = :contents WHERE id = 'legacy-a'`,
          { contents: 'not-json' }
        )
      ).rejects.toThrow('Invalid JSON text');
      await expect(
        sqlExecutor.execute(
          `UPDATE ${PROFILES_ACTIVITY_LOGS_TABLE} SET contents = NULL WHERE id = 'legacy-a'`
        )
      ).rejects.toThrow('cannot be null');
    });
  }
);
