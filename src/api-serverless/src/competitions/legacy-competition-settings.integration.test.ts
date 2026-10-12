import { randomUUID } from 'node:crypto';
import { appFeatures } from '@/app-features';
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
import { LEGACY_INDEFINITE_PAUSE_END } from '@/competitions/legacy-competition-settings.repository';
import { legacyWaveUpdate } from './legacy-competition-settings.service';
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
  'Legacy competition Settings',
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
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(false);
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
      await competitionRepository.ensureLegacyMappingForWave(wave, ctx);
    });
    afterEach(() => jest.restoreAllMocks());

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
      }>(`SELECT * FROM ${WAVES_TABLE} WHERE id = :id`, { id: wave.id });
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
        `INSERT INTO ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (drop_id, voter_id, wave_id, timestamp, vote) VALUES ('legacy-entry', :voter, :waveId, 1000, 1)`,
        { voter: identity.profile_id, waveId: wave.id }
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
      ).rejects.toThrow('immutable after the first vote');
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
      jest
        .mocked(appFeatures.isNativeCompetitionWritesEnabled)
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
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
        `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE} (id, profile_id, target_id, contents, type, additional_data_1, additional_data_2, created_at) VALUES ('legacy-vote-log',:actor,'legacy-entry',:contents,'DROP_VOTE_EDIT',:actor,:waveId,NOW())`,
        {
          actor: identity.profile_id,
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

    it('pauses old workers indefinitely and resumes while preserving reason and history', async () => {
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
      ).rejects.toThrow('not paused');
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
          `SELECT end_time, reason FROM ${WAVES_DECISION_PAUSES_TABLE} WHERE wave_id = :id`,
          { id: wave.id }
        )
      ).toEqual({
        end_time: LEGACY_INDEFINITE_PAUSE_END,
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
      ).rejects.toThrow('overlap');
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
