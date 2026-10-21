import * as tables from '@/constants';
import { identitiesDb } from '@/identities/identities.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import { legacyCompetitionId } from './competition-id';
import { competitionMainStageRepository } from './competition-main-stage.repository';

const nativeWave = aWave(
  { type: WaveType.RANK },
  { id: 'native-main-stage-hub', name: 'Native main stage', serial_no: 1 }
);
const legacyWave = aWave(
  { type: WaveType.RANK },
  { id: 'legacy-main-stage-hub', name: 'Legacy main stage', serial_no: 2 }
);
const nativeId = legacyCompetitionId(nativeWave.id);
const legacyId = legacyCompetitionId(legacyWave.id);
const drops = [
  { id: 'native-active', wave_id: nativeWave.id, drop_type: 'WINNER' },
  { id: 'native-winner', wave_id: nativeWave.id, drop_type: 'PARTICIPATORY' },
  {
    id: 'native-withdrawn',
    wave_id: nativeWave.id,
    drop_type: 'PARTICIPATORY'
  },
  { id: 'native-orphan', wave_id: nativeWave.id, drop_type: 'PARTICIPATORY' },
  {
    id: 'unassigned-sibling-drop',
    wave_id: nativeWave.id,
    drop_type: 'COMPETITION'
  },
  { id: 'legacy-active', wave_id: legacyWave.id, drop_type: 'PARTICIPATORY' },
  { id: 'legacy-winner', wave_id: legacyWave.id, drop_type: 'WINNER' }
];

describeWithSeed(
  'preparatory main-stage native authority outside old GET scope',
  [
    withWaves([nativeWave, legacyWave]),
    {
      table: tables.DROPS_TABLE,
      rows: drops.map((drop) => ({
        ...drop,
        author_id: 'artist',
        created_at: 0,
        parts_count: 1
      }))
    },
    {
      table: tables.DROP_VOTER_STATE_TABLE,
      rows: drops
        .filter((drop) => drop.drop_type !== 'COMPETITION')
        .map((drop) => ({
          drop_id: drop.id,
          wave_id: drop.wave_id,
          voter_id: 'voter',
          votes: drop.id === 'legacy-active' ? -15 : 200
        }))
    },
    {
      table: tables.WAVES_DECISION_WINNER_DROPS_TABLE,
      rows: [
        {
          decision_time: 1,
          drop_id: 'legacy-winner',
          wave_id: legacyWave.id,
          ranking: 1,
          final_vote: 200,
          prizes: []
        }
      ]
    }
  ],
  () => {
    const previousMainStage = process.env.MAIN_STAGE_WAVE_ID;
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(nativeWave);
      await seedNativeOriginalPrimaryFixture(legacyWave);
      await sqlExecutor.execute(
        `UPDATE ${tables.COMPETITIONS_TABLE} SET storage_mode='LEGACY_ADAPTER' WHERE id=:legacyId`,
        { legacyId }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITION_CAPABILITIES_TABLE} (capability,competition_id,wave_id,assigned_at) VALUES ('MAIN_STAGE',:nativeId,:waveId,0)`,
        { nativeId, waveId: nativeWave.id }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITIONS_TABLE} (id,wave_id,legacy_wave_id,storage_mode,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,published_at,created_at,updated_at) SELECT 'unassigned-sibling',wave_id,null,storage_mode,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,published_at,created_at,updated_at FROM ${tables.COMPETITIONS_TABLE} WHERE id=:nativeId`,
        { nativeId }
      );
      for (const [entryId, status] of [
        ['native-active', 'ACTIVE'],
        ['native-winner', 'WINNER'],
        ['native-withdrawn', 'WITHDRAWN'],
        ['unassigned-sibling-drop', 'ACTIVE']
      ]) {
        const competitionId =
          entryId === 'unassigned-sibling-drop'
            ? 'unassigned-sibling'
            : nativeId;
        await sqlExecutor.execute(
          `INSERT INTO ${tables.COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at,decision_id) VALUES (:entryId,:competitionId,:waveId,:entryId,'artist',:status,1,0,:decisionId)`,
          {
            entryId,
            competitionId,
            waveId: nativeWave.id,
            status,
            decisionId: status === 'WINNER' ? 'accepted-decision' : null
          }
        );
        await sqlExecutor.execute(
          `INSERT INTO ${tables.COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) VALUES (:entryId,:competitionId,:entryId,'voter',:value,:value,1,1)`,
          { entryId, competitionId, value: status === 'ACTIVE' ? 4 : 70 }
        );
      }
      await sqlExecutor.execute(
        `INSERT INTO ${tables.COMPETITION_DECISION_WINNERS_TABLE} (decision_id,entry_id,competition_id,\`rank\`,final_rating,created_at) VALUES ('accepted-decision','native-winner',:nativeId,1,70,1)`,
        { nativeId }
      );
    });
    afterEach(() => {
      if (previousMainStage === undefined)
        delete process.env.MAIN_STAGE_WAVE_ID;
      else process.env.MAIN_STAGE_WAVE_ID = previousMainStage;
    });

    it('uses native current allocations and accepted winner membership despite stale physical classifications and mirrored totals', async () => {
      process.env.MAIN_STAGE_WAVE_ID = nativeWave.id;
      expect(
        await identitiesDb.getActiveMainStageDropIds(['artist'], {})
      ).toEqual({ artist: ['native-active'] });
      expect(
        await identitiesDb.getMainStageWinnerDropIds(['artist'], {})
      ).toEqual({ artist: ['native-winner'] });
      expect(
        await competitionMainStageRepository.totalActiveVotes(nativeWave.id, {})
      ).toBe(4);
    });

    it('retains actual legacy-owner badge and allocation behavior alongside independently designated native entries', async () => {
      process.env.MAIN_STAGE_WAVE_ID = legacyWave.id;
      const active = await identitiesDb.getActiveMainStageDropIds(
        ['artist'],
        {}
      );
      const winners = await identitiesDb.getMainStageWinnerDropIds(
        ['artist'],
        {}
      );
      expect(active.artist.sort((a, b) => a.localeCompare(b))).toEqual([
        'legacy-active',
        'native-active'
      ]);
      expect(winners.artist.sort((a, b) => a.localeCompare(b))).toEqual([
        'legacy-winner',
        'native-winner'
      ]);
      expect(
        await competitionMainStageRepository.totalActiveVotes(legacyWave.id, {})
      ).toBe(19);
    });
  }
);
