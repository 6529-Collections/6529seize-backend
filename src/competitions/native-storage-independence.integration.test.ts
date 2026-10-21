import { NotFoundException } from '@/exceptions';
import { competitionService } from './competition.service';
import { transferRetainedCompetitionDistributions } from './competition-retirement-distributions';
import { transferRetainedCompetitionLeaderboardPublication } from './competition-retirement-leaderboard';
import { DropVotingDb } from '@/api/drops/drop-voting.db';
import {
  legacyCompetitionOutcomeId,
  legacyCompetitionDistributionItemId
} from './competition-id';
import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
import * as tables from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import { CompetitionRepository } from './competition.repository';
import { NativeCompetitionReader } from './native-competition.reader';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { CompetitionExecutionRouter } from './competition-execution.router';
import {
  LEGACY_GET_SOURCE_TABLES,
  RETIRED_WAVE_COMPETITION_COLUMNS,
  installLegacyCompetitionGetFacade,
  legacyGetView
} from './legacy-competition-get-facade';
import { CompetitionVoteActivityRepository } from './competition-vote-activity.repository';

const obsoleteTables = [
  tables.DROP_VOTER_STATE_TABLE,
  tables.DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  tables.DROP_RANK_TABLE,
  tables.DROP_REAL_VOTE_IN_TIME_TABLE,
  tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  tables.WINNER_DROP_VOTER_VOTES_TABLE,
  tables.WAVE_LEADERBOARD_ENTRIES_TABLE,
  tables.WAVES_DECISIONS_TABLE,
  tables.WAVES_DECISION_WINNER_DROPS_TABLE,
  tables.WAVE_OUTCOMES_TABLE,
  tables.WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  tables.WAVES_DECISION_PAUSES_TABLE,
  tables.WAVE_VOTING_CREDIT_NFTS_TABLE,
  tables.WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE,
  tables.COMPETITION_MIGRATIONS_TABLE,
  tables.COMPETITION_MIGRATION_CHANGES_TABLE,
  tables.COMPETITION_MIGRATION_AUDIT_TABLE,
  tables.COMPETITION_MIGRATION_ENVIRONMENTS_TABLE,
  tables.COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
  tables.COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE
];

