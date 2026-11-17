import {
  COMPETITIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionEntryStatus
} from '@/entities/ICompetition';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { CompetitionRepository } from './competition.repository';
import { competitionEntryRepository } from './competition-entry.repository';
import { legacyGetView } from './legacy-competition-get-facade';
import {
  normalizeDefaultCompetition,
  selectDefaultCompetition
} from './default-competition';

const wave = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 100,
    voting_period_start: 100
  },
  { id: 'retained-primary', name: 'Original primary', serial_no: 1 }
);
describeWithSeed(
  'native original-primary identity and independent capabilities',
  withWaves([wave]),
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);
    it('only returns unambiguous active or winning feed memberships visible in the wave', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      const draft = '10000000-0000-4000-8000-000000000002';
      await sqlExecutor.execute(
        `insert into ${COMPETITIONS_TABLE}
         (id, wave_id, type, lifecycle, execution_mode, title, participation_config,
          voting_config, decision_config, winner_config, outcome_config, config_version,
          created_at, updated_at)
         select :draft, wave_id, type, 'DRAFT', execution_mode, title, participation_config,
          voting_config, decision_config, winner_config, outcome_config, config_version,
          created_at, updated_at from ${COMPETITIONS_TABLE} where id = :primary`,
        { draft, primary: primary.id }
      );
      const memberships = [
        { id: 'active', drop_id: 'active-drop' },
        {
          id: 'winner',
          drop_id: 'winner-drop',
          status: CompetitionEntryStatus.WINNER
        },
        {
          id: 'withdrawn',
          drop_id: 'withdrawn-drop',
          status: CompetitionEntryStatus.WITHDRAWN
        },
        { id: 'draft', drop_id: 'draft-drop', competition_id: draft },
        { id: 'ambiguous-one', drop_id: 'ambiguous-drop' },
        {
          id: 'ambiguous-two',
          drop_id: 'ambiguous-drop',
          competition_id: draft
        },
        { id: 'wrong-wave', drop_id: 'wrong-wave-drop', wave_id: 'other-wave' }
      ];
      for (const membership of memberships) {
        await competitionEntryRepository.insert(
          {
            wave_id: wave.id,
            competition_id: primary.id,
            submitter_id: 'artist',
            status: CompetitionEntryStatus.ACTIVE,
            config_version: 1,
            submitted_at: 100,
            rank: null,
            won_at: null,
            decision_id: null,
            ...membership
          },
          {}
        );
      }
      const dropIds = memberships.map(({ drop_id }) => drop_id);
      const publicEntries = await repository.findFeedEntryReferences(
        wave.id,
        dropIds,
        false,
        {}
      );
      expect(publicEntries).toHaveLength(2);
      expect(publicEntries).toEqual(
        expect.arrayContaining([
          {
            drop_id: 'active-drop',
            competition_id: primary.id,
            entry_id: 'active'
          },
          {
            drop_id: 'winner-drop',
            competition_id: primary.id,
            entry_id: 'winner'
          }
        ])
      );
      const adminEntries = await repository.findFeedEntryReferences(
        wave.id,
        dropIds,
        true,
        {}
      );
      expect(adminEntries).toHaveLength(3);
      expect(adminEntries).toEqual(
        expect.arrayContaining([
          ...publicEntries,
          { drop_id: 'draft-drop', competition_id: draft, entry_id: 'draft' }
        ])
      );
    });

    it('keeps old GET ownership fixed when another native competition becomes default', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      const sibling = '10000000-0000-4000-8000-000000000001';
      const siblingRow = {
        ...primary,
        id: sibling,
        legacy_wave_id: null,
        title: 'Sibling',
        participation_starts_at: 0,
        voting_starts_at: 0
      };
      const encoded = Object.fromEntries(
        Object.entries(siblingRow).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ])
      );
      await sqlExecutor.bulkInsert(
        COMPETITIONS_TABLE,
        [encoded],
        Object.keys(encoded)
      );
      const records = await repository.listCompetitionRecordsForWave(
        wave.id,
        {}
      );
      const defaults = await repository.listDefaultCompetitionRecords(
        wave.id,
        {}
      );
      expect(
        selectDefaultCompetition(
          defaults.flatMap((record) => {
            const input = normalizeDefaultCompetition(record, 200);
            return input ? [input] : [];
          }),
          200
        ).competition_id
      ).toBe(sibling);
      expect(
        records.find((record) => record.legacy_wave_id === wave.id)?.id
      ).toBe(primary.id);
      expect(
        await sqlExecutor.execute(
          `select name,type from \`${legacyGetView('waves')}\` where id=:id`,
          { id: wave.id }
        )
      ).toEqual([{ name: wave.name, type: 'RANK' }]);
    });
    it('uses stored capability assignments independently of wave environment settings', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.bulkInsert(
        COMPETITION_CAPABILITIES_TABLE,
        [
          {
            competition_id: primary.id,
            wave_id: wave.id,
            capability: CompetitionCapability.CURATION,
            assigned_by: 'admin',
            assigned_at: 10
          }
        ],
        [
          'competition_id',
          'wave_id',
          'capability',
          'assigned_by',
          'assigned_at'
        ]
      );
      expect(await repository.findCapabilities(primary.id, {})).toEqual([
        CompetitionCapability.CURATION
      ]);
      expect(await repository.findCapabilities('missing', {})).toEqual([]);
    });
  }
);
