import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import {
  WAVES_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionService } from '@/competitions/competition.service';
import { competitionLifecycleService as service } from './competition-lifecycle.service';
import { INDEFINITE_COMPETITION_PAUSE_END } from '@/competitions/competition-phase';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import { ApiWave } from '@/api/generated/models/ApiWave';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { COMPETITION_SCORE_HISTORY_TABLE } from '@/constants';
import { waveApiService } from '@/api/waves/wave.api.service';
import { listCompetitionVoteActivity } from './competition-vote-activity.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';

const identity = anIdentity(
  {},
  {
    profile_id: 'legacy-admin',
    handle: 'legacy-admin',
    primary_address: '0x0000000000000000000000000000000000000529',
    consolidation_key: 'legacy-admin'
  }
);
const wave = aWave(
  {
    type: WaveType.RANK,
    created_by: identity.profile_id!,
    created_at: 1000,
    updated_at: 1000,
    chat_links_disabled: true,
    chat_slow_mode_cooldown_ms: 60000,
    next_decision_time: Date.now() + 86400000,
    decisions_strategy: {
      first_decision_time: Date.now() + 86400000,
      subsequent_decisions: [],
      is_rolling: false
    }
  },
  { id: 'legacy-settings-wave', name: 'Original wave', serial_no: 1 }
);
const ctx = {
  authenticationContext: AuthenticationContext.fromProfileId(
    identity.profile_id!
  )
};
async function selected() {
  const hub = await competitionService.getHub(wave.id, ctx);
  return competitionService.getCompetition(
    wave.id,
    hub.legacy_primary_competition_id!,
    ctx
  );
}

