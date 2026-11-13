import { randomUUID } from 'node:crypto';
import {
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_WINNER_VOTES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { WaveType } from '@/entities/IWave';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { withCompetitionProfileMerge } from './competition-profile-merge';

const wave = aWave({ type: WaveType.RANK });

describeWithSeed(
  'Native competition profile consolidation',
  [withWaves([wave])],
  () => {
    it('sums overlapping current and frozen votes and recomputes absolute credit', async () => {
      const { id } = await seedNativeOriginalPrimaryFixture(wave);
      const entryId = randomUUID(),
        decisionId = randomUUID();
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (:sourceId,:id,:entryId,'source',-7,7,1,1),(:targetId,:id,:entryId,'target',2,2,1,1)`,
        { id, entryId, sourceId: randomUUID(), targetId: randomUUID() }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_WINNER_VOTES_TABLE} (competition_id,decision_id,entry_id,voter_profile_id,value) values (:id,:decisionId,:entryId,'source',7),(:id,:decisionId,:entryId,'target',2)`,
        { id, entryId, decisionId }
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withCompetitionProfileMerge(
          sqlExecutor,
          ['source'],
          'target',
          async () => undefined,
          { connection }
        )
      );
      expect(
        await sqlExecutor.execute(
          `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ voter_profile_id: 'target', value: -5, credit_spent: 5 }]);
      expect(
        await sqlExecutor.execute(
          `select voter_profile_id,value from ${COMPETITION_WINNER_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ voter_profile_id: 'target', value: 9 }]);
    });

    it('finds deleted-entry activity by its retained submitter and preserves proxy identity', async () => {
      const { id } = await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTE_HISTORY_TABLE} (competition_id,entry_id,drop_id,submitter_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at,proxy_id) values (:id,:entryId,'deleted-drop','source','voter',7,0,7,7,1,'original-proxy')`,
        { id, entryId: randomUUID() }
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withCompetitionProfileMerge(
          sqlExecutor,
          ['source'],
          'target',
          async () => undefined,
          { connection }
        )
      );
      expect(
        await sqlExecutor.execute(
          `select submitter_id,voter_profile_id,proxy_id from ${COMPETITION_VOTE_HISTORY_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([
        {
          submitter_id: 'target',
          voter_profile_id: 'voter',
          proxy_id: 'original-proxy'
        }
      ]);
    });
  }
);
