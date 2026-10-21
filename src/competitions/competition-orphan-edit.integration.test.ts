import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE
} from '@/constants';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { dropVotingDb } from '@/api/drops/drop-voting.db';
import {
  installLegacyCompetitionGetFacade,
  legacyGetView,
  withLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';
import { legacyCompetitionEntryId } from './competition-id';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'orphan-edit-hub', name: 'Orphan edit hub' }
);
const competitionId = '11000000-0000-4000-8000-000000000005';
const dropId = 'editable-orphan';
const entryId = legacyCompetitionEntryId(competitionId, dropId);
const model: CreateOrUpdateDropModel = {
  drop_id: dropId,
  wave_id: wave.id,
  author_id: 'author',
  author_identity: 'author',
  drop_type: DropType.PARTICIPATORY,
  signature: null,
  title: 'Edited',
  reply_to: null,
  parts: [{ content: 'Edited', quoted_drop: null, media: [] }],
  metadata: [],
  mentioned_users: [],
  mentioned_waves: [],
  mentioned_groups: [],
  referenced_nfts: [],
  is_additional_action_promised: null
};

// The worker overlap uses the final native view after retirement switches its
// definition, even while a preparation API is completing an accepted edit.
describeWithSeed(
  'Accepted original-primary orphan edits',
  [withWaves([wave])],
  () => {
    const oldFlags = [
      process.env.FEATURE_NATIVE_COMPETITION_WRITES,
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION
    ];
    beforeEach(async () => {
      process.env.FEATURE_NATIVE_COMPETITION_WRITES = 'true';
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      await sqlExecutor.execute(
        `insert into ${COMPETITIONS_TABLE}
      (id,wave_id,legacy_wave_id,storage_mode,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,published_at,created_at,updated_at)
      values (:id,:waveId,:waveId,'NATIVE','ACTIVE','RANK','PUBLISHED','Original',
      :participation,:voting,:decisions,'{}','[]',1,1,1,1)`,
        {
          id: competitionId,
          waveId: wave.id,
          participation: JSON.stringify({
            required_metadata: [],
            required_media: []
          }),
          voting: JSON.stringify({
            credit_type: 'TDH',
            credit_scope: 'WAVE',
            credit_nfts: []
          }),
          decisions: JSON.stringify({
            strategy: null,
            next_decision_time: null,
            time_lock_ms: 10
          })
        }
      );
      await sqlExecutor.execute(
        `insert into ${DROPS_TABLE} (id,wave_id,author_id,drop_type,created_at,parts_count) values (:dropId,:waveId,'author','PARTICIPATORY',1,1)`,
        { dropId, waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}
      (competition_id,entry_id,drop_id,rating,decision_rating,real_time_rating,submitted_at,updated_at,published_at)
      values (:id,:entryId,:dropId,40,90,0,1,10,10)`,
        { id: competitionId, entryId, dropId }
      );
      for (const kind of ['AGGREGATE', 'VOTER'])
        await sqlExecutor.execute(
          `insert into ${COMPETITION_SCORE_HISTORY_TABLE}
        (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at)
        values (:id,:kind,1,null,:dropId,:voter,40,1)`,
          {
            id: competitionId,
            kind,
            dropId,
            voter: kind === 'VOTER' ? 'historical-voter' : ''
          }
        );
      await installLegacyCompetitionGetFacade(sqlExecutor);
      await sqlExecutor.execute(`create or replace view ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)} as
      select lb.drop_id,c.wave_id,lb.rating as vote,lb.decision_rating as vote_on_decision_time,
        lb.updated_at as timestamp,lb.over_threshold_since as over_threshold_since_ms
      from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb join ${COMPETITIONS_TABLE} c on c.id=lb.competition_id
      where lb.published_at is not null`);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      for (const [index, key] of Array.from(
        [
          'FEATURE_NATIVE_COMPETITION_WRITES',
          'FEATURE_NATIVE_COMPETITION_EXECUTION'
        ].entries()
      )) {
        if (oldFlags[index] === undefined) delete process.env[key];
        else process.env[key] = oldFlags[index];
      }
      await installLegacyCompetitionGetFacade(sqlExecutor);
    });

    it('clears the published current score while retaining independent history and no membership', async () => {
      const summary = () =>
        withLegacyCompetitionGetFacade(() =>
          dropVotingDb.getDropV2SubmissionVotingSummaries([dropId], {})
        );
      expect((await summary())[dropId]).toMatchObject({
        current_calculated_vote: 40,
        predicted_final_vote: 90
      });
      // Shared-content persistence is isolated; owner/membership locks, reset and
      // runtime refresh execute against the real repositories in one transaction.
      jest
        .spyOn(createOrUpdateDrop as never, 'createOrUpdateDrop' as never)
        .mockImplementation((async () => ({
          drop_id: dropId,
          pending_push_notification_ids: [],
          dm_unread_recipient_ids: []
        })) as never);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        createOrUpdateDrop.execute(model, false, {
          connection,
          prePublication: { trustedSystem: true }
        })
      );
      expect((await summary())[dropId]).toMatchObject({
        current_calculated_vote: 0,
        predicted_final_vote: 0
      });
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where drop_id=:dropId`,
          { dropId }
        )
      ).toEqual({ count: 0 });
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${COMPETITION_SCORE_HISTORY_TABLE} where competition_id=:id`,
          { id: competitionId }
        )
      ).toEqual({ count: 2 });
    });
  }
);
