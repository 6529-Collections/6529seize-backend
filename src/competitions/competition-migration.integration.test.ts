import { CompetitionMigrationBackfill } from './competition-migration-backfill';
import { CompetitionMigrationRepository } from './competition-migration.repository';
import { performance } from 'node:perf_hooks';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { CompetitionMigrationContentRepository } from '@/competitions/competition-migration-content.repository';
import { CompetitionEntryRepository } from '@/competitions/competition-entry.repository';
import { compareMigrationContent } from '@/competitions/competition-migration-content-parity';
import { readLegacyDropFacadeForComparison } from '@/competitions/legacy-competition-facade-parity';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
import { DropEntity } from '@/entities/IDrop';
import { withLegacyCompetitionProfileMerge } from './legacy-competition-profile-merge';
import { appFeatures } from '@/app-features';
import { competitionService } from '@/competitions/competition.service';
import { DropVotingDb } from '@/api/drops/drop-voting.db';
import { migrationCommandConfiguration } from './legacy-competition-configuration';
import { NativeCompetitionReader } from './native-competition.reader';
import { listCompetitionVoteActivity } from '@/api/competitions/competition-vote-activity.service';
import {
  LEGACY_GET_SOURCE_TABLES,
  withLegacyCompetitionGetFacade,
  withLegacyShadowGetFacade,
  legacyGetView
} from './legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITIONS_TABLE,
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  IDENTITIES_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { WaveType } from '@/entities/IWave';
import { CompetitionRepository } from './competition.repository';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId
} from './competition-id';
import { CompetitionMigrationService } from './competition-migration.service';
import { LegacyCompetitionBaselineRepository } from './legacy-competition-baseline.repository';
import {
  installMigrationCapture,
  migrationCaptureHealthy,
  migrationCaptureStatement,
  migrationTriggerName
} from './competition-migration-capture';
import {
  executeMigrationCommand,
  parseMigrationOptions
} from './competition-migration.cli';

const wave = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 1,
    participation_period_end: 1000,
    voting_period_start: 1,
    voting_period_end: 1000,
    next_decision_time: null,
    decisions_strategy: {
      first_decision_time: 900,
      subsequent_decisions: [],
      is_rolling: false
    }
  },
  {
    id: 'migration-fixture-wave',
    name: 'Completed disposable fixture',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const operator = {
  actor: 'fixture-operator',
  reason: 'disposable fixture rehearsal'
};
const drop = {
  id: 'migration-fixture-drop',
  wave_id: wave.id,
  author_id: 'fixture-author',
  created_at: 10,
  updated_at: null,
  title: null,
  parts_count: 1,
  drop_type: 'PARTICIPATORY',
  signature: null,
  hide_link_preview: false
};

async function seedRichEntryContent(dropId: string) {
  for (const sql of [
    `update ${DROPS_TABLE} set title=:dropId,hide_link_preview=1,reply_to_drop_id='quoted',reply_to_part_id=2,parts_count=2 where id=:dropId`,
    `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content,quoted_drop_id,quoted_drop_part_id) values (:dropId,2,:dropId,'quoted',1)`,
    `insert into ${DROP_MEDIA_TABLE} (drop_id,drop_part_id,url,mime_type,media_upload_id) values (:dropId,2,:dropId,'image/png','upload')`,
    `insert into ${DROP_ATTACHMENTS_TABLE} (drop_id,drop_part_id,attachment_id) values (:dropId,2,:dropId)`,
    `insert into ${DROP_METADATA_TABLE} (drop_id,data_key,data_value) values (:dropId,'z',:dropId),(:dropId,'a','second')`,
    `insert into ${DROP_REFERENCED_NFTS_TABLE} (drop_id,contract,token,name) values (:dropId,'contract','1',:dropId)`,
    `insert into ${DROPS_MENTIONS_TABLE} (drop_id,mentioned_profile_id,handle_in_content) values (:dropId,'fixture-author',:dropId)`,
    `insert into ${DROP_MENTIONED_WAVES_TABLE} (drop_id,wave_id,wave_name_in_content) values (:dropId,:waveId,:dropId)`,
    `insert into ${DROP_MENTIONED_GROUPS_TABLE} (drop_id,mentioned_group) values (:dropId,'all')`
  ])
    await sqlExecutor.execute(sql, { dropId, waveId: wave.id });
}

async function seedSnapshotEntry(secondDropId: string, now: number, vote = 6) {
  for (const sql of [
    `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview) values (:secondDropId,:waveId,'fixture-author',20,1,'PARTICIPATORY',0)`,
    `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content) values (:secondDropId,1,'Second snapshot entry')`,
    `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:secondDropId,:waveId,:vote,20)`,
    `insert into ${DROP_VOTER_STATE_TABLE} (drop_id,wave_id,voter_id,votes) values (:secondDropId,:waveId,'fixture-voter',:vote)`,
    `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (voter_id,drop_id,wave_id,credit_spent,created_at) values ('fixture-voter',:secondDropId,:waveId,:vote,20)`,
    `insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (wave_id,drop_id,timestamp,vote) values (:waveId,:secondDropId,20,:vote)`,
    `insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (wave_id,drop_id,voter_id,timestamp,vote) values (:waveId,:secondDropId,'fixture-voter',20,:vote)`,
    `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time) values (:secondDropId,:waveId,:now,:vote,:vote)`
  ]) {
    await sqlExecutor.execute(sql, {
      secondDropId,
      waveId: wave.id,
      now,
      vote
    });
  }
}

async function moveLiveEntryVote(
  dropId: string,
  vote: number,
  creditDelta: number
) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    for (const sql of [
      `update ${DROP_VOTER_STATE_TABLE} set votes=:vote where drop_id=:dropId`,
      `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (voter_id,drop_id,wave_id,credit_spent,created_at) values ('fixture-voter',:dropId,:waveId,:creditDelta,30)`,
      `update ${DROP_RANK_TABLE} set vote=:vote,last_increased=30 where drop_id=:dropId`,
      `insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (wave_id,drop_id,timestamp,vote) values (:waveId,:dropId,30,:vote)`,
      `insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (wave_id,drop_id,voter_id,timestamp,vote) values (:waveId,:dropId,'fixture-voter',30,:vote)`
    ]) {
      await sqlExecutor.execute(
        sql,
        { dropId, waveId: wave.id, vote, creditDelta },
        {
          wrappedConnection: connection
        }
      );
    }
  });
}

async function finishBackfill(service: CompetitionMigrationService) {
  for (let batch = 0; batch < 100; batch++) {
    const status = await service.status(id);
    if (status.migration?.state === 'SHADOWING') return;
    await service.backfill(id, operator, 1);
  }
  throw new Error('Bounded fixture did not finish');
}

