import { NotFoundException } from '@/exceptions';
import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import {
  legacyCompetitionId,
  legacyCompetitionOutcomeId,
  legacyCompetitionDistributionItemId
} from './competition-id';
import { transferRetainedCompetitionDistributions } from './competition-retirement-distributions';
import { legacyGetView } from './legacy-competition-get-facade';
import { CompetitionRepository } from './competition.repository';
import { competitionService } from './competition.service';

const wave = aWave(
  { type: WaveType.RANK },
  {
    id: 'retained-distribution-wave',
    name: 'Retained distributions',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const canonical = legacyCompetitionOutcomeId(id, 1);
const orphan = legacyCompetitionOutcomeId(id, 4);
const sibling = '60000000-0000-4000-8000-000000000001';
const source = [
  {
    wave_outcome_position: 1,
    wave_outcome_distribution_item_position: 1,
    amount: 999,
    description: 'stale physical canonical child'
  },
  {
    wave_outcome_position: 4,
    wave_outcome_distribution_item_position: 2,
    amount: null,
    description: null
  },
  {
    wave_outcome_position: 4,
    wave_outcome_distribution_item_position: 3,
    amount: -11,
    description: ''
  },
  {
    wave_outcome_position: 7,
    wave_outcome_distribution_item_position: 1,
    amount: 0,
    description: 'retained orphan'
  }
];

describeWithSeed(
  'retained parentless original distribution items',
  [
    withWaves([wave]),
    {
      table: WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      rows: [
        ...source.map((row) => ({ ...row, wave_id: wave.id })),
        {
          wave_id: 'deleted-source-wave',
          wave_outcome_position: 4,
          wave_outcome_distribution_item_position: 1,
          amount: 77,
          description: 'not enrolled'
        }
      ]
    },
    {
      table: COMPETITION_OUTCOMES_TABLE,
      rows: [
        {
          id: canonical,
          competition_id: id,
          position: 1,
          legacy_index: 1,
          type: 'MANUAL',
          description: 'Canonical native outcome',
          created_at: 0
        }
      ]
    },
    {
      table: COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      rows: [
        {
          id: legacyCompetitionDistributionItemId(canonical, 1),
          competition_id: id,
          outcome_id: canonical,
          position: 1,
          amount: 11,
          description: 'canonical native child'
        },
        {
          id: legacyCompetitionDistributionItemId(
            legacyCompetitionOutcomeId(sibling, 4),
            88
          ),
          competition_id: sibling,
          outcome_id: legacyCompetitionOutcomeId(sibling, 4),
          outcome_position: 4,
          position: 88,
          amount: 888,
          description: 'sibling must not leak'
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      const columns = Object.keys(primary);
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITIONS_TABLE} (${columns.map((column) => '`' + column + '`').join(',')})
       SELECT ${columns.map((column) => (column === 'id' ? ':sibling' : column === 'legacy_wave_id' ? 'NULL' : '`' + column + '`')).join(',')}
       FROM ${COMPETITIONS_TABLE} WHERE id=:id`,
        { id, sibling }
      );
    });

    it('copies only exposed orphan children in bounded committed pages and preserves exact native ownership, nulls and identities on rerun', async () => {
      const sourceSnapshot = await sqlExecutor.execute(
        `SELECT * FROM ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} ORDER BY wave_id,wave_outcome_position,wave_outcome_distribution_item_position`
      );
      const batches: { rows: number }[] = [];
      expect(
        await transferRetainedCompetitionDistributions(
          sqlExecutor,
          undefined,
          {},
          {
            batchSize: 1,
            onBatch: async (progress) => {
              batches.push(progress);
              await sqlExecutor.executeNativeQueriesInTransaction(
                async (connection) => {
                  expect(
                    await sqlExecutor.execute(
                      `SELECT id FROM ${COMPETITIONS_TABLE} WHERE id=:id FOR UPDATE NOWAIT`,
                      { id },
                      { wrappedConnection: connection }
                    )
                  ).toEqual([{ id }]);
                }
              );
            }
          }
        )
      ).toEqual([{ competition_id: id, rows: 3 }]);
      expect(batches).toHaveLength(3);
      expect(batches.every((batch) => batch.rows === 1)).toBe(true);
      const retained = await sqlExecutor.execute(
        `SELECT id,outcome_id,outcome_position,position,amount,description FROM ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} WHERE competition_id=:id ORDER BY outcome_id,position`,
        { id }
      );
      expect(retained).toEqual(
        expect.arrayContaining([
          {
            id: legacyCompetitionDistributionItemId(orphan, 2),
            outcome_id: orphan,
            outcome_position: 4,
            position: 2,
            amount: null,
            description: null
          },
          {
            id: legacyCompetitionDistributionItemId(orphan, 3),
            outcome_id: orphan,
            outcome_position: 4,
            position: 3,
            amount: -11,
            description: ''
          },
          {
            id: legacyCompetitionDistributionItemId(canonical, 1),
            outcome_id: canonical,
            outcome_position: null,
            position: 1,
            amount: 11,
            description: 'canonical native child'
          }
        ])
      );
      expect(retained).toHaveLength(4);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITION_OUTCOMES_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toEqual([{ id: canonical }]);
      expect(
        await sqlExecutor.execute(
          `SELECT wave_outcome_position,wave_outcome_distribution_item_position,amount,description FROM ${legacyGetView(WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE)} WHERE wave_id=:waveId ORDER BY wave_outcome_position,wave_outcome_distribution_item_position`,
          { waveId: wave.id }
        )
      ).toEqual([
        {
          wave_outcome_position: 1,
          wave_outcome_distribution_item_position: 1,
          amount: 11,
          description: 'canonical native child'
        },
        ...source.slice(1)
      ]);
      await transferRetainedCompetitionDistributions(
        sqlExecutor,
        id,
        {},
        { batchSize: 1 }
      );
      expect(
        await sqlExecutor.execute(
          `SELECT id,outcome_id,outcome_position,position,amount,description FROM ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} WHERE competition_id=:id ORDER BY outcome_id,position`,
          { id }
        )
      ).toEqual(retained);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} ORDER BY wave_id,wave_outcome_position,wave_outcome_distribution_item_position`
        )
      ).toEqual(sourceSnapshot);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITIONS_TABLE} WHERE wave_id='deleted-source-wave'`
        )
      ).toEqual([]);
    });

    it('does not publish unqualified dangling children or retained source children hidden by a canonical parent at their index', async () => {
      const phantom = legacyCompetitionOutcomeId(id, 99);
      const unqualified = legacyCompetitionOutcomeId(id, 100);
      await sqlExecutor.bulkInsert(
        COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
        [
          {
            id: legacyCompetitionDistributionItemId(phantom, 1),
            competition_id: id,
            outcome_id: phantom,
            outcome_position: 1,
            position: 1,
            amount: 999,
            description: 'hidden by canonical definition'
          },
          {
            id: legacyCompetitionDistributionItemId(unqualified, 1),
            competition_id: id,
            outcome_id: unqualified,
            outcome_position: null,
            position: 1,
            amount: 888,
            description: 'no retained parent index'
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
      await transferRetainedCompetitionDistributions(sqlExecutor, id);
      expect(
        await sqlExecutor.execute(
          `SELECT amount FROM ${legacyGetView(WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE)} WHERE wave_id=:waveId ORDER BY wave_outcome_position,wave_outcome_distribution_item_position`,
          { waveId: wave.id }
        )
      ).toEqual([
        { amount: 11 },
        { amount: null },
        { amount: -11 },
        { amount: 0 }
      ]);
      const newCanonical = legacyCompetitionOutcomeId(id, 104);
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_OUTCOMES_TABLE} (id,competition_id,position,type,description,created_at) VALUES (:newCanonical,:id,4,'MANUAL','Canonical at retained index',1)`,
        { id, newCanonical }
      );
      await sqlExecutor.bulkInsert(
        COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
        [
          {
            id: legacyCompetitionDistributionItemId(newCanonical, 1),
            competition_id: id,
            outcome_id: newCanonical,
            position: 1,
            amount: 23,
            description: 'current canonical child'
          }
        ],
        [
          'id',
          'competition_id',
          'outcome_id',
          'position',
          'amount',
          'description'
        ]
      );
      expect(
        await transferRetainedCompetitionDistributions(sqlExecutor, id)
      ).toEqual([{ competition_id: id, rows: 1 }]);
      expect(
        await sqlExecutor.execute(
          `SELECT wave_outcome_position,amount FROM ${legacyGetView(WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE)} WHERE wave_id=:waveId ORDER BY wave_outcome_position`,
          { waveId: wave.id }
        )
      ).toEqual([
        { wave_outcome_position: 1, amount: 11 },
        { wave_outcome_position: 4, amount: 23 },
        { wave_outcome_position: 7, amount: 0 }
      ]);
    });

    it('retains compatibility children without exposing a phantom native parent or bypassing parent-required access', async () => {
      await transferRetainedCompetitionDistributions(sqlExecutor, id);
      const page = await new CompetitionRepository(
        () => sqlExecutor
      ).listNativeOutcomes(id, { offset: 0, limit: 10, direction: 'ASC' }, {});
      expect(page.data.map((outcome) => outcome.id)).toEqual([canonical]);
      await expect(
        competitionService.listDistribution(
          wave.id,
          id,
          orphan,
          { limit: 10, direction: 'ASC' },
          {}
        )
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  }
);
