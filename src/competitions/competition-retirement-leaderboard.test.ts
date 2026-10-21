import * as tables from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from './competition-id';
import { transferRetainedCompetitionLeaderboardPublication } from './competition-retirement-leaderboard';

const wave = aWave(
  { type: WaveType.RANK, time_lock_ms: 1000 },
  {
    id: 'retained-leaderboard-owner',
    name: 'Retained snapshot owner',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const orphan = 'retained-orphan-snapshot';
const entryId = legacyCompetitionEntryId(id, orphan);

describeWithSeed(
  'retained leaderboard transfer safety',
  [withWaves([wave])],
  () => {
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.execute(
        `INSERT INTO ${tables.WAVE_LEADERBOARD_ENTRIES_TABLE}
      (drop_id,wave_id,timestamp,vote,vote_on_decision_time,over_threshold_since_ms)
      VALUES (:dropId,:waveId,100,40,90,NULL)`,
        { dropId: orphan, waveId: wave.id }
      );
    });

    it.each([
      'rating',
      'decision_rating',
      'ordering_time',
      'published_at',
      'over_threshold_since',
      'rank'
    ])(
      'fails exact duplicate parity without overwriting a changed %s',
      async (column) => {
        await transferRetainedCompetitionLeaderboardPublication(
          sqlExecutor,
          id
        );
        await sqlExecutor.execute(
          `UPDATE ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}
        SET \`${column}\`=1 WHERE competition_id=:id AND entry_id=:entryId`,
          { id, entryId }
        );
        const retained = await sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
        );
        await expect(
          transferRetainedCompetitionLeaderboardPublication(sqlExecutor, id)
        ).rejects.toThrow('Retained orphan leaderboard parity failed');
        expect(
          await sqlExecutor.execute(
            `SELECT * FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
          )
        ).toEqual(retained);
        expect(
          await sqlExecutor.execute(
            `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE}`
          )
        ).toEqual([]);
      }
    );

    it('does not replace existing active, winner or withdrawn membership with orphan snapshots', async () => {
      const statuses = ['ACTIVE', 'WINNER', 'WITHDRAWN'];
      const entries = statuses.map((status) => ({
        id: legacyCompetitionEntryId(id, status),
        competition_id: id,
        wave_id: wave.id,
        drop_id: status,
        submitter_id: 'author',
        status,
        config_version: 1,
        submitted_at: 1
      }));
      await sqlExecutor.bulkInsert(
        tables.COMPETITION_ENTRIES_TABLE,
        entries,
        Object.keys(entries[0])
      );
      const source = statuses.map((dropId) => ({
        drop_id: dropId,
        wave_id: wave.id,
        timestamp: 100,
        vote: 999,
        vote_on_decision_time: 888
      }));
      await sqlExecutor.bulkInsert(
        tables.WAVE_LEADERBOARD_ENTRIES_TABLE,
        source,
        Object.keys(source[0])
      );
      const canonical = {
        competition_id: id,
        entry_id: entries[0].id,
        drop_id: 'ACTIVE',
        rating: 7,
        real_time_rating: 8,
        rank: 1,
        submitted_at: 1,
        updated_at: 100,
        ordering_time: 50,
        decision_rating: 9,
        published_at: 77,
        over_threshold_since: 6
      };
      await sqlExecutor.bulkInsert(
        tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE,
        [canonical],
        Object.keys(canonical)
      );
      await transferRetainedCompetitionLeaderboardPublication(
        sqlExecutor,
        id,
        {},
        { batchSize: 1 }
      );
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT * FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}
      WHERE competition_id=:id AND entry_id=:entryId`,
          { id, entryId: entries[0].id }
        )
      ).toEqual(canonical);
      expect(
        await sqlExecutor.execute(
          `SELECT drop_id FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}
      WHERE competition_id=:id ORDER BY drop_id`,
          { id }
        )
      ).toEqual([{ drop_id: 'ACTIVE' }, { drop_id: orphan }]);
      expect(
        await sqlExecutor.execute(
          `SELECT status FROM ${tables.COMPETITION_ENTRIES_TABLE} ORDER BY status`
        )
      ).toHaveLength(3);
    });

    it('rejects an unresolved ID that already belongs to a different canonical entry', async () => {
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITION_ENTRIES_TABLE}
      (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
      VALUES (:entryId,:id,:waveId,'different-canonical-drop','author','ACTIVE',1,1)`,
        { entryId, id, waveId: wave.id }
      );
      await expect(
        transferRetainedCompetitionLeaderboardPublication(sqlExecutor, id)
      ).rejects.toThrow('Retained leaderboard identity has native membership');
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
        )
      ).toEqual([]);
    });

    it('does not enroll deleted-wave owners or copy an original snapshot into a sibling', async () => {
      const sibling = legacyCompetitionId('retained-sibling');
      const ghost = legacyCompetitionId('deleted-snapshot-wave');
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITIONS_TABLE}
      SELECT ${Object.keys(
        (await sqlExecutor.oneOrNull<Record<string, unknown>>(
          `SELECT * FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
          { id }
        )) ?? {}
      )
        .map((column) =>
          column === 'id'
            ? ':sibling'
            : column === 'legacy_wave_id'
              ? 'NULL'
              : '`' + column + '`'
        )
        .join(',')}
      FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
        { sibling, id }
      );
      const columns = Object.keys(
        (await sqlExecutor.oneOrNull<Record<string, unknown>>(
          `SELECT * FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
          { id }
        ))!
      );
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITIONS_TABLE} (${columns.map((column) => '`' + column + '`').join(',')})
      SELECT ${columns.map((column) => (column === 'id' ? ':ghost' : ['wave_id', 'legacy_wave_id'].includes(column) ? "'deleted-snapshot-wave'" : '`' + column + '`')).join(',')}
      FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
        { ghost, id }
      );
      await sqlExecutor.execute(`INSERT INTO ${tables.WAVE_LEADERBOARD_ENTRIES_TABLE}
      (drop_id,wave_id,timestamp,vote,vote_on_decision_time) VALUES ('ghost-orphan','deleted-snapshot-wave',1,999,999)`);
      await transferRetainedCompetitionLeaderboardPublication(sqlExecutor);
      expect(
        await sqlExecutor.execute(
          `SELECT competition_id,drop_id FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
        )
      ).toEqual([{ competition_id: id, drop_id: orphan }]);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toEqual([]);
    });
  }
);