describeWithSeed(
  'legacy migration disposable MySQL rehearsal',
  [
    withWaves([wave]),
    withIdentities([
      anIdentity(
        { tdh: 100 },
        {
          profile_id: 'fixture-voter',
          consolidation_key: '0xfixture',
          primary_address: '0xfixture',
          handle: 'fixture-voter'
        }
      ),
      anIdentity(
        { tdh: 100 },
        {
          profile_id: 'fixture-author',
          consolidation_key: '0xtarget',
          primary_address: '0xtarget',
          handle: 'fixture-author'
        }
      )
    ]),
    { table: DROPS_TABLE, rows: [drop] },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: drop.id,
          drop_part_id: 1,
          content: 'original content',
          wave_id: null
        }
      ]
    },
    {
      table: DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [{ wave_id: wave.id, drop_id: drop.id, timestamp: 10, vote: 7 }]
    },
    {
      table: DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          wave_id: wave.id,
          drop_id: drop.id,
          voter_id: 'fixture-voter',
          timestamp: 10,
          vote: 7
        }
      ]
    },
    {
      table: DROP_RANK_TABLE,
      rows: [
        { drop_id: drop.id, wave_id: wave.id, vote: 7, last_increased: 10 }
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [
        {
          drop_id: drop.id,
          wave_id: wave.id,
          voter_id: 'fixture-voter',
          votes: 7
        }
      ]
    },
    {
      table: DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
      rows: [
        {
          voter_id: 'fixture-voter',
          drop_id: drop.id,
          wave_id: wave.id,
          credit_spent: 7,
          created_at: 10
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
    });
    afterEach(() => jest.restoreAllMocks());
    it('keeps shared reply settings through catch-up and native cutover with existing capture triggers', async () => {
      const schema = await sqlExecutor.execute<{ COLUMN_NAME: string }>(
        'select COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table order by ORDINAL_POSITION',
        { table: WAVES_TABLE }
      );
      const originalColumns = schema
        .map((column) => column.COLUMN_NAME)
        .filter(
          (column) =>
            column !== 'chat_replies_open' &&
            column !== 'chat_replies_collapsed'
        );
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const name = migrationTriggerName(WAVES_TABLE, operation);
        await sqlExecutor.execute(`drop trigger \`${name}\``);
        await sqlExecutor.execute(
          `create trigger \`${name}\` after ${operation} on ${WAVES_TABLE} for each row ${migrationCaptureStatement(WAVES_TABLE, operation, originalColumns)}`
        );
      }
      await installMigrationCapture(sqlExecutor);
      expect(await migrationCaptureHealthy(sqlExecutor, {})).toBe(true);
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set chat_replies_open=1,chat_replies_collapsed=1,updated_at=123 where id=:waveId`,
        { waveId: wave.id }
      );
      const [change] = await sqlExecutor.execute<{
        after_row: Record<string, unknown> | string;
      }>(
        `select after_row from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id and source_table=:table`,
        { id, table: WAVES_TABLE }
      );
      const image =
        typeof change.after_row === 'string'
          ? JSON.parse(change.after_row)
          : change.after_row;
      expect(image.updated_at).toBe(123);
      expect(image).not.toHaveProperty('chat_replies_open');
      expect(image).not.toHaveProperty('chat_replies_collapsed');
      await service.catchUp(id, operator);
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
      expect(
        await sqlExecutor.oneOrNull(
          `select chat_replies_open,chat_replies_collapsed from ${WAVES_TABLE} where id=:waveId`,
          { waveId: wave.id }
        )
      ).toEqual({ chat_replies_open: true, chat_replies_collapsed: true });
    });
    it('preserves historical vote activity and adjustment metadata through a real ownership transfer', async () => {
      jest
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      await sqlExecutor.execute(
        `insert into ${PROFILES_ACTIVITY_LOGS_TABLE}
          (id,profile_id,target_id,additional_data_1,additional_data_2,type,contents,created_at)
         values ('historical-vote-log','fixture-voter',:dropId,'fixture-author',:waveId,
          'DROP_VOTE_EDIT',:contents,'2025-08-09 12:14:22')`,
        {
          dropId: drop.id,
          waveId: wave.id,
          contents: JSON.stringify({
            reason: 'CREDIT_OVERSPENT',
            oldVote: '85192',
            newVote: 555
          })
        }
      );
      const before = await listCompetitionVoteActivity(wave.id, id, 0, 50, {});
      expect(before).toHaveLength(1);
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      const after = await listCompetitionVoteActivity(wave.id, id, 0, 50, {});
      // Compare the complete wire representation under both owners, including
      // serialized dates and absent optional proxy fields.
      expect(JSON.parse(JSON.stringify(after))).toEqual(
        JSON.parse(JSON.stringify(before))
      );
    });
    it('copies completed historical aggregate and credit discrepancies without repairing them', async () => {
      await sqlExecutor.execute(
        `update ${DROP_RANK_TABLE} set vote=6 where drop_id=:dropId`,
        { dropId: drop.id }
      );
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=0 where profile_id='fixture-voter'`
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(await service.compare(id, operator, 1)).toMatchObject({
        complete: true,
        mismatches: 0,
        sourceFailures: []
      });
      expect(await service.cutover(id, operator, true)).toMatchObject({
        changed: false,
        failures: []
      });
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      const nativeRecord = await sqlExecutor.execute(
        `select * from ${COMPETITIONS_TABLE} where id=:id`,
        { id }
      );
      const sourceWave = await sqlExecutor.execute(
        `select * from ${WAVES_TABLE} where id=:waveId`,
        { waveId: wave.id }
      );
      expect(nativeRecord).toMatchObject([
        { legacy_wave_id: wave.id, lifecycle: 'ENDED' }
      ]);
      expect(sourceWave).toMatchObject([
        {
          participation_period_end: 1000,
          voting_period_end: 1000,
          next_decision_time: null
        }
      ]);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await service.verifyNative(id)).failures).toEqual([]);
        expect(
          await sqlExecutor.execute(
            `select * from ${COMPETITIONS_TABLE} where id=:id`,
            { id }
          )
        ).toEqual(nativeRecord);
        expect(
          await sqlExecutor.execute(
            `select * from ${WAVES_TABLE} where id=:waveId`,
            { waveId: wave.id }
          )
        ).toEqual(sourceWave);
      }

      expect(
        await sqlExecutor.execute(
          `select r.real_time_rating, v.value, v.credit_spent from ${COMPETITION_ENTRY_RUNTIME_TABLE} r join ${COMPETITION_VOTES_TABLE} v on v.entry_id=r.entry_id and v.competition_id=r.competition_id where r.competition_id=:id`,
          { id }
        )
      ).toMatchObject([{ real_time_rating: 6, value: 7, credit_spent: 7 }]);
      expect(
        await sqlExecutor.execute(
          `select vote from ${DROP_RANK_TABLE} where drop_id=:dropId`,
          { dropId: drop.id }
        )
      ).toMatchObject([{ vote: '6' }]);
      expect(
        await sqlExecutor.execute(
          `select votes from ${DROP_VOTER_STATE_TABLE} where drop_id=:dropId`,
          { dropId: drop.id }
        )
      ).toMatchObject([{ votes: 7 }]);
    });
    it('blocks a completed copy altered after comparison before dry-run or live transfer', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set real_time_rating=8 where competition_id=:id`,
        { id }
      );
      for (const dryRun of [true, false]) {
        const result = await service.cutover(id, operator, dryRun);
        expect(result.changed).toBe(false);
        expect(result.failures).toContain('frozen_relation:drop_ranks');
        expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      }
    });
    it.each([0, 60_001])(
      'measures freshness after a slow comparison and retains the age limit (delay %i)',
      async (delay) => {
        let now = Date.now();
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        const getSnapshot =
          LegacyCompetitionBaselineRepository.prototype.getSnapshot;
        jest
          .spyOn(LegacyCompetitionBaselineRepository.prototype, 'getSnapshot')
          .mockImplementation(async function (
            this: LegacyCompetitionBaselineRepository,
            ...args: Parameters<typeof getSnapshot>
          ) {
            const snapshot = await getSnapshot.apply(this, args);
            now += 70_000;
            return snapshot;
          });
        expect(await service.compare(id, operator, 1)).toMatchObject({
          complete: true,
          mismatches: 0,
          sourceFailures: []
        });
        expect((await service.status(id)).migration?.last_comparison_at).toBe(
          now
        );
        now += delay;
        const result = await service.cutover(id, operator, false);
        expect(result.changed).toBe(delay === 0);
        expect(result.failures).toEqual(
          delay === 0 ? [] : ['FINAL_PARITY_FRESHNESS']
        );
        expect((await service.status(id)).storageMode).toBe(
          delay === 0 ? 'NATIVE' : 'LEGACY_ADAPTER'
        );
      }
    );
    it.each([
      [
        'score',
        `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set real_time_rating=8 where competition_id=:id`
      ],
      [
        'vote',
        `update ${COMPETITION_VOTES_TABLE} set value=8 where competition_id=:id`
      ],
      [
        'missing runtime',
        `delete from ${COMPETITION_ENTRY_RUNTIME_TABLE} where competition_id=:id`
      ],
      [
        'orphan vote',
        `update ${COMPETITION_VOTES_TABLE} set entry_id='missing-entry' where competition_id=:id`
      ]
    ])(
      'rejects a migration-introduced completed %s discrepancy',
      async (_kind, mutation) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        await service.compare(id, operator, 1);
        await service.cutover(id, operator, false);
        expect((await service.verifyNative(id)).failures).toEqual([]);
        await sqlExecutor.execute(mutation, { id });
        expect(
          (await service.verifyNative(id)).failures.length
        ).toBeGreaterThan(0);
        expect((await service.status(id)).storageMode).toBe('NATIVE');
      }
    );
    it('installs repeatably, captures accepted writes atomically, and never captures rolled-back writes', async () => {
      await installMigrationCapture(sqlExecutor);
      expect(await migrationCaptureHealthy(sqlExecutor, {})).toBe(true);
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await sqlExecutor.execute(
        `update ${DROP_VOTER_STATE_TABLE} set votes=8 where drop_id=:dropId`,
        { dropId: drop.id }
      );
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=9 where drop_id=:dropId`,
            { dropId: drop.id },
            { wrappedConnection: connection }
          );
          throw new Error('simulate interruption');
        })
      ).rejects.toThrow('simulate interruption');
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      const changes = await sqlExecutor.execute<{
        before_row: Record<string, unknown>;
        after_row: Record<string, unknown> | string;
      }>(
        `select before_row,after_row from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id`,
        { id }
      );
      expect(changes).toHaveLength(1);
      const image =
        typeof changes[0].after_row === 'string'
          ? JSON.parse(changes[0].after_row)
          : changes[0].after_row;
      expect(image.votes).toBe(8);
      await expect(
        sqlExecutor.execute(
          `update ${DROPS_TABLE} set id='moved-drop' where id=:dropId`,
          { dropId: drop.id }
        )
      ).rejects.toThrow('COMPETITION_SOURCE_KEY_MOVE_REQUIRES_REPAIR');
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
    });
    it('resumes bounded stages, preserves entry identity, and permits transfer after matching data', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await executeMigrationCommand(
        parseMigrationOptions([
          '--environment',
          'local',
          '--competition',
          id,
          '--action',
          'enroll',
          '--cohort',
          'COMPLETED_INTERNAL',
          '--operator',
          operator.actor,
          '--reason',
          operator.reason,
          '--live'
        ]),
        service
      );
      await service.backfill(id, operator, 1);
      expect((await service.status(id)).migration?.stage).toBe('OUTCOMES');
      await finishBackfill(
        new CompetitionMigrationService(() => sqlExecutor, Date.now, 0)
      );
      const entries = await sqlExecutor.execute<{
        id: string;
        drop_id: string;
      }>(
        `select id,drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id`,
        { id }
      );
      expect(entries).toEqual([
        { id: legacyCompetitionEntryId(id, drop.id), drop_id: drop.id }
      ]);
      const comparison = await service.compare(id, operator, 1);
      expect(
        comparison.categories
          .filter(
            (category) => category.baselineHash !== category.candidateHash
          )
          .map((category) => category.category)
      ).toEqual([]);
      expect((await service.readiness(id)).failures).toEqual([]);
      expect(await service.cutover(id, operator, true)).toMatchObject({
        changed: false,
        failures: []
      });
      expect(
        (
          await sqlExecutor.oneOrNull<{ storage_mode: string }>(
            `select storage_mode from ${COMPETITIONS_TABLE} where id=:id`,
            { id }
          )
        )?.storage_mode
      ).toBe('LEGACY_ADAPTER');
    });
    it('ranks text-backed positive and negative legacy totals numerically during backfill', async () => {
      const votes = [-5, -2, 12, 9];
      for (let index = 0; index < votes.length; index++) {
        const vote = votes[index];
        const params = {
          dropId: `numeric-migration-drop-${index}`,
          waveId: wave.id,
          vote: String(vote),
          spent: Math.abs(vote),
          timestamp: 20 + index
        };
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
           values (:dropId,:waveId,'fixture-author',:timestamp,1,'PARTICIPATORY',0)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content) values (:dropId,1,'numeric sorting fixture')`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:dropId,:waveId,:vote,0)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROP_VOTER_STATE_TABLE} (drop_id,wave_id,voter_id,votes) values (:dropId,:waveId,'fixture-voter',:vote)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (drop_id,wave_id,voter_id,credit_spent,created_at)
           values (:dropId,:waveId,'fixture-voter',:spent,:timestamp)`,
          params
        );
      }
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        await sqlExecutor.execute(
          `select rating,\`rank\` from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id order by \`rank\``,
          { id }
        )
      ).toEqual([
        { rating: 12, rank: 1 },
        { rating: 9, rank: 2 },
        { rating: 7, rank: 3 },
        { rating: -2, rank: 4 },
        { rating: -5, rank: 5 }
      ]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });
    it('preserves absent legacy rank rows for unvoted entries at cutover', async () => {
      const unvotedDropId = 'unvoted-migration-drop';
      const zeroDropId = 'zero-migration-drop';
      for (const dropId of [unvotedDropId, zeroDropId]) {
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
         values (:dropId,:waveId,'fixture-author',20,1,'PARTICIPATORY',0)`,
          { dropId, waveId: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content) values (:dropId,1,'unvoted fixture')`,
          { dropId }
        );
      }
      await sqlExecutor.execute(
        `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:dropId,:waveId,0,0)`,
        { dropId: zeroDropId, waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect(
        await sqlExecutor.execute(
          `select drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id order by drop_id`,
          { id }
        )
      ).toEqual([
        { drop_id: drop.id },
        { drop_id: unvotedDropId },
        { drop_id: zeroDropId }
      ]);
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${DROP_RANK_TABLE} where wave_id=:waveId order by drop_id`,
            { waveId: wave.id }
          )
        )
      ).toEqual([{ drop_id: drop.id }, { drop_id: zeroDropId }]);
      // A first negative native vote must be visible even without an increase.
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set real_time_rating=-2 where entry_id=:entryId`,
        { entryId: legacyCompetitionEntryId(id, unvotedDropId) }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select vote from ${DROP_RANK_TABLE} where drop_id=:dropId`,
            { dropId: unvotedDropId }
          )
        )
      ).toEqual([{ vote: '-2' }]);
    });
    it('rebuilds derived shadow data on retry after a failed independent comparison', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} set \`rank\`=9 where competition_id=:id`,
        { id }
      );
      expect((await service.compare(id, operator, 1)).mismatches).toBe(1);
      expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      const resumed = await service.resumeMigration(id, operator);
      expect(resumed.migration).toMatchObject({
        state: 'BACKFILLING',
        stage: 'ENTRIES',
        stage_offset: 0,
        source_watermark: 0,
        applied_watermark: 0,
        completed_stages: ['CONFIGURATION', 'OUTCOMES']
      });
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, true)).toMatchObject({
        failures: []
      });
    });
    it('preserves historical time locks below the current creation minimum', async () => {
      await sqlExecutor.execute(
        'update waves set time_lock_ms=240000 where id=:waveId',
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        (await service.compare(id, operator, 1)).categories
          .filter(
            (category) => category.baselineHash !== category.candidateHash
          )
          .map((category) => category.category)
      ).toEqual([]);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      const repository = new CompetitionRepository();
      const raw = await repository.findCompetitionRecordById(id, {});
      if (!raw) throw new Error('Missing migrated competition');
      const record = repository.parseCompetitionRecord(raw);
      const competition = await new NativeCompetitionReader(
        new CompetitionRepository(),
        {}
      ).getCompetition(record, Date.now());
      expect(competition.decisions.time_lock_ms).toBe(240000);
      expect(
        migrationCommandConfiguration(competition).rules.time_lock_ms
      ).toBe(240000);
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId`,
            { waveId: wave.id }
          )
        )
      ).toEqual([]);
      await sqlExecutor.execute(
        `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} set updated_at=100 where competition_id=:id`,
        { id }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId`,
            { waveId: wave.id }
          )
        )
      ).toEqual([{ drop_id: drop.id }]);
    });
    it('counts seven full consecutive windows, resets on independent mismatch, and refuses a partial window', async () => {
      let clock = 1000000;
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        (await service.compare(id, operator, 60000)).consecutiveFullWindows
      ).toBe(0);
      for (let i = 1; i <= 7; i++) {
        clock += 60000;
        expect(
          (await service.compare(id, operator, 60000)).consecutiveFullWindows
        ).toBe(i);
      }
      clock += 1;
      expect(
        (await service.compare(id, operator, 60000)).consecutiveFullWindows
      ).toBe(7);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set submitter_id='deliberate-candidate-mismatch' where competition_id=:id`,
        { id }
      );
      const mismatch = await service.compare(id, operator, 60000);
      expect(mismatch.mismatches).toBeGreaterThan(0);
      expect(mismatch.consecutiveFullWindows).toBe(0);
    });
    it('does not count complete windows while transferred votes exceed the live source credit budget', async () => {
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set participation_period_end=null,voting_period_end=null,next_decision_time=2000000 where id=:waveId`,
        { waveId: wave.id }
      );
      let clock = 1000000;
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock,
        0
      );
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=0 where profile_id='fixture-voter'`
      );
      await service.compare(id, operator, 60000);
      clock += 60000;
      expect(await service.compare(id, operator, 60000)).toMatchObject({
        complete: false,
        consecutiveFullWindows: 0,
        sourceFailures: ['SOURCE_CREDIT_OVERSPENT']
      });
    });
    it('rehearses explicit CLI cutover, native frozen reads, bounded reverse reconciliation and atomic rollback', async () => {
      let clock = 1000000;
      const flags = [
        'FEATURE_NATIVE_COMPETITION_WRITES',
        'FEATURE_NATIVE_COMPETITION_EXECUTION',
        'COMPETITION_LEGACY_GET_FACADE_ENABLED'
      ];
      const saved = flags.map((key) => process.env[key]);
      try {
        for (const key of flags) process.env[key] = 'true';
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => clock,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        const record =
          (await new CompetitionRepository().findCompetitionRecordById(
            id,
            {}
          ))!;
        const siblingId = '10000000-0000-4000-8000-000000000099';
        await sqlExecutor.execute(
          `insert into ${COMPETITIONS_TABLE} (id,wave_id,legacy_wave_id,storage_mode,execution_mode,type,lifecycle,title,
           participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,created_at,updated_at,published_at)
           select :siblingId,wave_id,null,'NATIVE','ACTIVE',type,'PUBLISHED','Sibling native competition',
           participation_config,voting_config,decision_config,winner_config,outcome_config,1,:clock,:clock,:clock
           from ${COMPETITIONS_TABLE} where id=:id`,
          { id, siblingId, clock }
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,title,parts_count,drop_type,hide_link_preview)
           values ('sibling-native-drop',:waveId,'fixture-author',10,'Sibling content',1,'COMPETITION',0),
           ('shared-chat-drop',:waveId,'fixture-author',10,'Shared chat',1,'CHAT',0)`,
          { waveId: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
           values ('20000000-0000-4000-8000-000000000099',:siblingId,:waveId,'sibling-native-drop','fixture-author','ACTIVE',1,10)`,
          { siblingId, waveId: wave.id }
        );
        const sharedSource = await sqlExecutor.execute(
          `select * from ${DROPS_TABLE} where id in ('sibling-native-drop','shared-chat-drop') order by id`
        );
        const configuration = await new NativeCompetitionReader(
          new CompetitionRepository(),
          {},
          true
        ).getCompetition(record, clock);
        expect(() =>
          migrationCommandConfiguration(configuration)
        ).not.toThrow();
        // Disposable evidence demonstrates gate mechanics only; this is not
        // production acceptance and is never written outside the test database.
        await service.recordAcceptance(id, operator, {
          nativeRankCompletion: 'https://example.test/fixture/rank',
          nativeApproveCompletion: 'https://example.test/fixture/approve',
          operationalAcceptance: 'https://example.test/fixture/ops',
          compatibilityAcceptance: 'https://example.test/fixture/get',
          rollbackRehearsal: 'https://example.test/fixture/rollback',
          alertsVerified: 'https://example.test/fixture/alerts',
          productionEvidenceVerifiedBy: operator.actor,
          productionEvidenceVerifiedAt: clock,
          comparisonWindowMs: 60000,
          serviceRevisions: Object.fromEntries(
            [
              'api',
              'waveDecisionExecutionLoop',
              'waveLeaderboardSnapshotterLoop',
              'tdhLoop'
            ].map((name) => [name, 'a'.repeat(40)])
          ),
          apiBaselineP95: 100,
          apiP95: 100,
          apiBudgetP95: 150,
          apiBaselineErrorRate: 0,
          apiErrorRate: 0,
          decisionBudgetP95: 60,
          decisionBudgetP99: 120,
          decisionP95: 10,
          decisionP99: 20,
          incidentWindowStartsAt: clock - 1,
          incidentWindowEndsAt: clock + 3600000
        });
        await service.compare(id, operator, 60000);
        for (let i = 0; i < 7; i++) {
          clock += 60000;
          await service.compare(id, operator, 60000);
        }
        expect((await service.readiness(id)).failures).toEqual([]);
        const args = [
          '--environment',
          'local',
          '--competition',
          id,
          '--action',
          'cutover',
          '--operator',
          operator.actor,
          '--reason',
          operator.reason
        ];
        expect(
          await executeMigrationCommand(parseMigrationOptions(args), service)
        ).toMatchObject({ changed: false, failures: [] });
        expect(
          await executeMigrationCommand(
            parseMigrationOptions([...args, '--live']),
            service
          )
        ).toMatchObject({ changed: true, failures: [] });
        await expect(
          sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=8 where drop_id=:dropId`,
            { dropId: drop.id }
          )
        ).rejects.toThrow('COMPETITION_NATIVE_OWNER_RETRY');
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            await withLegacyCompetitionProfileMerge(
              sqlExecutor,
              ['fixture-voter'],
              'fixture-author',
              () =>
                new DropVotingDb(() => sqlExecutor).mergeOnProfileIdChange(
                  { previous_id: 'fixture-voter', new_id: 'fixture-author' },
                  ctx
                ),
              ctx
            );
          }
        );
        expect(
          await sqlExecutor.execute(
            `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual([
          { voter_profile_id: 'fixture-author', value: 7, credit_spent: 7 }
        ]);
        expect((await service.verifyNative(id)).failures).toEqual([]);
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set title='Native title fixture' where id=:id`,
          { id }
        );
        const nativeView = await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.oneOrNull<{ name: string }>(
            `select name from waves where id=:waveId`,
            { waveId: wave.id }
          )
        );
        expect(nativeView?.name).toBe('Native title fixture');
        expect(await service.rollback(id, operator, true)).toMatchObject({
          changed: false,
          failures: ['REVERSE_RECONCILIATION_INCOMPLETE']
        });
        for (let batch = 0; batch < 100; batch++) {
          if ((await service.status(id)).migration?.reverse_ready) break;
          await service.reverseReconcile(id, operator, 1);
        }
        expect((await service.status(id)).migration?.reverse_ready).toBe(true);
        expect(await service.rollback(id, operator, true)).toMatchObject({
          changed: false,
          failures: []
        });
        expect(await service.rollback(id, operator, false)).toMatchObject({
          changed: true,
          repairRequired: false
        });
        expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
        expect(
          await sqlExecutor.execute(
            `select * from ${DROPS_TABLE} where id in ('sibling-native-drop','shared-chat-drop') order by id`
          )
        ).toEqual(sharedSource);
        expect(
          await withLegacyCompetitionGetFacade(() =>
            sqlExecutor.oneOrNull(
              `select drop_type from ${DROPS_TABLE} where id='sibling-native-drop'`
            )
          )
        ).toEqual({ drop_type: 'CHAT' });
        expect(
          (
            await sqlExecutor.oneOrNull<{ name: string }>(
              `select name from waves where id=:waveId`,
              { waveId: wave.id }
            )
          )?.name
        ).toBe('Native title fixture');
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        expect((await service.compare(id, operator, 60000)).mismatches).toBe(0);
        const reenrolled = await service.status(id);
        expect(reenrolled.migration?.acceptance).toBeNull();
        expect(reenrolled.migration?.consecutive_full_windows).toBe(0);
      } finally {
        for (let i = 0; i < flags.length; i++) {
          if (saved[i] === undefined) delete process.env[flags[i]];
          else process.env[flags[i]] = saved[i];
        }
      }
    });
    it('retains native ownership and immutable drop types when reverse materialization encounters a native-created primary entry', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
         values ('native-created-primary',:waveId,'fixture-author',10,1,'COMPETITION',0)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
         values ('20000000-0000-4000-8000-000000000098',:id,:waveId,'native-created-primary','fixture-author','ACTIVE',1,10)`,
        { id, waveId: wave.id }
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set storage_mode='NATIVE' where id=:id`,
        { id }
      );
      // Isolate reverse refusal; the full cutover gate is exercised above.
      await sqlExecutor.execute(
        `update ${COMPETITION_MIGRATIONS_TABLE} set state='NATIVE',reverse_checkpoint=:checkpoint where competition_id=:id`,
        {
          id,
          checkpoint: JSON.stringify({
            index: LEGACY_GET_SOURCE_TABLES.indexOf(DROPS_TABLE),
            phase: 'COPY',
            cursor: null
          })
        }
      );
      await expect(
        executeMigrationCommand(
          parseMigrationOptions([
            '--environment',
            'local',
            '--competition',
            id,
            '--action',
            'reverse-reconcile',
            '--operator',
            operator.actor,
            '--reason',
            operator.reason,
            '--live'
          ]),
          service
        )
      ).rejects.toThrow(
        'OWNED_EXCEPTION: reverse reconciliation cannot change native-created primary drop types'
      );
      const guarded = await service.status(id);
      expect(guarded.storageMode).toBe('NATIVE');
      expect(guarded.migration?.state).toBe('ROLLBACK_REQUIRED');
      expect(guarded.migration?.reverse_ready).toBe(false);
      expect(guarded.migration?.exceptions).toContain(
        `NATIVE_MIGRATION_DATA_SHAPE:${operator.actor}`
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select drop_type from ${DROPS_TABLE} where id='native-created-primary'`
        )
      ).toEqual({ drop_type: 'COMPETITION' });
      expect(
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))
          ?.storage_mode
      ).toBe('NATIVE');
    });
    it('copies a valid outcome distribution spanning multiple pages without a size stop', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVE_OUTCOMES_TABLE} (wave_id,wave_outcome_position,type,description)
         values (:waveId,1,'MANUAL','Paginated migration outcome')`,
        { waveId: wave.id }
      );
      const rows = Array.from(
        { length: 1001 },
        (_, index) => `(:waveId,1,${index + 1},'fixture',null)`
      ).join(',');
      await sqlExecutor.execute(
        `insert into ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE}
         (wave_id,wave_outcome_position,wave_outcome_distribution_item_position,description,amount) values ${rows}`,
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        await sqlExecutor.oneOrNull<{ count: number }>(
          `select count(*) as count from ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 1001 });
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('retains oversized orphan distribution history without an artificial size stop', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await service.backfill(id, operator, 25);
      for (let position = 1; position <= 101; position++)
        await sqlExecutor.execute(
          `insert into ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} (wave_id,wave_outcome_position,wave_outcome_distribution_item_position,description,amount) values (:waveId,1,:position,'fixture',null)`,
          { waveId: wave.id, position }
        );
      await service.backfill(id, operator, 100);
      const status = await service.status(id);
      expect(status.storageMode).toBe('LEGACY_ADAPTER');
      expect(status.migration?.exceptions).toEqual([]);
      expect(
        await sqlExecutor.oneOrNull<{ count: number }>(
          `select count(*) as count from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id=:waveId`,
          { waveId: wave.id }
        )
      ).toEqual({ count: 101 });
    });
    it('captures child edits with a null wave cache, resumes one journal row at a time and detects stored content corruption', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${DROPS_PARTS_TABLE} set content='accepted content edit' where drop_id=:dropId`,
        { dropId: drop.id }
      );
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      expect(
        (await service.compare(id, operator, 60000)).mismatches
      ).toBeGreaterThan(0);
      await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect((await service.compare(id, operator, 60000)).mismatches).toBe(0);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} set content=json_set(content,'$.title','corrupt candidate') where competition_id=:id`,
        { id }
      );
      const report = await service.compare(id, operator, 60000);
      expect(
        report.categories.find(
          (item) => item.category === 'native_entry_content'
        )
      ).toEqual(
        expect.objectContaining({
          baselineHash: expect.any(String),
          candidateHash: expect.any(String)
        })
      );
      expect(report.mismatches).toBeGreaterThan(0);
      expect(report.consecutiveFullWindows).toBe(0);
    });
    it('preserves deleted source winners and prizes without restoring their submissions', async () => {
      const prizes = [
        { type: 'MANUAL', description: 'historical award', amount: null }
      ];
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values (:waveId,100,:dropId,1,-4,:prizes)`,
        { waveId: wave.id, dropId: drop.id, prizes: JSON.stringify(prizes) }
      );
      await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id=:dropId`, {
        dropId: drop.id
      });
      // Normal drop deletion clears mutable ranks/votes while retaining winners.
      for (const table of [
        DROP_RANK_TABLE,
        WAVE_LEADERBOARD_ENTRIES_TABLE,
        DROP_VOTER_STATE_TABLE,
        DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
        DROP_REAL_VOTE_IN_TIME_TABLE,
        DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
      ]) {
        await sqlExecutor.execute(
          `delete from ${table} where drop_id=:dropId`,
          {
            dropId: drop.id
          }
        );
      }
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      const repository = new CompetitionRepository();
      expect(
        (
          await repository.listNativeEntries(
            id,
            { offset: 0, limit: 10, direction: 'ASC' },
            {}
          )
        ).data
      ).toEqual([]);
      expect(
        (
          await repository.listNativeDecisions(
            id,
            { offset: 0, limit: 10, direction: 'ASC' },
            {}
          )
        ).data[0].winners
      ).toEqual([
        {
          entry_id: legacyCompetitionEntryId(id, drop.id),
          rank: 1,
          final_rating: -4
        }
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select legacy_drop_id from ${COMPETITION_DECISION_WINNERS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ legacy_drop_id: drop.id });
      const projected = await withLegacyCompetitionGetFacade(() =>
        sqlExecutor.execute<{ drop_id: string; prizes: string }>(
          `select drop_id,prizes from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId`,
          { waveId: wave.id }
        )
      );
      expect(
        projected.map((row) => ({
          drop_id: row.drop_id,
          prizes: JSON.parse(row.prizes)
        }))
      ).toEqual([{ drop_id: drop.id, prizes }]);
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it('copies empty decisions in bounded pages instead of one decision per checkpoint', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values ${Array.from({ length: 30 }, (_, index) => `(:waveId,${100 + index})`).join(',')}`,
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'DECISIONS')
        await service.backfill(id, operator, 10);
      await service.backfill(id, operator, 10);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 10 });
      expect((await service.status(id)).migration?.stage_offset).toBe(109);
      await service.backfill(id, operator, 10);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 20 });
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('shares the decision batch budget with winners and resumes the unprocessed decision', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100),(:waveId,200),(:waveId,300)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values (:waveId,100,:dropId,1,7,'[]'),(:waveId,200,:dropId,1,7,'[]')`,
        { waveId: wave.id, dropId: drop.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'DECISIONS')
        await service.backfill(id, operator, 3);
      await service.backfill(id, operator, 3);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 1 });
      expect((await service.status(id)).migration?.stage_offset).toBe(100);
      await service.backfill(id, operator, 3);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 3 });
    });

    it('retains legacy ownership when one historical entry won multiple decisions', async () => {
      await sqlExecutor.execute(
        `update ${DROPS_TABLE} set drop_type='WINNER' where id=:dropId`,
        { dropId: drop.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100),(:waveId,200)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values (:waveId,100,:dropId,4,7,'[]'),(:waveId,200,:dropId,2,7,'[]')`,
        { waveId: wave.id, dropId: drop.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'ARCHIVE_VOTERS')
        await service.backfill(id, operator, 1);
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      const baseline = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, Date.now(), {});
      expect(baseline.entries).toEqual([
        expect.objectContaining({ drop_id: drop.id, rank: 2 })
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select \`rank\` from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id and drop_id=:dropId`,
          { id, dropId: drop.id }
        )
      ).toEqual({ rank: 2 });
      await expect(service.backfill(id, operator, 1)).rejects.toThrow(
        'historical winner identity requires a reviewed mapping'
      );
      expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: false
      });
    });

    it('catches recurring decisions without replaying unchanged history', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100),(:waveId,200),(:waveId,300)`,
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,400)`,
        { waveId: wave.id }
      );
      await service.catchUp(id, operator, 1);
      let nextDecision = 500;
      for (let iteration = 0; iteration < 50; iteration++) {
        const status = await service.status(id);
        if (status.migration?.state === 'SHADOWING') break;
        // A decision arrives on every replayed historical page. A full replay
        // would keep chasing the growing tail instead of acknowledging capture.
        if (status.migration?.stage === 'DECISIONS') {
          await sqlExecutor.execute(
            `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,:time)`,
            { waveId: wave.id, time: nextDecision++ }
          );
        }
        await service.backfill(id, operator, 1);
      }
      const status = await service.status(id);
      expect(status.migration?.state).toBe('SHADOWING');
      expect(status.migration?.source_watermark).toBe(
        status.migration?.applied_watermark
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 4 });
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      await service.cutover(id, operator, false);
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it('rebuilds changed and moved decision keys and removes deleted keys before acknowledging capture', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100),(:waveId,200),(:waveId,300)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `update ${DROPS_TABLE} set drop_type='WINNER' where id=:dropId`,
        { dropId: drop.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values (:waveId,100,:dropId,1,7,'[]')`,
        { waveId: wave.id, dropId: drop.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${WAVES_DECISION_WINNER_DROPS_TABLE} set decision_time=200,final_vote=9 where wave_id=:waveId and decision_time=100`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `update ${WAVES_DECISIONS_TABLE} set decision_time=400 where wave_id=:waveId and decision_time=300`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `delete from ${WAVES_DECISIONS_TABLE} where wave_id=:waveId and decision_time=100`,
        { waveId: wave.id }
      );
      for (let page = 0; page < 3; page++)
        await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect((await service.status(id)).operations?.journalLag).toBe(0);
      expect(
        await sqlExecutor.execute(
          `select scheduled_at from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id order by scheduled_at`,
          { id }
        )
      ).toEqual([{ scheduled_at: 200 }, { scheduled_at: 400 }]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });
    it('replays both keys when a legacy voter identity changes during capture', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          for (const table of [
            DROP_VOTER_STATE_TABLE,
            DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
            DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
          ]) {
            await sqlExecutor.execute(
              `update ${table} set voter_id='fixture-author' where voter_id='fixture-voter'`,
              {},
              { wrappedConnection: connection }
            );
          }
        }
      );
      for (let batch = 0; batch < 3; batch++)
        await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect(
        await sqlExecutor.execute(
          `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([
        { voter_profile_id: 'fixture-author', value: 7, credit_spent: 7 }
      ]);
    });
    it('captures a concurrent vote while a partially completed copy resumes, and catches up through its watermark', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await service.backfill(id, operator, 1);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          await sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=9 where drop_id=:dropId`,
            { dropId: drop.id },
            options
          );
          await sqlExecutor.execute(
            `update ${DROP_RANK_TABLE} set vote=9 where drop_id=:dropId`,
            { dropId: drop.id },
            options
          );
          await sqlExecutor.execute(
            `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (voter_id,drop_id,wave_id,credit_spent,created_at) values ('fixture-voter',:dropId,:waveId,2,11)`,
            { dropId: drop.id, waveId: wave.id },
            options
          );
        }
      );
      await finishBackfill(service);
      expect((await service.status(id)).readiness?.sourceWatermark).toBe(3);
      await service.catchUp(id, operator);
      await finishBackfill(service);
      const status = await service.status(id);
      expect(status.readiness?.sourceWatermark).toBe(
        status.readiness?.appliedWatermark
      );
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      await service.catchUp(id, operator);
      expect((await service.status(id)).migration?.state).toBe('SHADOWING');
    });

    it('copies bounded voter pages with the exact scalar values and raw orphan cursors', async () => {
      const variants = [
        {
          id: 'a-bulk-negative',
          type: 'PARTICIPATORY',
          voter: 'MIXED-VOTER',
          votes: -5
        },
        { id: 'b-bulk-zero', type: 'WINNER', voter: 'bulk-zero', votes: 0 },
        { id: 'c-bulk-chat', type: 'CHAT', voter: 'bulk-chat', votes: 9 },
        { id: 'd-bulk-missing', type: null, voter: 'bulk-orphan', votes: 4 }
      ];
      for (const item of variants) {
        if (item.type)
          await sqlExecutor.execute(
            `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
             values (:dropId,:waveId,'fixture-author',10,1,:type,0)`,
            { dropId: item.id, waveId: wave.id, type: item.type }
          );
        await sqlExecutor.execute(
          `insert into ${DROP_VOTER_STATE_TABLE} (drop_id,wave_id,voter_id,votes) values (:dropId,:waveId,:voter,:votes)`,
          {
            dropId: item.id,
            waveId: wave.id,
            voter: item.voter,
            votes: item.votes
          }
        );
      }
      // Credit keys compare under MySQL collation, while copied IDs retain the
      // spelling of the voter-state row. Other waves/drops/voters never leak in.
      await sqlExecutor.execute(
        `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (drop_id,wave_id,voter_id,credit_spent,created_at)
         values ('a-bulk-negative',:waveId,'mixed-voter',2,30),
                ('a-bulk-negative',:waveId,'mixed-voter',3,20),
                ('a-bulk-negative','other-wave','mixed-voter',100,1),
                ('a-bulk-negative',:waveId,'other-voter',200,2)`,
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      const backfill = new CompetitionMigrationBackfill(sqlExecutor);
      const allKeys = await sqlExecutor.execute<{
        drop_id: string;
        voter_id: string;
      }>(
        `select drop_id,voter_id from ${DROP_VOTER_STATE_TABLE} where wave_id=:waveId order by drop_id,voter_id`,
        { waveId: wave.id }
      );
      for (const key of allKeys)
        await backfill.vote(record, key.drop_id, key.voter_id, {});
      const read = () =>
        sqlExecutor.execute(
          `select * from ${COMPETITION_VOTES_TABLE} where competition_id=:id order by entry_id,voter_profile_id`,
          { id }
        );
      const scalar = await read();
      await sqlExecutor.execute(
        `delete from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
        { id }
      );
      // Stale ineligible rows must be removed when their raw source keys pass.
      for (const item of variants.filter(
        (item) => !item.type || item.type === 'CHAT'
      )) {
        await backfill.vote(record, drop.id, 'fixture-voter', {});
        await sqlExecutor.execute(
          `insert into ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at)
           values (:voteId,:id,:entryId,:voter,99,99,1,1)`,
          {
            voteId: item.id,
            id,
            entryId: legacyCompetitionEntryId(id, item.id),
            voter: item.voter
          }
        );
      }
      while ((await service.status(id)).migration?.stage !== 'VOTERS')
        await service.backfill(id, operator, 10);
      const first = await service.backfill(id, operator, 3);
      expect(first.migration?.stage_cursor).toBe(
        JSON.stringify(['c-bulk-chat', 'bulk-chat'])
      );
      await service.backfill(id, operator, 3);
      expect(await read()).toEqual(scalar);
      expect(scalar).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            voter_profile_id: 'MIXED-VOTER',
            value: -5,
            credit_spent: 5,
            created_at: 20,
            updated_at: 20
          }),
          expect.objectContaining({
            voter_profile_id: 'bulk-zero',
            value: 0,
            credit_spent: 0,
            created_at: 0,
            updated_at: 0
          })
        ])
      );
    });

    it('rolls back a timed-out bulk voter copy and preserves its complete checkpoint', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'VOTERS')
        await service.backfill(id, operator, 10);
      const before = (await service.status(id)).migration;
      const original = CompetitionMigrationBackfill.prototype.batch;
      const slow = jest
        .spyOn(CompetitionMigrationBackfill.prototype, 'batch')
        .mockImplementationOnce(async function (
          this: CompetitionMigrationBackfill,
          ...args
        ) {
          const result = await original.apply(this, args);
          await sqlExecutor.execute(
            'SELECT SLEEP(2)',
            {},
            { wrappedConnection: args[6].connection }
          );
          return result;
        });
      await expect(service.backfill(id, operator, 25)).rejects.toBeInstanceOf(
        SqlExecutionBudgetExceededError
      );
      slow.mockRestore();
      const after = (await service.status(id)).migration;
      for (const key of [
        'state',
        'stage',
        'stage_offset',
        'stage_cursor',
        'completed_stages',
        'reset_table_index',
        'target_watermark',
        'applied_watermark',
        'cutover_at',
        'next_batch_at'
      ] as const)
        expect(after?.[key]).toEqual(before?.[key]);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 0 });
      await service.backfill(id, operator, 25);
      expect(
        await sqlExecutor.oneOrNull(
          `select value from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ value: 7 });
    });

    it('releases copy ownership before full reporting and retains a committed checkpoint if reporting fails', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      const before = (await service.status(id)).migration;
      const original = CompetitionMigrationRepository.prototype.status;
      const report = jest
        .spyOn(CompetitionMigrationRepository.prototype, 'status')
        .mockImplementationOnce(async function (
          this: CompetitionMigrationRepository,
          ...args
        ) {
          // This uses a different physical connection. Reporting must not retain
          // the migration owner's lock after committing the durable batch.
          await sqlExecutor.executeNativeQueriesInTransaction(
            async (connection) => {
              await new CompetitionRepository().lockLegacyExecutionOwner(
                wave.id,
                { connection }
              );
            },
            {
              isolationLevel: 'REPEATABLE READ',
              executionBudget: {
                deadlineMonotonicMillis: performance.now() + 2_000,
                maxStatementMillis: 500,
                finalizationReserveMillis: 250,
                lockWaitSeconds: 1
              }
            }
          );
          await original.apply(this, args);
          throw new Error('report unavailable');
        });
      await expect(service.backfill(id, operator, 10)).rejects.toThrow(
        'report unavailable'
      );
      report.mockRestore();
      const after = await service.status(id);
      expect(after.migration?.stage).not.toBe(before?.stage);
      expect(after.storageMode).toBe('LEGACY_ADAPTER');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('sub-pages a 100-voter checkpoint while preserving every vote and its raw cursor', async () => {
      await sqlExecutor.bulkInsert(
        DROP_VOTER_STATE_TABLE,
        Array.from({ length: 100 }, (_, index) => ({
          drop_id: drop.id,
          wave_id: wave.id,
          voter_id: `bulk-${String(index).padStart(3, '0')}`,
          votes: index
        })),
        ['drop_id', 'wave_id', 'voter_id', 'votes']
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'VOTERS')
        await service.backfill(id, operator, 10);
      const execute = jest.spyOn(sqlExecutor, 'execute');
      const result = await service.backfill(id, operator, 100);
      const creditQueries = execute.mock.calls.filter(([sql]) =>
        sql.includes('group by s.drop_id,s.voter_id')
      );
      expect(creditQueries).toHaveLength(4);
      for (const [, params] of creditQueries)
        expect(
          Object.keys(params ?? {}).filter((key) => /^drop[0-9]+$/.test(key))
        ).toHaveLength(25);
      execute.mockRestore();
      expect(result.migration?.stage_cursor).toBe(
        JSON.stringify([drop.id, 'bulk-099'])
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count,sum(value) total from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 100, total: 4950 });
      await service.backfill(id, operator, 100);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) count,sum(value) total from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 101, total: 4957 });
    });

    it('returns current durable status when a peer advances between copy commit and reporting', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      const original = CompetitionMigrationRepository.prototype.status;
      const report = jest
        .spyOn(CompetitionMigrationRepository.prototype, 'status')
        .mockImplementationOnce(async function (
          this: CompetitionMigrationRepository,
          ...args
        ) {
          // The first call committed CONFIGURATION. The peer can now commit
          // OUTCOMES before the first caller establishes its reporting snapshot.
          await service.backfill(id, operator, 10);
          return original.apply(this, args);
        });
      const result = await service.backfill(id, operator, 10);
      report.mockRestore();
      expect(result.migration?.stage).toBe('ENTRIES');
      expect(result.migration?.completed_stages).toEqual(
        expect.arrayContaining(['CONFIGURATION', 'OUTCOMES'])
      );
      expect(result).toEqual(await service.status(id));
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('preserves scalar credit lookup semantics for differently cased stored voter IDs', async () => {
      const profileId = 'FIXTURE-VOTER';
      for (const table of [
        DROP_VOTER_STATE_TABLE,
        DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
        DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
      ])
        await sqlExecutor.execute(
          `update ${table} set voter_id=:profileId where wave_id=:waveId`,
          { profileId, waveId: wave.id }
        );
      const scalar = await sqlExecutor.oneOrNull<{ tdh: number }>(
        `select tdh from ${IDENTITIES_TABLE} where profile_id=:profileId`,
        { profileId }
      );
      const expected = Math.max(0, Math.floor(Number(scalar?.tdh ?? 0)));
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      const baseline = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, Date.now(), {});
      expect(baseline.credit_budgets).toEqual([
        {
          profile_id: profileId,
          drop_id: null,
          available: expected,
          spent: 7,
          remaining: Math.max(0, expected - 7)
        }
      ]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it.each(['comparison', 'cutover'])(
      'releases the ownership fence after a slow %s statement without transferring storage',
      async (operation) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
        const slow = jest
          .spyOn(CompetitionMigrationContentRepository.prototype, 'sourcePage')
          .mockImplementationOnce(async (_drops, ctx) => {
            await sqlExecutor.execute(
              'SELECT SLEEP(2)',
              {},
              { wrappedConnection: ctx.connection }
            );
            return new Map();
          });
        await expect(
          operation === 'comparison'
            ? service.compare(id, operator, 1)
            : service.cutover(id, operator, false)
        ).rejects.toBeInstanceOf(SqlExecutionBudgetExceededError);
        slow.mockRestore();
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const owner =
              await new CompetitionRepository().lockLegacyExecutionOwner(
                wave.id,
                { connection }
              );
            expect(owner).toMatchObject({
              storage_mode: 'LEGACY_ADAPTER',
              execution_mode: 'ACTIVE'
            });
          },
          {
            isolationLevel: 'REPEATABLE READ',
            executionBudget: {
              deadlineMonotonicMillis: performance.now() + 2_000,
              maxStatementMillis: 500,
              finalizationReserveMillis: 250,
              lockWaitSeconds: 1
            }
          }
        );
        expect((await service.status(id)).migration?.cutover_at).toBeNull();
      }
    );

    it.each(['ACTIVE', 'WINNER', 'WITHDRAWN', 'DISQUALIFIED', null])(
      'retains the complete unrestricted drop facade with native status %s',
      async (status) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        const chatId = 'facade-chat-native';
        const winnerId = 'facade-winner-without-native';
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
           values (:chatId,:waveId,'fixture-author',20,1,'CHAT',0),
                  (:winnerId,:waveId,'fixture-author',21,1,'WINNER',0),
                  ('facade-plain-chat',:waveId,'fixture-author',22,1,'CHAT',0)`,
          { chatId, winnerId, waveId: wave.id }
        );
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            const options = { wrappedConnection: connection };
            const entryId = legacyCompetitionEntryId(id, drop.id);
            const original = (await sqlExecutor.oneOrNull<
              Record<string, unknown>
            >(
              `select * from ${COMPETITION_ENTRIES_TABLE} where id=:entryId`,
              { entryId },
              options
            ))!;
            if (status === null) {
              await sqlExecutor.execute(
                `delete from ${COMPETITION_ENTRIES_TABLE} where id=:entryId`,
                { entryId },
                options
              );
            } else {
              await sqlExecutor.execute(
                `update ${COMPETITION_ENTRIES_TABLE} set status=:status where id=:entryId`,
                { entryId, status },
                options
              );
              await sqlExecutor.bulkInsert(
                COMPETITION_ENTRIES_TABLE,
                [
                  {
                    ...original,
                    id: legacyCompetitionEntryId(id, chatId),
                    drop_id: chatId,
                    status
                  }
                ],
                Object.keys(original),
                ctx
              );
            }
            await withLegacyShadowGetFacade(sqlExecutor, id, ctx, async () => {
              const unrestricted = await sqlExecutor.execute<
                Record<string, unknown>
              >(
                `select * from ${legacyGetView(DROPS_TABLE)} where wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER')`,
                { waveId: wave.id },
                options
              );
              const bounded = await readLegacyDropFacadeForComparison(
                sqlExecutor,
                id,
                wave.id,
                ctx
              );
              const hashes = (rows: Record<string, unknown>[]) =>
                rows
                  .map(competitionPayloadHash)
                  .sort((a, b) => a.localeCompare(b));
              expect(hashes(bounded)).toEqual(hashes(unrestricted));
              const ids = bounded.map((row) => row.id);
              expect(ids).toContain(winnerId);
              expect(ids).not.toContain('facade-plain-chat');
              if (status === 'ACTIVE' || status === 'WINNER')
                expect(ids).toContain(chatId);
              else expect(ids).not.toContain(chatId);
              if (status === 'WITHDRAWN' || status === 'DISQUALIFIED')
                expect(ids).not.toContain(drop.id);
              else expect(ids).toContain(drop.id);
            });
          }
        );
      }
    );

    it('rejects a withdrawn source entry even when an extra active native entry balances the count', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const options = { wrappedConnection: connection };
          const before = await compareMigrationContent(
            sqlExecutor,
            id,
            wave.id,
            ctx
          );
          expect(before[0].baselineHash).toBe(before[0].candidateHash);
          const entryId = legacyCompetitionEntryId(id, drop.id);
          const original = (await sqlExecutor.oneOrNull<
            Record<string, unknown>
          >(
            `select * from ${COMPETITION_ENTRIES_TABLE} where id=:entryId`,
            { entryId },
            options
          ))!;
          await sqlExecutor.execute(
            `update ${COMPETITION_ENTRIES_TABLE} set status='WITHDRAWN' where id=:entryId`,
            { entryId },
            options
          );
          await sqlExecutor.bulkInsert(
            COMPETITION_ENTRIES_TABLE,
            [
              {
                ...original,
                id: 'extra-native-entry',
                drop_id: 'extra-native-drop'
              }
            ],
            Object.keys(original),
            ctx
          );
          const active = await sqlExecutor.oneOrNull<{ count: number }>(
            `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id and status in ('ACTIVE','WINNER')`,
            { id },
            options
          );
          expect(Number(active?.count)).toBe(1);
          // Retained content for the withdrawn entry must not satisfy the source
          // hash, even though the independent native count still equals one.
          const pages = new CompetitionMigrationContentRepository(
            () => sqlExecutor
          );
          expect((await pages.nativePage(id, [entryId], ctx)).size).toBe(0);
          const after = await compareMigrationContent(
            sqlExecutor,
            id,
            wave.id,
            ctx
          );
          expect(after[0].baselineHash).not.toBe(after[0].candidateHash);
        }
      );
    });

    it('compares complete content pages without mixing drops and reads the latest native version', async () => {
      const secondDropId = 'content-page-second';
      await seedSnapshotEntry(secondDropId, Date.now());
      for (const dropId of [drop.id, secondDropId])
        await seedRichEntryContent(dropId);
      const content = new CompetitionEntryRepository(() => sqlExecutor);
      const pages = new CompetitionMigrationContentRepository(
        () => sqlExecutor
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const drops = await sqlExecutor.execute<DropEntity>(
            `select * from ${DROPS_TABLE} where wave_id=:waveId order by id`,
            { waveId: wave.id },
            { wrappedConnection: connection }
          );
          const queries = jest.spyOn(sqlExecutor, 'execute');
          const source = await pages.sourcePage(drops, ctx);
          expect(queries).toHaveBeenCalledTimes(8);
          expect(
            queries.mock.calls.every(
              ([, , options]) => options?.wrappedConnection === connection
            )
          ).toBe(true);
          queries.mockRestore();
          for (const drop of drops)
            expect(source.get(drop.id)).toEqual(
              await content.loadDropContent(drop, ctx)
            );
          expect(source.get(secondDropId)?.metadata).toEqual([
            { data_key: 'z', data_value: secondDropId },
            { data_key: 'a', data_value: 'second' }
          ]);
          expect(source.get(drop.id)?.parts[1]).toMatchObject({
            content: drop.id,
            quoted_drop: { drop_id: 'quoted', drop_part_id: 1 },
            media: [
              {
                url: drop.id,
                mime_type: 'image/png',
                media_upload_id: 'upload'
              }
            ],
            attachments: [{ attachment_id: drop.id }]
          });
        }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      const entryId = legacyCompetitionEntryId(id, secondDropId);
      const entry = (await new CompetitionRepository().findNativeEntry(
        id,
        entryId,
        {}
      ))!;
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const comparison = await compareMigrationContent(
            sqlExecutor,
            id,
            wave.id,
            ctx
          );
          expect(comparison[0].baselineHash).toBe(comparison[0].candidateHash);
          const primaryKey = await sqlExecutor.execute<{ COLUMN_NAME: string }>(
            `select COLUMN_NAME from information_schema.KEY_COLUMN_USAGE where TABLE_SCHEMA=database() and TABLE_NAME=:table and CONSTRAINT_NAME='PRIMARY' order by ORDINAL_POSITION`,
            { table: COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE },
            { wrappedConnection: connection }
          );
          expect(primaryKey.map((column) => column.COLUMN_NAME)).toEqual([
            'entry_id',
            'version'
          ]);
          const original = (await content.getContent(entryId, ctx))!;
          await content.saveContent(
            entry,
            { ...original, title: 'later version' },
            'fixture-author',
            undefined,
            ctx
          );
          const native = await pages.nativePage(
            id,
            [entryId, legacyCompetitionEntryId(id, drop.id), 'missing'],
            ctx
          );
          expect(native.size).toBe(2);
          expect(native.get(entryId)).toEqual(
            await content.getContent(entryId, ctx)
          );
          expect(native.get(entryId)?.title).toBe('later version');
          const changed = await compareMigrationContent(
            sqlExecutor,
            id,
            wave.id,
            ctx
          );
          expect(changed[0].baselineHash).not.toBe(changed[0].candidateHash);
        }
      );
    });

    it('batches complete entry content and global ranks without creating duplicate versions', async () => {
      const secondDropId = 'batched-second-entry';
      await seedSnapshotEntry(secondDropId, Date.now());
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await sqlExecutor.execute(
        `delete from ${DROPS_PARTS_TABLE} where drop_id=:secondDropId`,
        { secondDropId }
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      while ((await service.status(id)).migration?.stage !== 'ENTRIES')
        await service.backfill(id, operator);
      const scalar = jest.spyOn(
        CompetitionEntryRepository.prototype,
        'loadDropContent'
      );
      const ranks = jest.spyOn(
        CompetitionRepository.prototype,
        'findLegacyEntriesByDropIds'
      );
      const source = jest.spyOn(
        CompetitionMigrationContentRepository.prototype,
        'sourcePage'
      );
      const native = jest.spyOn(
        CompetitionMigrationContentRepository.prototype,
        'nativePage'
      );
      const checkpoint = (await service.status(id)).migration;
      source.mockResolvedValueOnce(new Map());
      await expect(service.backfill(id, operator, 25)).rejects.toThrow(
        'migration entry content page is incomplete'
      );
      expect((await service.status(id)).migration).toEqual(checkpoint);
      expect(
        await sqlExecutor.execute(
          `select id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([]);
      source.mockClear();
      ranks.mockClear();
      native.mockClear();
      await service.backfill(id, operator, 25);
      expect(scalar).not.toHaveBeenCalled();
      expect(ranks).toHaveBeenCalledTimes(1);
      expect(source).toHaveBeenCalledTimes(1);
      expect(native).toHaveBeenCalledTimes(1);
      scalar.mockRestore();
      ranks.mockRestore();
      source.mockRestore();
      native.mockRestore();
      const emptyDrop = (await sqlExecutor.oneOrNull<DropEntity>(
        `select * from ${DROPS_TABLE} where id=:secondDropId`,
        { secondDropId }
      ))!;
      expect(
        await new CompetitionEntryRepository(() => sqlExecutor).getContent(
          legacyCompetitionEntryId(id, secondDropId),
          {}
        )
      ).toEqual(
        await new CompetitionEntryRepository(() => sqlExecutor).loadDropContent(
          emptyDrop,
          {}
        )
      );
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      const original = await sqlExecutor.execute(
        `select entry_id,version,content,created_at from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} order by entry_id,version`
      );
      for (let pass = 0; pass < 2; pass++) {
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            expect(
              await new CompetitionMigrationBackfill(sqlExecutor).batch(
                record,
                'ENTRIES',
                0,
                25,
                Date.now(),
                null,
                { connection }
              )
            ).toBe(0);
          }
        );
      }
      expect(
        await sqlExecutor.execute(
          `select entry_id,version,content,created_at from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} order by entry_id,version`
        )
      ).toEqual(original);
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('replays active parent deletion and all content cleanup with only a rank sweep', async () => {
      const secondDropId = 'surviving-deletion-entry';
      await seedSnapshotEntry(secondDropId, Date.now());
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await seedRichEntryContent(drop.id);
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          for (const table of [
            DROPS_PARTS_TABLE,
            DROP_MEDIA_TABLE,
            DROP_ATTACHMENTS_TABLE,
            DROP_METADATA_TABLE,
            DROP_REFERENCED_NFTS_TABLE,
            DROPS_MENTIONS_TABLE,
            DROP_MENTIONED_WAVES_TABLE,
            DROP_MENTIONED_GROUPS_TABLE
          ]) {
            await sqlExecutor.execute(
              `delete from ${table} where drop_id=:dropId`,
              { dropId: drop.id },
              { wrappedConnection: connection }
            );
          }
          await sqlExecutor.execute(
            `delete from ${DROPS_TABLE} where id=:dropId`,
            { dropId: drop.id },
            { wrappedConnection: connection }
          );
          for (const table of [
            DROP_VOTER_STATE_TABLE,
            DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
            DROP_RANK_TABLE,
            DROP_REAL_VOTE_IN_TIME_TABLE,
            DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
            WAVE_LEADERBOARD_ENTRIES_TABLE
          ]) {
            await sqlExecutor.execute(
              `delete from ${table} where drop_id=:dropId`,
              { dropId: drop.id },
              { wrappedConnection: connection }
            );
          }
        }
      );
      // One-row journal pages prove classification includes the earlier deletion.
      while ((await service.status(id)).migration?.state === 'SHADOWING')
        await service.catchUp(id, operator, 1);
      const checkpoint = (await service.status(id)).migration!;
      expect(checkpoint.stage).toBe('LEADERBOARD');
      expect(checkpoint.applied_watermark).toBe(0);
      expect(checkpoint.target_watermark).toBe(checkpoint.source_watermark);
      for (const table of [
        COMPETITION_ENTRIES_TABLE,
        COMPETITION_VOTES_TABLE,
        COMPETITION_ENTRY_RUNTIME_TABLE,
        COMPETITION_LEADERBOARD_ENTRIES_TABLE
      ]) {
        expect(
          await sqlExecutor.execute(
            `select * from ${table} where competition_id=:id and ${table === COMPETITION_ENTRIES_TABLE ? 'id' : 'entry_id'}=:entryId`,
            { id, entryId: legacyCompetitionEntryId(id, drop.id) }
          )
        ).toEqual([]);
      }
      // A new service resumes the saved sweep; no voter/archive recopy is needed.
      await finishBackfill(
        new CompetitionMigrationService(() => sqlExecutor, Date.now, 0)
      );
      expect((await service.status(id)).operations?.journalLag).toBe(0);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it.each([
      'surviving content',
      'winner deletion',
      'missing parent key',
      'journal gap',
      'parent outside window',
      'recreated parent'
    ])('retains the full refresh for %s', async (scenario) => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      if (scenario === 'winner deletion')
        await sqlExecutor.execute(
          `update ${DROPS_TABLE} set drop_type='WINNER' where id=:dropId`,
          { dropId: drop.id }
        );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `delete from ${DROPS_PARTS_TABLE} where drop_id=:dropId`,
        { dropId: drop.id }
      );
      if (scenario !== 'surviving content')
        await sqlExecutor.execute(
          `delete from ${DROPS_TABLE} where id=:dropId`,
          { dropId: drop.id }
        );
      if (scenario === 'recreated parent')
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview) values (:dropId,:waveId,'fixture-author',10,1,'PARTICIPATORY',0)`,
          { dropId: drop.id, waveId: wave.id }
        );
      const status = (await service.status(id)).migration!;
      if (scenario === 'missing parent key')
        await sqlExecutor.execute(
          `update ${COMPETITION_MIGRATION_CHANGES_TABLE} set before_row=json_remove(before_row,'$.id') where competition_id=:id and source_table=:table`,
          { id, table: DROPS_TABLE }
        );
      if (scenario === 'journal gap')
        await sqlExecutor.execute(
          `delete from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id and watermark=1`,
          { id }
        );
      let targetWatermark = status.source_watermark;
      if (scenario === 'parent outside window') targetWatermark = 1;
      else if (scenario === 'recreated parent') targetWatermark--;
      expect(
        await new CompetitionMigrationRepository().canRefreshOnlyLeaderboard(
          id,
          0,
          targetWatermark,
          {}
        )
      ).toBe(false);
    });

    it.each(['backfill', 'catch-up'])(
      'releases a slow %s batch fence and preserves its checkpoint',
      async (operation) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        if (operation === 'catch-up') {
          await finishBackfill(service);
          await moveLiveEntryVote(drop.id, 8, 1);
        }
        const checkpoint = (await service.status(id)).migration!;
        const method = operation === 'backfill' ? 'batch' : 'applyChange';
        const slow = jest
          .spyOn(CompetitionMigrationBackfill.prototype, method)
          .mockImplementationOnce(async (...args: unknown[]) => {
            const ctx = args[args.length - 1] as {
              connection: NonNullable<
                Parameters<
                  CompetitionMigrationBackfill['applyChange']
                >[2]['connection']
              >;
            };
            await sqlExecutor.execute(
              'SELECT SLEEP(2)',
              {},
              { wrappedConnection: ctx.connection }
            );
            return 0 as never;
          });
        const started = performance.now();
        await expect(
          operation === 'backfill'
            ? service.backfill(id, operator)
            : service.catchUp(id, operator)
        ).rejects.toBeInstanceOf(SqlExecutionBudgetExceededError);
        expect(performance.now() - started).toBeLessThan(5000);
        slow.mockRestore();
        expect((await service.status(id)).migration).toEqual(checkpoint);
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            expect(
              await new CompetitionRepository().lockLegacyExecutionOwner(
                wave.id,
                { connection }
              )
            ).toMatchObject({
              storage_mode: 'LEGACY_ADAPTER',
              execution_mode: 'ACTIVE'
            });
          }
        );
      }
    );

    it.each(['BACKFILLING', 'SHADOWING'])(
      'honors an operator stop inside the locked %s transaction, including no-op batches',
      async (state) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        if (state === 'SHADOWING') await finishBackfill(service);
        await service.recordException(id, operator, 'TEST_STOP');
        const before = (await service.status(id)).migration;
        await expect(service.backfill(id, operator)).rejects.toThrow(
          'Migration requires adapter review'
        );
        if (state === 'SHADOWING')
          await expect(service.catchUp(id, operator)).rejects.toThrow(
            'Migration requires adapter review'
          );
        expect((await service.status(id)).migration).toEqual(before);
      }
    );

    it('catches repeated leaderboard refreshes without recopying voter and historical stages', async () => {
      const now = Date.now();
      const secondDropId = 'snapshot-only-second-drop';
      await seedSnapshotEntry(secondDropId, now);
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set participation_period_end=null,voting_period_end=null,next_decision_time=:next,time_lock_ms=86400000 where id=:waveId`,
        { waveId: wave.id, next: now + 86400000 }
      );
      await sqlExecutor.execute(
        `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time) values (:dropId,:waveId,:now,7,7)`,
        { dropId: drop.id, waveId: wave.id, now }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      await finishBackfill(service);
      const votesBefore = await sqlExecutor.execute(
        `select entry_id,voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id order by entry_id,voter_profile_id`,
        { id }
      );
      for (let refresh = 1; refresh <= 3; refresh++) {
        const rating = refresh % 2 === 1 ? 5 : 7;
        await sqlExecutor.execute(
          `update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set timestamp=:timestamp,vote=:rating where drop_id=:dropId`,
          { dropId: drop.id, timestamp: now + refresh, rating }
        );
        await service.catchUp(id, operator, 1);
        const migration = (await service.status(id)).migration;
        expect(migration).toMatchObject({
          stage: 'LEADERBOARD',
          stage_offset: 0,
          stage_cursor: null
        });
        expect(migration?.completed_stages).toEqual(
          expect.arrayContaining([
            'ENTRIES',
            'VOTERS',
            'HISTORY',
            'ARCHIVE_VOTERS'
          ])
        );
        await finishBackfill(service);
        expect(
          await sqlExecutor.execute(
            `select drop_id,rating,\`rank\` from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id order by \`rank\``,
            { id }
          )
        ).toEqual(
          rating < 6
            ? [
                { drop_id: secondDropId, rating: 6, rank: 1 },
                { drop_id: drop.id, rating, rank: 2 }
              ]
            : [
                { drop_id: drop.id, rating, rank: 1 },
                { drop_id: secondDropId, rating: 6, rank: 2 }
              ]
        );
        expect(
          await sqlExecutor.execute(
            `select entry_id,voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id order by entry_id,voter_profile_id`,
            { id }
          )
        ).toEqual(votesBefore);
      }
      expect((await service.status(id)).operations?.journalLag).toBe(0);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it('refreshes live entry ranks when votes move behind an unchanged locked leaderboard', async () => {
      const now = Date.now();
      const secondDropId = 'live-entry-rank-second-drop';
      await seedSnapshotEntry(secondDropId, now);
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set participation_period_end=null,voting_period_end=null,next_decision_time=:next,time_lock_ms=86400000 where id=:waveId`,
        { waveId: wave.id, next: now + 86400000 }
      );
      await sqlExecutor.execute(
        `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time) values (:dropId,:waveId,:now,7,7)`,
        { dropId: drop.id, waveId: wave.id, now }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      await finishBackfill(service);
      await moveLiveEntryVote(secondDropId, 8, 2);
      for (let page = 0; page < 5; page++) {
        await service.catchUp(id, operator, 1);
      }
      expect((await service.status(id)).migration).toMatchObject({
        stage: 'LEADERBOARD',
        stage_offset: 0,
        stage_cursor: null,
        completed_stages: expect.arrayContaining([
          'ENTRIES',
          'VOTERS',
          'HISTORY',
          'ARCHIVE_VOTERS'
        ])
      });
      const scheduled = (await service.status(id)).migration!;
      await service.backfill(id, operator, 1);
      const partial = await service.status(id);
      expect(partial).toMatchObject({
        storageMode: 'LEGACY_ADAPTER',
        executionMode: 'ACTIVE',
        migration: {
          state: 'BACKFILLING',
          stage: 'LEADERBOARD',
          applied_watermark: scheduled.applied_watermark,
          target_watermark: scheduled.target_watermark
        }
      });
      expect(partial.migration!.target_watermark).toBeGreaterThan(
        partial.migration!.applied_watermark
      );
      // One of two one-row pages has committed. This incomplete native
      // projection is quarantined while the public reader still uses legacy.
      expect(
        await sqlExecutor.execute(
          `select \`rank\` from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id order by drop_id`,
          { id }
        )
      ).toEqual([{ rank: 2 }, { rank: 2 }]);
      jest
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      const publicPage = await competitionService.listEntries(
        wave.id,
        id,
        { limit: 10, direction: 'ASC', sort: 'rank' },
        {},
        {}
      );
      expect(
        publicPage.data.map(({ drop_id, rank }) => ({ drop_id, rank }))
      ).toEqual([
        { drop_id: secondDropId, rank: 1 },
        { drop_id: drop.id, rank: 2 }
      ]);
      await expect(service.compare(id, operator, 1)).rejects.toThrow(
        'Complete backfill before independent comparison'
      );
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: false
      });
      await finishBackfill(service);
      const rows = await sqlExecutor.execute<{ drop_id: string; rank: number }>(
        `select drop_id,\`rank\` from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id`,
        { id }
      );
      expect(
        Object.fromEntries(rows.map((row) => [row.drop_id, row.rank]))
      ).toEqual({
        [drop.id]: 2,
        [secondDropId]: 1
      });
      expect(
        await sqlExecutor.execute(
          `select drop_id,rating,\`rank\` from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id order by \`rank\``,
          { id }
        )
      ).toEqual([
        { drop_id: drop.id, rating: 7, rank: 1 },
        { drop_id: secondDropId, rating: 6, rank: 2 }
      ]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it('refreshes winner-only pages and keeps live ranks global and numeric', async () => {
      const now = Date.now();
      const secondDropId = 'rank-second-entry';
      const thirdDropId = 'rank-third-entry';
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=1000 where profile_id='fixture-voter'`
      );
      await seedSnapshotEntry(secondDropId, now);
      await seedSnapshotEntry(thirdDropId, now, 100);
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set participation_period_end=null,voting_period_end=null,next_decision_time=:next,time_lock_ms=86400000 where id=:waveId`,
        { waveId: wave.id, next: now + 86400000 }
      );
      await sqlExecutor.execute(
        `update ${DROPS_TABLE} set drop_type='WINNER' where id=:dropId`,
        { dropId: drop.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values (:waveId,100)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values (:waveId,100,:dropId,4,7,'[]')`,
        { waveId: wave.id, dropId: drop.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      await finishBackfill(service);
      await moveLiveEntryVote(secondDropId, -12, 6);
      for (let page = 0; page < 5; page++)
        await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect(
        await sqlExecutor.execute(
          `select drop_id,\`rank\` from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id order by drop_id`,
          { id }
        )
      ).toEqual([
        { drop_id: drop.id, rank: 4 },
        { drop_id: secondDropId, rank: 3 },
        { drop_id: thirdDropId, rank: 1 }
      ]);
      expect(
        await sqlExecutor.execute(
          `select drop_id,\`rank\` from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id order by \`rank\``,
          { id }
        )
      ).toEqual([
        { drop_id: thirdDropId, rank: 1 },
        { drop_id: secondDropId, rank: 2 }
      ]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it.each([
      {
        source: 'configuration',
        sql: `update ${WAVES_TABLE} set name='Reviewed changed configuration' where id=:waveId`
      },
      {
        source: 'content',
        sql: `update ${DROPS_PARTS_TABLE} set content='Reviewed changed content' where drop_id=:dropId`
      }
    ])(
      'retains the full refresh when an earlier journal page changes $source',
      async ({ sql }) => {
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          Date.now,
          0
        );
        await sqlExecutor.execute(
          `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time) values (:dropId,:waveId,10,7,7)`,
          { dropId: drop.id, waveId: wave.id }
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        await sqlExecutor.execute(sql, { waveId: wave.id, dropId: drop.id });
        await sqlExecutor.execute(
          `update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set timestamp=11 where drop_id=:dropId`,
          { dropId: drop.id }
        );
        await service.catchUp(id, operator, 1);
        expect((await service.status(id)).migration).toMatchObject({
          state: 'SHADOWING',
          applied_watermark: 0,
          target_watermark: 1,
          source_watermark: 2
        });
        await service.catchUp(id, operator, 1);
        expect((await service.status(id)).migration?.stage).toBe('ENTRIES');
        await finishBackfill(service);
        expect((await service.status(id)).operations?.journalLag).toBe(0);
        expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      }
    );

    it('keeps votes arriving during leaderboard refresh unacknowledged until their own refresh commits', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time) values (:dropId,:waveId,10,7,7)`,
        { dropId: drop.id, waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set timestamp=11 where drop_id=:dropId`,
        { dropId: drop.id }
      );
      await service.catchUp(id, operator, 1);
      expect((await service.status(id)).migration).toMatchObject({
        stage: 'LEADERBOARD',
        target_watermark: 1,
        applied_watermark: 0
      });
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const params = { dropId: drop.id, waveId: wave.id };
          const options = { wrappedConnection: connection };
          for (const sql of [
            `update ${DROP_VOTER_STATE_TABLE} set votes=9 where drop_id=:dropId`,
            `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (voter_id,drop_id,wave_id,credit_spent,created_at) values ('fixture-voter',:dropId,:waveId,2,20)`,
            `update ${DROP_RANK_TABLE} set vote=9,last_increased=20 where drop_id=:dropId`,
            `insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (wave_id,drop_id,timestamp,vote) values (:waveId,:dropId,20,9)`,
            `insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (wave_id,drop_id,voter_id,timestamp,vote) values (:waveId,:dropId,'fixture-voter',20,9)`,
            `update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set timestamp=20,vote=9,vote_on_decision_time=9 where drop_id=:dropId`
          ]) {
            await sqlExecutor.execute(sql, params, options);
          }
        }
      );
      await service.backfill(id, operator, 1);
      expect((await service.status(id)).migration?.applied_watermark).toBe(0);
      await finishBackfill(service);
      expect((await service.status(id)).migration).toMatchObject({
        source_watermark: 7,
        target_watermark: 1,
        applied_watermark: 1
      });
      expect((await service.readiness(id)).failures).toContain('CATCH_UP_LAG');
      expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      for (let page = 0; page < 6; page++) {
        await service.catchUp(id, operator, 1);
      }
      expect((await service.status(id)).migration).toMatchObject({
        state: 'BACKFILLING',
        stage: 'LEADERBOARD',
        target_watermark: 7,
        applied_watermark: 1
      });
      await finishBackfill(service);
      expect((await service.status(id)).operations?.journalLag).toBe(0);
      expect(
        await sqlExecutor.execute(
          `select value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ value: 9, credit_spent: 9 }]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });
  }
);