describeWithSeed(
  'Original-primary native settings',
  [
    withWaves([wave]),
    withIdentities([identity]),
    {
      table: WAVES_METADATA_TABLE,
      rows: [{ wave_id: wave.id, data_key: 'unrelated', data_value: 'keep' }]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: wave.description_drop_id,
          wave_id: wave.id,
          author_id: identity.profile_id,
          created_at: 1000,
          parts_count: 1,
          drop_type: 'CHAT'
        }
      ]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: wave.description_drop_id,
          drop_part_id: 1,
          content: 'Pinned description'
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
      await seedNativeOriginalPrimaryFixture(wave, ctx);
    });
    afterEach(() => jest.restoreAllMocks());

    it('exposes original administration permissions and locks credits after historical votes', async () => {
      const competition = await selected();
      expect(competition.permissions).toMatchObject({
        edit_rules_after_activity: true,
        edit_credit_rules: true
      });
      const anonymous = await competitionService.getCompetition(
        wave.id,
        competition.id,
        {}
      );
      expect(anonymous.permissions).toMatchObject({
        edit_rules_after_activity: false,
        edit_credit_rules: false
      });
      await sqlExecutor.execute(
        `insert into ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,occurred_at,value) values (:competitionId,'VOTER',1,null,'removed-entry',:voter,1000,1)`,
        { competitionId: competition.id, voter: identity.profile_id }
      );
      expect((await selected()).permissions).toMatchObject({
        edit_rules_after_activity: true,
        edit_credit_rules: false
      });
    });

    it('updates through the competition route, preserves wave settings, and replays idempotently', async () => {
      const competition = await selected();
      const config = await service.configuration(wave.id, competition.id, ctx);
      const request = {
        idempotency_key: randomUUID(),
        config_version: competition.config_version,
        config: {
          ...config,
          title: 'Renamed wave',
          presentation: [
            { data_key: 'wave_display.rules.custom', data_value: 'Guidelines' }
          ]
        }
      };
      const updated = await service.update(
        wave.id,
        competition.id,
        request,
        ctx
      );
      expect(updated.title).toBe('Renamed wave');
      expect(updated.config_version).toBeGreaterThan(
        competition.config_version
      );
      expect(updated.presentation).toContainEqual(
        request.config.presentation[0]
      );
      expect(
        await service.update(wave.id, competition.id, request, ctx)
      ).toEqual(updated);
      const persisted = await sqlExecutor.oneOrNull<{
        name: string;
        chat_links_disabled: boolean;
        chat_slow_mode_cooldown_ms: number;
        description_drop_id: string;
      }>(`SELECT * FROM ${legacyGetView(WAVES_TABLE)} WHERE id = :id`, {
        id: wave.id
      });
      expect(persisted).toMatchObject({
        name: 'Renamed wave',
        chat_links_disabled: true,
        chat_slow_mode_cooldown_ms: 60000,
        description_drop_id: wave.description_drop_id
      });
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT data_value FROM ${WAVES_METADATA_TABLE} WHERE wave_id = :id AND data_key = 'unrelated'`,
          { id: wave.id }
        )
      ).toEqual({ data_value: 'keep' });
      await expect(
        service.update(
          wave.id,
          competition.id,
          { ...request, idempotency_key: randomUUID() },
          ctx
        )
      ).rejects.toThrow('Reload');
      const nextRequest = {
        ...request,
        idempotency_key: randomUUID(),
        config_version: updated.config_version,
        config: { ...request.config, title: 'Second edit' }
      };
      const next = await service.update(
        wave.id,
        competition.id,
        nextRequest,
        ctx
      );
      expect(next.title).toBe('Second edit');
      expect(next.config_version).toBeGreaterThan(updated.config_version);
      await expect(
        service.update(
          wave.id,
          competition.id,
          {
            ...nextRequest,
            idempotency_key: randomUUID()
          },
          ctx
        )
      ).rejects.toThrow('Reload');
    });

    it('keeps shared appearance inheritance when editing unrelated native settings', async () => {
      const competition = await selected();
      await sqlExecutor.execute(
        `insert into ${WAVES_METADATA_TABLE} (wave_id,data_key,data_value) values (:waveId,'wave_display.rules.custom','Shared rules')`,
        { waveId: wave.id }
      );
      const config = await service.configuration(wave.id, competition.id, ctx);
      expect(config.presentation).toContainEqual({
        data_key: 'wave_display.rules.custom',
        data_value: 'Shared rules'
      });
      await service.update(
        wave.id,
        competition.id,
        {
          idempotency_key: randomUUID(),
          config_version: competition.config_version,
          config: { ...config, title: 'Unrelated title edit' }
        },
        ctx
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select presentation_config from ${COMPETITIONS_TABLE} where id=:id`,
          { id: competition.id }
        )
      ).toEqual({ presentation_config: null });
      await sqlExecutor.execute(
        `update ${WAVES_METADATA_TABLE} set data_value='Updated shared rules' where wave_id=:waveId and data_key='wave_display.rules.custom'`,
        { waveId: wave.id }
      );
      expect((await selected()).presentation).toContainEqual({
        data_key: 'wave_display.rules.custom',
        data_value: 'Updated shared rules'
      });
    });

    it('restarts approval duration through both native and permanent wave settings', async () => {
      const competition = await selected();
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set type='APPROVE',
          decision_config=json_set(decision_config,'$.winning_min_threshold',10,'$.strategy',null,'$.next_decision_time',null),
          winner_config=json_set(winner_config,'$.winning_min_threshold',10)
          where id=:id`,
        { id: competition.id }
      );
      const runtime = {
        competitionId: competition.id,
        entryId: 'approval-entry'
      };
      await sqlExecutor.execute(
        `insert into ${COMPETITION_ENTRY_RUNTIME_TABLE}
        (competition_id,entry_id,real_time_rating,last_increased_at,over_threshold_since,updated_at)
        values (:competitionId,:entryId,100,1000,1000,1000)`,
        runtime
      );
      const assertReset = async () =>
        expect(
          await sqlExecutor.oneOrNull(
            `select over_threshold_since from ${COMPETITION_ENTRY_RUNTIME_TABLE} where competition_id=:competitionId and entry_id=:entryId`,
            runtime
          )
        ).toEqual({ over_threshold_since: null });
      const config = await service.configuration(wave.id, competition.id, ctx);
      await service.update(
        wave.id,
        competition.id,
        {
          idempotency_key: randomUUID(),
          config_version: competition.config_version,
          config: {
            ...config,
            rules: { ...config.rules, winning_threshold: 20 }
          }
        },
        ctx
      );
      await assertReset();
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set over_threshold_since=2000 where competition_id=:competitionId and entry_id=:entryId`,
        runtime
      );
      const apiWave = await waveApiService.findWaveByIdOrThrow(
        wave.id,
        [],
        ctx
      );
      const request = legacyWaveUpdate(apiWave);
      await waveApiService.updateWave(
        wave.id,
        {
          ...request,
          wave: { ...request.wave, winning_threshold: 30 }
        },
        ctx
      );
      await assertReset();
    });

    it('detects intervening original wave edits without overwriting shared fields', async () => {
      const competition = await selected();
      const config = await service.configuration(wave.id, competition.id, ctx);
      const apiWave = await waveApiService.findWaveByIdOrThrow(
        wave.id,
        [],
        ctx
      );
      await waveApiService.updateWave(
        wave.id,
        {
          ...legacyWaveUpdate(apiWave),
          chat: { ...legacyWaveUpdate(apiWave).chat, links_disabled: false }
        },
        ctx
      );
      await expect(
        service.update(
          wave.id,
          competition.id,
          {
            idempotency_key: randomUUID(),
            config_version: competition.config_version,
            config
          },
          ctx
        )
      ).rejects.toThrow('Reload');
      const fresh = await selected();
      await service.update(
        wave.id,
        competition.id,
        {
          idempotency_key: randomUUID(),
          config_version: fresh.config_version,
          config
        },
        ctx
      );
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT chat_links_disabled FROM ${WAVES_TABLE} WHERE id = :id`,
          { id: wave.id }
        )
      ).toEqual({ chat_links_disabled: false });
    });

    it('preserves voting credit rules after legacy votes while allowing presentation edits', async () => {
      const competition = await selected();
      const config = await service.configuration(wave.id, competition.id, ctx);
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,occurred_at,value) VALUES (:competitionId,'VOTER',1,null,'legacy-entry',:voter,1000,1)`,
        { voter: identity.profile_id, competitionId: competition.id }
      );
      await expect(
        service.update(
          wave.id,
          competition.id,
          {
            idempotency_key: randomUUID(),
            config_version: competition.config_version,
            config: {
              ...config,
              voting: {
                ...config.voting,
                forbid_negative_votes: !config.voting.forbid_negative_votes
              }
            }
          },
          ctx
        )
      ).rejects.toThrow(
        'Voting credit rules are immutable after the first vote'
      );
      const apiWave = await waveApiService.findWaveByIdOrThrow(
        wave.id,
        [],
        ctx
      );
      const legacyRequest = legacyWaveUpdate(apiWave);
      await expect(
        waveApiService.updateWave(
          wave.id,
          {
            ...legacyRequest,
            voting: {
              ...legacyRequest.voting,
              forbid_negative_votes: !legacyRequest.voting.forbid_negative_votes
            }
          },
          ctx
        )
      ).rejects.toThrow(
        'Voting credit rules are immutable after the first vote'
      );
      expect((await selected()).config_version).toBe(
        competition.config_version
      );
      const updated = await service.update(
        wave.id,
        competition.id,
        {
          idempotency_key: randomUUID(),
          config_version: competition.config_version,
          config: { ...config, title: 'Voting continues' }
        },
        ctx
      );
      expect(updated.title).toBe('Voting continues');
      expect(updated.voting.forbid_negative_votes).toBe(
        config.voting.forbid_negative_votes
      );
    });

    it('keeps original immutability and administrator restrictions', async () => {
      const competition = await selected();
      const config = await service.configuration(wave.id, competition.id, ctx);
      await expect(
        service.configuration(wave.id, competition.id, {
          authenticationContext: AuthenticationContext.fromProfileId('visitor')
        })
      ).rejects.toThrow();
      await expect(
        service.update(
          wave.id,
          competition.id,
          {
            idempotency_key: randomUUID(),
            config_version: competition.config_version,
            config: {
              ...config,
              rules: {
                ...config.rules,
                type: 'APPROVE' as typeof config.rules.type
              }
            }
          },
          ctx
        )
      ).rejects.toThrow();
      expect((await selected()).voting.credit_type).toBe('TDH');
    });

    it('isolates legacy activity from a native competition in the same wave', async () => {
      const legacy = await selected();
      const config = await service.configuration(wave.id, legacy.id, ctx);
      const native = await service.create(
        wave.id,
        {
          idempotency_key: randomUUID(),
          config: { ...config, title: 'Native competition' }
        },
        ctx
      );
      const entryId = randomUUID();
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at) VALUES (:id,:competitionId,:waveId,'native-entry',:actor,'ACTIVE',1,1)`,
        {
          id: entryId,
          competitionId: native.id,
          waveId: wave.id,
          actor: identity.profile_id
        }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE} (competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at) VALUES (:competitionId,:entryId,:actor,5,0,5,5,1000)`,
        { competitionId: native.id, entryId, actor: identity.profile_id }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, additional_data_1, additional_data_2, competition_id, created_at) VALUES ('legacy-vote-log',:actor,'legacy-entry',:contents,'DROP_VOTE_EDIT',:actor,:waveId,:competitionId,NOW())`,
        {
          actor: identity.profile_id,
          competitionId: legacy.id,
          contents: JSON.stringify({ oldVote: 0, newVote: 3 }),
          waveId: wave.id
        }
      );
      jest.spyOn(identityFetcher, 'getOverviewsByIds').mockResolvedValue({});
      expect(
        await listCompetitionVoteActivity(wave.id, legacy.id, 0, 50, ctx)
      ).toEqual([
        expect.objectContaining({
          id: 'legacy-vote-log',
          drop_id: 'legacy-entry'
        })
      ]);
      expect(
        await listCompetitionVoteActivity(wave.id, native.id, 0, 50, ctx)
      ).toEqual([
        expect.objectContaining({
          drop_id: 'native-entry',
          contents: { oldVote: 0, newVote: 5 }
        })
      ]);
      // Existing wave vote logs are readable by public-wave viewers, including
      // guests. Private waves mask the same route for guests and outsiders.
      expect(
        await listCompetitionVoteActivity(wave.id, legacy.id, 0, 50, {})
      ).toEqual([
        expect.objectContaining({
          id: 'legacy-vote-log',
          contents: { oldVote: 0, newVote: 3 }
        })
      ]);
      await sqlExecutor.execute(
        `UPDATE ${WAVES_TABLE} SET visibility_group_id = 'private-group' WHERE id = :id`,
        { id: wave.id }
      );
      for (const viewer of [
        {},
        {
          authenticationContext: AuthenticationContext.fromProfileId('visitor')
        }
      ]) {
        await expect(
          listCompetitionVoteActivity(wave.id, legacy.id, 0, 50, viewer)
        ).rejects.toThrow('not found');
      }
    });

    it('pauses native decisions indefinitely and resumes while preserving reason and history', async () => {
      const competition = await selected();
      await expect(
        service.action(
          wave.id,
          competition.id,
          'resume',
          {
            idempotency_key: randomUUID(),
            config_version: competition.config_version
          },
          ctx
        )
      ).rejects.toThrow('no active decision pause');
      expect((await selected()).config_version).toBe(
        competition.config_version
      );
      const paused = await service.action(
        wave.id,
        competition.id,
        'pause',
        {
          idempotency_key: randomUUID(),
          config_version: competition.config_version,
          reason: 'Review entries'
        },
        ctx
      );
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT end_time, reason FROM ${legacyGetView(WAVES_DECISION_PAUSES_TABLE)} WHERE wave_id = :id`,
          { id: wave.id }
        )
      ).toEqual({
        end_time: INDEFINITE_COMPETITION_PAUSE_END,
        reason: 'Review entries'
      });
      const history = await competitionService.listPauses(
        wave.id,
        competition.id,
        { limit: 50, direction: 'ASC' },
        ctx
      );
      expect(history.data).toHaveLength(1);
      expect(history.data[0]).toMatchObject({
        end_time: null,
        reason: 'Review entries'
      });
      await expect(
        service.action(
          wave.id,
          competition.id,
          'pause',
          {
            idempotency_key: randomUUID(),
            config_version: paused.config_version,
            reason: 'Overlapping'
          },
          ctx
        )
      ).rejects.toThrow('A decision pause already covers this interval');
      const resumed = await service.action(
        wave.id,
        competition.id,
        'resume',
        {
          idempotency_key: randomUUID(),
          config_version: paused.config_version
        },
        ctx
      );
      expect(resumed.config_version).toBeGreaterThan(paused.config_version);
      const after = await competitionService.listPauses(
        wave.id,
        competition.id,
        { limit: 50, direction: 'ASC' },
        ctx
      );
      expect(after.data).toHaveLength(1);
      expect(after.data[0].reason).toBe('Review entries');
      expect(after.data[0].end_time).toBeLessThanOrEqual(Date.now());
      const pausedAgain = await service.action(
        wave.id,
        competition.id,
        'pause',
        {
          idempotency_key: randomUUID(),
          config_version: resumed.config_version,
          reason: 'Another review'
        },
        ctx
      );
      const finalHistory = await competitionService.listPauses(
        wave.id,
        competition.id,
        { limit: 50, direction: 'ASC' },
        ctx
      );
      expect(finalHistory.data.map((pause) => pause.reason)).toEqual([
        'Review entries',
        'Another review'
      ]);
      expect(pausedAgain.config_version).toBeGreaterThan(
        resumed.config_version
      );
    });
  }
);