// Physical absence is exercised ONLY in the isolated, automatically discarded
// MySQL test database. Staging deliberately retains every physical object.
describe('application and permanent projections without obsolete competition storage', () => {
  beforeEach(async () => {
    if (
      process.env.NODE_ENV !== 'local' ||
      !process.env.DB_NAME?.includes('_jest_worker_')
    ) {
      throw new Error(
        'Physical-absence acceptance requires a disposable Jest database'
      );
    }
    await resetTestDatabase();
  });
  afterEach(async () => {
    const schema = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
      timezone: 'Etc/UTC',
      entities: Object.values(Entities).filter(
        (entity) => typeof entity === 'function'
      ),
      synchronize: false
    });
    await schema.initialize();
    try {
      await schema.synchronize();
    } finally {
      await schema.destroy();
    }
    await installLegacyCompetitionGetFacade(sqlExecutor);
    await resetTestDatabase();
  });

  it('keeps frozen ownership, native votes/history/snapshots, shared activity and repeatable decisions', async () => {
    const wave = aWave(
      {
        type: WaveType.RANK,
        created_by: 'artist',
        participation_period_start: 0,
        voting_period_start: 0,
        time_lock_ms: 100,
        next_decision_time: 1000,
        decisions_strategy: {
          first_decision_time: 1000,
          subsequent_decisions: [],
          is_rolling: false
        }
      },
      { id: 'independence-hub', name: 'Retained original', serial_no: 1 }
    );
    const shared = Object.fromEntries(
      Object.entries(wave).filter(
        ([column]) => !RETIRED_WAVE_COMPETITION_COLUMNS.includes(column)
      )
    );
    await sqlExecutor.bulkInsert(
      tables.WAVES_TABLE,
      [shared],
      Object.keys(shared)
    );
    const directMessage = aWave(
      {
        type: WaveType.CHAT,
        is_direct_message: true,
        visibility_group_id: 'dm-members',
        chat_group_id: 'dm-members',
        admin_group_id: 'dm-members',
        participation_group_id: 'dm-members'
      },
      { id: 'independence-dm', name: 'Direct message', serial_no: 2 }
    );
    const sharedDirectMessage = Object.fromEntries(
      Object.entries(directMessage).filter(
        ([column]) => !RETIRED_WAVE_COMPETITION_COLUMNS.includes(column)
      )
    );
    await sqlExecutor.bulkInsert(
      tables.WAVES_TABLE,
      [sharedDirectMessage],
      Object.keys(sharedDirectMessage)
    );
    expect(
      await sqlExecutor.oneOrNull(
        `select participation_group_id from ${legacyGetView(tables.WAVES_TABLE)} where id=:id`,
        { id: directMessage.id }
      )
    ).toEqual({ participation_group_id: 'dm-members' });
    await sqlExecutor.bulkInsert(
      tables.DROPS_TABLE,
      [
        {
          id: 'shared-orphan-participation',
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 1,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        },
        {
          id: 'shared-orphan-winner',
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 1,
          parts_count: 1,
          drop_type: 'WINNER'
        },
        {
          id: 'shared-sibling-body',
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 1,
          parts_count: 1,
          drop_type: 'COMPETITION'
        }
      ],
      ['id', 'wave_id', 'author_id', 'created_at', 'parts_count', 'drop_type']
    );
    expect(
      await sqlExecutor.execute(
        `select id,drop_type from ${legacyGetView(tables.DROPS_TABLE)} where id in ('shared-orphan-participation','shared-orphan-winner','shared-sibling-body') order by id`
      )
    ).toEqual([
      { id: 'shared-orphan-participation', drop_type: 'PARTICIPATORY' },
      { id: 'shared-orphan-winner', drop_type: 'WINNER' },
      { id: 'shared-sibling-body', drop_type: 'CHAT' }
    ]);
    const primary = await seedNativeOriginalPrimaryFixture(wave);
    await sqlExecutor.execute(
      `update ${tables.COMPETITIONS_TABLE} set outcome_config=:outcomes where id=:id`,
      {
        id: primary.id,
        outcomes: JSON.stringify([
          { type: 'MANUAL', description: 'Winner', amount: 1 }
        ])
      }
    );
    const canonicalOutcomeId = legacyCompetitionOutcomeId(primary.id, 1);
    const orphanOutcomeId = legacyCompetitionOutcomeId(primary.id, 42);
    await sqlExecutor.execute(
      `INSERT INTO ${tables.COMPETITION_OUTCOMES_TABLE} (id,competition_id,position,legacy_index,type,description,created_at)
       VALUES (:id,:competitionId,1,1,'MANUAL','Canonical winner definition',0)`,
      { id: canonicalOutcomeId, competitionId: primary.id }
    );
    await sqlExecutor.bulkInsert(
      tables.WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      [
        {
          wave_id: wave.id,
          wave_outcome_position: 1,
          wave_outcome_distribution_item_position: 1,
          amount: 999,
          description: 'stale canonical source'
        },
        {
          wave_id: wave.id,
          wave_outcome_position: 42,
          wave_outcome_distribution_item_position: 2,
          amount: null,
          description: null
        }
      ],
      [
        'wave_id',
        'wave_outcome_position',
        'wave_outcome_distribution_item_position',
        'amount',
        'description'
      ]
    );
    const siblingId = '70000000-0000-4000-8000-000000000001';
    const competitionColumns = Object.keys(primary);
    await sqlExecutor.execute(
      `INSERT INTO ${tables.COMPETITIONS_TABLE} (${competitionColumns.map((column) => '`' + column + '`').join(',')})
       SELECT ${competitionColumns.map((column) => (column === 'id' ? ':siblingId' : column === 'legacy_wave_id' ? 'NULL' : '`' + column + '`')).join(',')}
       FROM ${tables.COMPETITIONS_TABLE} WHERE id=:id`,
      { id: primary.id, siblingId }
    );
    await sqlExecutor.bulkInsert(
      tables.COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      [
        {
          id: legacyCompetitionDistributionItemId(canonicalOutcomeId, 1),
          competition_id: primary.id,
          outcome_id: canonicalOutcomeId,
          outcome_position: null,
          position: 1,
          amount: 1,
          description: 'Canonical native child'
        },
        {
          id: legacyCompetitionDistributionItemId(
            legacyCompetitionOutcomeId(siblingId, 42),
            99
          ),
          competition_id: siblingId,
          outcome_id: legacyCompetitionOutcomeId(siblingId, 42),
          outcome_position: 42,
          position: 99,
          amount: 777,
          description: 'Sibling hidden'
        }
      ],
      [
        'id',
        'competition_id',
        'outcome_id',
        'outcome_position',
        'position',
        'amount',
        'description'
      ]
    );
    expect(
      await transferRetainedCompetitionDistributions(
        sqlExecutor,
        undefined,
        {},
        { batchSize: 1 }
      )
    ).toEqual([{ competition_id: primary.id, rows: 1 }]);
    const expectedDistribution = [
      {
        wave_outcome_position: 1,
        wave_outcome_distribution_item_position: 1,
        amount: 1,
        description: 'Canonical native child'
      },
      {
        wave_outcome_position: 42,
        wave_outcome_distribution_item_position: 2,
        amount: null,
        description: null
      }
    ];
    const retainedDistribution = () =>
      sqlExecutor.execute(
        `SELECT wave_outcome_position,wave_outcome_distribution_item_position,amount,description FROM ${legacyGetView(tables.WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE)}
       WHERE wave_id=:waveId ORDER BY wave_outcome_position,wave_outcome_distribution_item_position`,
        { waveId: wave.id }
      );
    expect(await retainedDistribution()).toEqual(expectedDistribution);
    await sqlExecutor.execute(
      `INSERT INTO ${tables.WAVE_LEADERBOARD_ENTRIES_TABLE}
      (drop_id,wave_id,timestamp,vote,vote_on_decision_time,over_threshold_since_ms)
      VALUES ('shared-orphan-participation',:waveId,10,40,90,5)`,
      { waveId: wave.id }
    );
    await transferRetainedCompetitionLeaderboardPublication(
      sqlExecutor,
      primary.id,
      {},
      { batchSize: 1 }
    );
    const retainedOrphanRates = () =>
      new DropVotingDb(() => sqlExecutor).getWeightedDropRates(
        ['shared-orphan-participation'],
        {}
      );
    expect(await retainedOrphanRates()).toEqual({
      'shared-orphan-participation': { current: 40, prediction: 90 }
    });
    const retainedOrphanSnapshot = () =>
      sqlExecutor.execute(
        `SELECT drop_id,rating,decision_rating,ordering_time,published_at,over_threshold_since
      FROM ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} WHERE competition_id=:id AND drop_id='shared-orphan-participation'`,
        { id: primary.id }
      );
    const orphanSnapshotBefore = await retainedOrphanSnapshot();
    expect(orphanSnapshotBefore).toEqual([
      {
        drop_id: 'shared-orphan-participation',
        rating: 40,
        decision_rating: 90,
        ordering_time: 10,
        published_at: 10,
        over_threshold_since: 5
      }
    ]);
    const entryId = '30000000-0000-4000-8000-000000000001';
    const nativeRepository = new NativeCompetitionRuntimeRepository(
      () => sqlExecutor
    );
    const repository = new CompetitionRepository(() => sqlExecutor);
    await sqlExecutor.bulkInsert(
      tables.DROPS_TABLE,
      [
        {
          id: 'independence-entry',
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 1,
          parts_count: 1,
          drop_type: 'PARTICIPATORY'
        }
      ],
      ['id', 'wave_id', 'author_id', 'created_at', 'parts_count', 'drop_type']
    );
    await sqlExecutor.bulkInsert(
      tables.COMPETITION_ENTRIES_TABLE,
      [
        {
          id: entryId,
          competition_id: primary.id,
          wave_id: wave.id,
          drop_id: 'independence-entry',
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ],
      [
        'id',
        'competition_id',
        'wave_id',
        'drop_id',
        'submitter_id',
        'status',
        'config_version',
        'submitted_at'
      ]
    );
    await nativeRepository.executeNativeQueriesInTransaction(
      async (connection) => {
        await nativeRepository.lockCompetition(primary.id, { connection });
        await nativeRepository.enqueueEvent(
          {
            key: 'started',
            event_type: 'COMPETITION_STARTED',
            wave_id: wave.id,
            competition_id: primary.id,
            occurred_at: 0,
            data: {}
          },
          { connection }
        );
      }
    );
    await sqlExecutor.execute(
      `update ${tables.COMPETITION_OUTBOX_TABLE} set delivered_at=1`
    );
    await installLegacyCompetitionGetFacade(sqlExecutor);
    const snapshots = new Map<string, unknown>();
    for (const table of LEGACY_GET_SOURCE_TABLES)
      snapshots.set(
        table,
        await sqlExecutor.execute(`select * from \`${legacyGetView(table)}\``)
      );

    for (const table of obsoleteTables)
      await sqlExecutor.execute(`drop table \`${table}\``);
    for (const table of [tables.WAVES_TABLE, tables.WAVES_ARCHIVE_TABLE]) {
      for (const column of RETIRED_WAVE_COMPETITION_COLUMNS.filter(
        (column) =>
          table !== tables.WAVES_ARCHIVE_TABLE ||
          column !== 'next_decision_time'
      )) {
        await sqlExecutor.execute(
          `alter table \`${table}\` drop column \`${column}\``
        );
      }
    }
    await installLegacyCompetitionGetFacade(sqlExecutor);
    for (const table of LEGACY_GET_SOURCE_TABLES)
      expect(
        await sqlExecutor.execute(`select * from \`${legacyGetView(table)}\``)
      ).toEqual(snapshots.get(table));
    expect(await retainedDistribution()).toEqual(expectedDistribution);
    expect(await retainedOrphanRates()).toEqual({
      'shared-orphan-participation': { current: 40, prediction: 90 }
    });
    expect(await retainedOrphanSnapshot()).toEqual(orphanSnapshotBefore);
    expect(
      await sqlExecutor.execute(
        `SELECT id FROM ${tables.COMPETITION_OUTCOMES_TABLE} WHERE competition_id=:id`,
        { id: primary.id }
      )
    ).toEqual([{ id: canonicalOutcomeId }]);
    await expect(
      competitionService.listDistribution(
        wave.id,
        primary.id,
        orphanOutcomeId,
        { limit: 10, direction: 'ASC' },
        {}
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    const record = await repository.findCompetitionRecordById(primary.id, {});
    expect(record).not.toBeNull();
    const competition = await new NativeCompetitionReader(
      repository,
      {}
    ).getCompetition(record!, 20);
    expect(competition.title).toBe(wave.name);
    await nativeRepository.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx = { connection };
        await nativeRepository.lockCompetition(primary.id, ctx);
        await sqlExecutor.execute(
          `insert into ${tables.COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (:id,:competitionId,:entryId,'voter',7,7,20,20)`,
          {
            id: '40000000-0000-4000-8000-000000000001',
            competitionId: primary.id,
            entryId
          },
          { wrappedConnection: connection }
        );
        await nativeRepository.recordVoteChange(
          {
            competitionId: primary.id,
            entryId,
            voterProfileId: 'voter',
            previousVote: 0,
            value: 7,
            occurredAt: 20,
            proxyId: 'proxy'
          },
          ctx
        );
      }
    );
    expect(await nativeRepository.listHistory(primary.id, {})).toHaveLength(2);
    expect(
      await new CompetitionVoteActivityRepository(() => sqlExecutor).list(
        primary.id,
        0,
        10,
        {}
      )
    ).toHaveLength(1);
    expect(
      await sqlExecutor.execute(
        `select votes from \`${legacyGetView(tables.DROP_VOTER_STATE_TABLE)}\``
      )
    ).toEqual([{ votes: 7 }]);
    const budget = {
      competition_id: primary.id,
      profile_id: 'voter',
      entry_id: null,
      credit_type: 'TDH',
      credit_scope: 'WAVE',
      available: 100,
      spent: 7,
      remaining: 93,
      current_vote: null,
      min_vote: null,
      max_vote: null
    };
    const runtime = new NativeCompetitionRuntimeService(
      nativeRepository,
      {
        getBudget: async () => budget,
        getWaveBudgets: async () => new Map([['voter', budget]])
      },
      new CompetitionExecutionRouter()
    );
    await runtime.processCompetition(primary.id, 1001);
    expect(await retainedOrphanSnapshot()).toEqual(orphanSnapshotBefore);
    expect(await retainedOrphanRates()).toEqual({
      'shared-orphan-participation': { current: 40, prediction: 90 }
    });
    expect(
      await sqlExecutor.execute(
        `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE} WHERE competition_id=:id AND drop_id='shared-orphan-participation'`,
        { id: primary.id }
      )
    ).toEqual([]);
    const decisions = await sqlExecutor.execute(
      `select * from ${tables.COMPETITION_DECISIONS_TABLE}`
    );
    const events = await sqlExecutor.execute(
      `select id,delivered_at from ${tables.COMPETITION_OUTBOX_TABLE} order by id`
    );
    expect(decisions).toHaveLength(1);
    await runtime.processCompetition(primary.id, 1001);
    expect(
      await sqlExecutor.execute(
        `select * from ${tables.COMPETITION_DECISIONS_TABLE}`
      )
    ).toEqual(decisions);
    expect(
      await sqlExecutor.execute(
        `select id,delivered_at from ${tables.COMPETITION_OUTBOX_TABLE} order by id`
      )
    ).toEqual(events);
    expect(
      await sqlExecutor.execute(
        `select drop_type from \`${legacyGetView(tables.DROPS_TABLE)}\` where id='independence-entry'`
      )
    ).toEqual([{ drop_type: 'WINNER' }]);
  });
});
