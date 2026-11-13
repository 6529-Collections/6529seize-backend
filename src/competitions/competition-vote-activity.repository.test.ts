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
    competition_id:
      wave === waveId && time <= transferredAt ? competitionId : null,
    profile_id: 'voter',
    target_id: 'historical-deleted-drop',
    additional_data_1: 'submitter',
    additional_data_2: wave,
    proxy_id: 'proxy',
    type,
    created_at: new Date(time),
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
      repository.list(competitionId, offset, limit, {});

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

    it('merges raw driver-decoded shared dates and exact native milliseconds before bounded pagination', async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${COMPETITION_VOTE_HISTORY_TABLE}`
      );
      await sqlExecutor.execute(`DELETE FROM ${PROFILES_ACTIVITY_LOGS_TABLE}`);
      const logs = ['legacy-a', 'legacy-z', `${competitionId}:33`];
      for (const id of logs) {
        await sqlExecutor.execute(
          `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE}
           (id,competition_id,profile_id,target_id,additional_data_1,additional_data_2,proxy_id,type,created_at,contents)
           VALUES (:id,:competitionId,'voter','drop-entry','submitter',:waveId,'proxy','DROP_VOTE_EDIT',
             '2025-08-09 12:14:22',:contents)`,
          { id, competitionId, waveId, contents: JSON.stringify(contents) }
        );
      }
      const [source] = await sqlExecutor.execute<{ created_at: string }>(
        `SELECT created_at FROM ${PROFILES_ACTIVITY_LOGS_TABLE} WHERE id='legacy-a'`
      );
      // This is the unchanged wave-log reader's actual DATETIME acquisition,
      // not an inferred pairing to a native event or a SQL session timezone.
      const sharedTime = new Date(source.created_at).getTime();
      expect(sharedTime).toBe(new Date('2025-08-09T12:14:22').getTime());
      const nativeRows = [
        native(31, sharedTime + 1000),
        native(32, sharedTime - 1000),
        native(33, sharedTime + 2234)
      ];
      await sqlExecutor.bulkInsert(
        COMPETITION_VOTE_HISTORY_TABLE,
        nativeRows,
        Object.keys(nativeRows[0]),
        {}
      );
      const page = (offset: number, limit: number) =>
        repository.list(competitionId, offset, limit, {});
      const actual = [];
      for (const offset of [0, 2, 4]) actual.push(...(await page(offset, 2)));
      expect(
        actual.map((row) => row.legacy_id ?? Number(row.sequence))
      ).toEqual([33, 31, 'legacy-z', 'legacy-a', 32]);
      expect(actual.map((row) => Number(row.occurred_at))).toEqual([
        sharedTime + 2234,
        sharedTime + 1000,
        sharedTime,
        sharedTime,
        sharedTime - 1000
      ]);
      expect(actual.filter((row) => Number(row.sequence) === 33)).toHaveLength(
        1
      );
      expect(await page(5, 2)).toEqual([]);
    });

    it('retains an unknown shared timestamp as null after every dated activity', async () => {
      const log = {
        ...legacy('unknown-time', transferredAt),
        created_at: null
      };
      await sqlExecutor.bulkInsert(
        PROFILES_ACTIVITY_LOGS_TABLE,
        [{ ...log, contents: JSON.stringify(log.contents) }],
        Object.keys(log),
        {}
      );
      const rows = await repository.list(competitionId, 0, 50, {});
      expect(rows[rows.length - 1]).toMatchObject({
        legacy_id: 'unknown-time',
        legacy_created_at: null,
        occurred_at: null
      });
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

    it('keeps separate competition activity isolated from shared primary logs and hidden entries', async () => {
      const rows = await repository.list('another-competition', 0, 10, {});
      expect(rows).toEqual([]);
      expect(
        (await list(0, 20)).some((row) => row.drop_id === 'drop-hidden')
      ).toBe(false);
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
              await repository.list(competitionId, 0, 20, { connection })
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

    it('uses exact native log identities for deduplication and enrichment without rounding native timestamps', async () => {
      const logs = [
        {
          ...legacy(`${competitionId}:2`, transferredAt + 1000),
          target_id: 'drop-entry'
        },
        {
          ...legacy(`${competitionId}:4`, transferredAt + 2000),
          target_id: 'drop-hidden'
        }
      ];
      for (const row of logs)
        await sqlExecutor.execute(
          `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE}
         (id,profile_id,target_id,additional_data_1,additional_data_2,proxy_id,type,created_at,contents)
         VALUES (:id,:profile_id,:target_id,:additional_data_1,:additional_data_2,:proxy_id,:type,:created_at,:contents)`,
          { ...row, contents: JSON.stringify(contents) }
        );
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_VOTE_HISTORY_TABLE} SET occurred_at=:time WHERE sequence=2`,
        { time: transferredAt + 1234 }
      );
      const rows = await list(0, 30);
      expect(rows.filter((row) => Number(row.sequence) === 2)).toHaveLength(1);
      expect(rows.find((row) => Number(row.sequence) === 2)).toMatchObject({
        legacy_id: null,
        occurred_at: transferredAt + 1234,
        proxy_id: 'proxy'
      });
      expect(
        JSON.parse(
          rows.find((row) => Number(row.sequence) === 2)!.legacy_contents!
        )
      ).toEqual(contents);
      expect(rows.some((row) => row.drop_id === 'drop-hidden')).toBe(false);
    });

    it('uses permanent competition scoping even when shared log timestamps overlap native operation', async () => {
      const expected = await list(0, 30);
      const log = {
        ...legacy('retained-overlap', transferredAt + 1000),
        competition_id: competitionId
      };
      await sqlExecutor.bulkInsert(
        PROFILES_ACTIVITY_LOGS_TABLE,
        [{ ...log, contents: JSON.stringify(log.contents) }],
        Object.keys(log),
        {}
      );
      const actual = await list(0, 30);
      expect(actual).toHaveLength(expected.length + 1);
      expect(
        actual.filter((row) => row.legacy_id === 'retained-overlap')
      ).toHaveLength(1);
      for (const row of expected) expect(actual).toContainEqual(row);
    });

    it('retains native-born reason and proxy attribution without wave-scoped activity', async () => {
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_VOTE_HISTORY_TABLE} SET contents=:contents,proxy_id='native-proxy' WHERE sequence=3`,
        { contents: JSON.stringify(contents) }
      );
      const row = (await list(0, 1))[0];
      expect(row.proxy_id).toBe('native-proxy');
      expect(JSON.parse(row.legacy_contents!)).toEqual(contents);
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