function legacyWaveUpdate(wave: ApiWave): ApiUpdateWaveRequest {
  return {
    name: wave.name,
    picture: wave.picture,
    visibility: {
      scope: { group_id: wave.visibility.scope.group?.id ?? null }
    },
    chat: {
      enabled: wave.chat.enabled,
      scope: { group_id: wave.chat.scope.group?.id ?? null },
      links_disabled: wave.chat.links_disabled,
      slow_mode_cooldown_ms: wave.chat.slow_mode_cooldown_ms
    },
    participation: {
      scope: { group_id: wave.participation.scope.group?.id ?? null },
      no_of_applications_allowed_per_participant:
        wave.participation.no_of_applications_allowed_per_participant,
      required_media: wave.participation.required_media,
      required_metadata: wave.participation.required_metadata,
      signature_required: wave.participation.signature_required,
      period: wave.participation.period ?? { min: null, max: null },
      terms: wave.participation.terms,
      submission_strategy: wave.participation.submission_strategy
    },
    voting: {
      scope: { group_id: wave.voting.scope.group?.id ?? null },
      credit_type: wave.voting.credit_type,
      credit_scope: wave.voting.credit_scope,
      credit_category: wave.voting.credit_category,
      creditor_id: wave.voting.creditor?.id ?? null,
      credit_nfts: wave.voting.credit_nfts,
      signature_required: wave.voting.signature_required,
      period: wave.voting.period ?? { min: null, max: null },
      forbid_negative_votes: wave.voting.forbid_negative_votes
    },
    wave: {
      type: wave.wave.type,
      admin_group: { group_id: wave.wave.admin_group.group?.id ?? null },
      admin_drop_deletion_enabled: wave.wave.admin_drop_deletion_enabled,
      winning_threshold: wave.wave.winning_threshold,
      winning_threshold_min_duration_ms:
        wave.wave.winning_threshold_min_duration_ms,
      max_winners: wave.wave.max_winners,
      max_votes_per_identity_to_drop: wave.wave.max_votes_per_identity_to_drop,
      time_lock_ms: wave.wave.time_lock_ms,
      decisions_strategy: wave.wave.decisions_strategy
    }
  };
}
