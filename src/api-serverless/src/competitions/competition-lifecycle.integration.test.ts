import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ratingsDb } from '@/rates/ratings.db';
import { identitiesDb } from '@/identities/identities.db';
import { competitionVotingService } from './competition-voting.service';
import { randomUUID } from 'node:crypto';
import { appFeatures } from '@/app-features';
import { AuthenticationContext } from '@/auth-context';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CAPABILITY_AUDITS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  WAVES_METADATA_TABLE
} from '@/constants';
import { CompetitionCapability } from '@/entities/ICompetition';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { competitionService } from '@/competitions/competition.service';
import { competitionHistoryRepository } from '@/competitions/competition-history.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { competitionCapabilityService } from '@/competitions/competition-capability.service';
import { CompetitionDraftSchema } from './competition-configuration';
import { competitionLifecycleService as service } from './competition-lifecycle.service';
import { listCompetitionVoteActivity } from './competition-vote-activity.service';

const actor = 'competition-admin';
const wave = aWave(
  { created_by: actor },
  { id: 'shared-hub', name: 'Shared hub', serial_no: 1 }
);
const ctx = {
  authenticationContext: AuthenticationContext.fromProfileId(actor)
};
function config(): ApiCompetitionDraftInput {
  return getValidatedByJoiOrThrow(
    {
      title: 'Rank',
      description: 'Independent competition',
      participation: {
        scope: { group_id: null },
        required_media: [],
        required_metadata: [],
        no_of_applications_allowed_per_participant: null,
        signature_required: false,
        terms: null,
        period: { min: null, max: null }
      },
      voting: {
        scope: { group_id: null },
        credit_type: 'TDH',
        credit_scope: 'WAVE',
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        forbid_negative_votes: false,
        period: { min: null, max: null }
      },
      rules: {
        type: 'RANK',
        winning_threshold: null,
        winning_threshold_min_duration_ms: null,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        decisions_strategy: {
          first_decision_time: Date.now() + 86400000,
          subsequent_decisions: [],
          is_rolling: false
        }
      },
      outcomes: [
        {
          type: 'MANUAL',
          description: 'Winner',
          distribution: [{ description: 'First' }]
        }
      ],
      presentation: []
    },
    CompetitionDraftSchema
  );
}
async function draft() {
  return service.create(
    wave.id,
    { idempotency_key: randomUUID(), config: config() },
    ctx
  );
}
async function activity(competitionId: string) {
  const id = randomUUID();
  await sqlExecutor.execute(
    `INSERT INTO ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
    VALUES (:id,:competitionId,:waveId,:dropId,'entrant','ACTIVE',1,1)`,
    { id, dropId: `drop-${id}`, competitionId, waveId: wave.id }
  );
  return id;
}
async function completeSchedule(competitionId: string) {
  await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    nativeCompetitionRuntimeRepository.updateSchedule(
      competitionId,
      null,
      Date.now(),
      true,
      { ...ctx, connection }
    )
  );
}

describeWithSeed(
  'Native lifecycle and privileged configuration',
  withWaves([wave]),
  () => {
    beforeEach(() => {
      jest
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.NATIVE_COMPETITION_CAPABILITY_OPERATORS;
    });

    it('scopes vote activity to visible entries in the chosen competition and masks drafts and mismatched parents', async () => {
      const first = await draft();
      const second = await draft();
      await expect(
        listCompetitionVoteActivity(wave.id, first.id, 0, 50, {})
      ).rejects.toThrow('not found');
      await service.action(
        wave.id,
        first.id,
        'publish',
        {
          idempotency_key: randomUUID(),
          config_version: first.config_version
        },
        ctx
      );
      const visible = await activity(first.id);
      const removed = await activity(first.id);
      const unrelated = await activity(second.id);
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_ENTRIES_TABLE} SET status = 'DELETED' WHERE id = :id`,
        { id: removed }
      );
      for (const [competitionId, entryId, occurredAt] of [
        [first.id, visible, 1],
        [first.id, visible, 2],
        [first.id, removed, 3],
        [second.id, unrelated, 4]
      ] as const) {
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE}
           (competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at)
           VALUES (:competitionId,:entryId,'voter',10,5,10,5,:occurredAt)`,
          { competitionId, entryId, occurredAt }
        );
      }
      jest.spyOn(identityFetcher, 'getOverviewsByIds').mockResolvedValue({});
      const logs = await listCompetitionVoteActivity(
        wave.id,
        first.id,
        0,
        1,
        {}
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        wave_id: wave.id,
        drop_id: `drop-${visible}`,
        contents: { oldVote: 5, newVote: 10 },
        created_at: new Date(2)
      });
      expect(
        await listCompetitionVoteActivity(wave.id, first.id, 1, 50, {})
      ).toEqual([expect.objectContaining({ created_at: new Date(1) })]);
      await expect(
        listCompetitionVoteActivity('wrong-parent', first.id, 0, 50, {})
      ).rejects.toThrow('not found');
    });

    it('creates drafts idempotently, masks them from members, and leaves legacy CHAT selection empty', async () => {
      const request = { idempotency_key: randomUUID(), config: config() };
      const first = await service.create(wave.id, request, ctx);
      expect(await service.create(wave.id, request, ctx)).toEqual(first);
      expect(first.lifecycle).toBe('DRAFT');
      expect(
        (
          await competitionService.listCompetitions(
            wave.id,
            { limit: 50, direction: 'ASC', sort: 'created_at' },
            {}
          )
        ).data
      ).toEqual([]);
      await service.action(
        wave.id,
        first.id,
        'archive',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      expect(
        (
          await competitionService.listCompetitions(
            wave.id,
            { limit: 50, direction: 'ASC', sort: 'created_at' },
            {}
          )
        ).data
      ).toEqual([]);

      expect(
        (await competitionService.getHub(wave.id, ctx))
          .legacy_primary_competition_id
      ).toBeNull();
      await expect(
        competitionService.getCompetition(wave.id, first.id, {})
      ).rejects.toThrow('not found');
      expect(
        await sqlExecutor.execute(`SELECT id FROM ${COMPETITIONS_TABLE}`)
      ).toHaveLength(1);
    });

    it('inherits migrated wave appearance for configuration and clones until explicitly cleared', async () => {
      const first = await draft();
      const presentation = [
        {
          data_key: 'wave_display.approve.tabs.approved_label',
          data_value: 'Chosen'
        }
      ];
      await sqlExecutor.execute(
        `insert into ${WAVES_METADATA_TABLE} (wave_id,data_key,data_value) values (:waveId,:key,:value)`,
        {
          waveId: wave.id,
          key: presentation[0].data_key,
          value: presentation[0].data_value
        }
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set legacy_wave_id=wave_id,presentation_config=null,lifecycle='ENDED' where id=:id`,
        { id: first.id }
      );
      expect(
        (await service.configuration(wave.id, first.id, ctx)).presentation
      ).toEqual(presentation);
      const clone = await service.action(
        wave.id,
        first.id,
        'clone',
        { idempotency_key: randomUUID(), config_version: first.config_version },
        ctx
      );
      expect(clone.presentation).toEqual(presentation);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set presentation_config='[]' where id=:id`,
        { id: first.id }
      );
      expect(
        (await service.configuration(wave.id, first.id, ctx)).presentation
      ).toEqual([]);
    });

    it('freezes published type, freezes rules after activity, and versions presentation without changing decision progress', async () => {
      const first = await draft();
      const published = await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      const original = await service.configuration(wave.id, first.id, ctx);
      const differentType = {
        ...original,
        rules: {
          ...original.rules,
          type: 'APPROVE' as ApiCompetitionDraftInput['rules']['type']
        }
      };
      await expect(
        service.update(
          wave.id,
          first.id,
          {
            idempotency_key: randomUUID(),
            config_version: published.config_version,
            config: differentType
          },
          ctx
        )
      ).rejects.toThrow('type cannot change');
      await activity(first.id);
      await expect(
        service.update(
          wave.id,
          first.id,
          {
            idempotency_key: randomUUID(),
            config_version: published.config_version,
            config: {
              ...original,
              voting: { ...original.voting, signature_required: true }
            }
          },
          ctx
        )
      ).rejects.toThrow('immutable after');
      const renamed = await service.update(
        wave.id,
        first.id,
        {
          idempotency_key: randomUUID(),
          config_version: published.config_version,
          config: {
            ...original,
            title: 'Renamed',
            presentation: [
              {
                data_key: 'wave_display.submission.button_label',
                data_value: 'Propose'
              }
            ]
          }
        },
        ctx
      );
      expect(renamed.title).toBe('Renamed');
      expect(renamed.decisions.next_decision_time).toBe(
        published.decisions.next_decision_time
      );
      expect(renamed.config_version).toBe(3);
      expect(
        await sqlExecutor.execute(
          `SELECT version FROM ${COMPETITION_CONFIG_VERSIONS_TABLE} WHERE competition_id=:id`,
          { id: first.id }
        )
      ).toHaveLength(3);
      const outcomes = await sqlExecutor.execute(
        `SELECT id FROM ${COMPETITION_OUTCOMES_TABLE} WHERE competition_id=:id`,
        { id: first.id }
      );
      expect(outcomes).toHaveLength(1);
    });

    it('rejects past schedule edits on a published competition but permits later presentation edits', async () => {
      const first = await draft();
      await service.action(
        wave.id,
        first.id,
        'publish',
        {
          idempotency_key: randomUUID(),
          config_version: 1
        },
        ctx
      );
      const original = await service.configuration(wave.id, first.id, ctx);
      const past = Date.now() - 1000;
      const invalidConfigurations: ApiCompetitionDraftInput[] = [
        {
          ...original,
          rules: {
            ...original.rules,
            decisions_strategy: {
              first_decision_time: past,
              subsequent_decisions: [],
              is_rolling: false
            }
          }
        },
        {
          ...original,
          participation: {
            ...original.participation,
            period: { min: null, max: past }
          }
        },
        {
          ...original,
          voting: { ...original.voting, period: { min: null, max: past } }
        }
      ];
      for (const config of invalidConfigurations) {
        await expect(
          service.update(
            wave.id,
            first.id,
            {
              idempotency_key: randomUUID(),
              config_version: 2,
              config
            },
            ctx
          )
        ).rejects.toThrow(/future|ended/);
      }
      expect(
        (await service.configuration(wave.id, first.id, ctx)).rules
      ).toEqual(original.rules);
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86400000);
      const renamed = await service.update(
        wave.id,
        first.id,
        {
          idempotency_key: randomUUID(),
          config_version: 2,
          config: { ...original, title: 'Updated presentation' }
        },
        ctx
      );
      expect(renamed.title).toBe('Updated presentation');
      expect(renamed.config_version).toBe(3);
    });

    it('retains history when archiving a completed competition and only clones into a distinct draft', async () => {
      const first = await draft();
      await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      await activity(first.id);
      await completeSchedule(first.id);
      expect(
        (await competitionService.getCompetition(wave.id, first.id, ctx))
          .lifecycle
      ).toBe('ENDED');
      await expect(
        service.action(
          wave.id,
          first.id,
          'publish',
          { idempotency_key: randomUUID(), config_version: 2 },
          ctx
        )
      ).rejects.toThrow('Only drafts');
      const archived = await service.action(
        wave.id,
        first.id,
        'archive',
        { idempotency_key: randomUUID(), config_version: 2 },
        ctx
      );
      const clone = await service.action(
        wave.id,
        first.id,
        'clone',
        {
          idempotency_key: randomUUID(),
          config_version: archived.config_version
        },
        ctx
      );
      expect(clone.id).not.toBe(first.id);
      expect(clone.lifecycle).toBe('DRAFT');
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITION_ENTRIES_TABLE} WHERE competition_id=:id`,
          { id: first.id }
        )
      ).toHaveLength(1);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          competitionHistoryRepository.assertWaveCanBeDeleted(wave.id, {
            connection
          })
        )
      ).rejects.toThrow('competition history');
    });

    it('rejects stale configuration and records pause/resume without closing participation', async () => {
      const first = await draft();
      await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      await expect(
        service.action(
          wave.id,
          first.id,
          'pause',
          {
            idempotency_key: randomUUID(),
            config_version: 1,
            reason: 'Reviewing submissions'
          },
          ctx
        )
      ).rejects.toThrow('rules changed');
      const paused = await service.action(
        wave.id,
        first.id,
        'pause',
        {
          idempotency_key: randomUUID(),
          config_version: 2,
          reason: 'Reviewing submissions'
        },
        ctx
      );
      expect(paused.lifecycle).toBe('PUBLISHED');
      expect(paused.permissions.submit).toBe(true);
      const resumed = await service.action(
        wave.id,
        first.id,
        'resume',
        { idempotency_key: randomUUID(), config_version: 3 },
        ctx
      );
      expect(resumed.lifecycle).toBe('PUBLISHED');
    });

    it('normalizes a REP creditor handle to the stable profile before calculating budgets', async () => {
      const creditor = '00000000-0000-4000-8000-000000000099';
      jest
        .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
        .mockResolvedValue(creditor);
      jest
        .spyOn(identityFetcher, 'getProfileIdByIdentityKey')
        .mockResolvedValue(creditor);
      const rating = jest
        .spyOn(ratingsDb, 'getRepRating')
        .mockImplementation(async (params) =>
          params.rater_profile_id === creditor ? 67 : 0
        );
      const original = config();
      const input = getValidatedByJoiOrThrow(
        {
          ...original,
          voting: {
            ...original.voting,
            credit_type: 'REP',
            creditor_id: 'builder-handle',
            credit_category: 'Builder'
          }
        },
        CompetitionDraftSchema
      );
      const competition = await service.create(
        wave.id,
        { idempotency_key: randomUUID(), config: input },
        ctx
      );
      expect(
        (await service.configuration(wave.id, competition.id, ctx)).voting
          .creditor_id
      ).toBe(creditor);
      expect(
        (
          await competitionVotingService.budget(
            wave.id,
            competition.id,
            undefined,
            ctx
          )
        ).available
      ).toBe(67);
      expect(rating).toHaveBeenCalledWith(
        expect.objectContaining({
          rater_profile_id: creditor,
          category: 'Builder'
        }),
        expect.anything()
      );
    });

    it('serializes votes at the API boundary and preserves independent competition budgets', async () => {
      jest
        .spyOn(identitiesDb, 'getIdentityByProfileId')
        .mockResolvedValue({ tdh: 100, xtdh: 0 } as never);
      const first = await draft();
      const second = await draft();
      for (const competition of [first, second]) {
        await service.action(
          wave.id,
          competition.id,
          'publish',
          { idempotency_key: randomUUID(), config_version: 1 },
          ctx
        );
      }
      const entry = await activity(first.id);
      const otherEntry = await activity(first.id);
      const secondEntry = await activity(second.id);
      const vote = (competitionId: string, entryId: string, value: number) =>
        competitionVotingService.vote(
          wave.id,
          competitionId,
          entryId,
          { idempotency_key: randomUUID(), config_version: 2, value },
          ctx
        );
      const results = await Promise.allSettled([
        vote(first.id, entry, 70),
        vote(first.id, otherEntry, 70)
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected')
      ).toHaveLength(1);
      expect(
        (
          await competitionVotingService.budget(
            wave.id,
            first.id,
            undefined,
            ctx
          )
        ).remaining
      ).toBe(30);
      expect((await vote(second.id, secondEntry, 90)).remaining).toBe(10);
      const votedEntry = results[0].status === 'fulfilled' ? entry : otherEntry;
      expect((await vote(first.id, votedEntry, -40)).remaining).toBe(60);
      expect((await vote(first.id, votedEntry, 0)).remaining).toBe(100);
      await expect(vote(first.id, secondEntry, 1)).rejects.toThrow('not found');
      await completeSchedule(first.id);
      await expect(
        competitionVotingService.vote(
          wave.id,
          first.id,
          entry,
          { idempotency_key: randomUUID(), config_version: 2, value: 1 },
          ctx
        )
      ).rejects.toThrow('not accepting');
    });

    it('requires an explicit operations allowlist, audits unique assignments and freezes them once participation begins', async () => {
      const first = await draft();
      const change = {
        waveId: wave.id,
        competitionId: first.id,
        capability: CompetitionCapability.MAIN_STAGE,
        action: 'assign' as const,
        actorId: actor,
        reason: 'Designated Main Stage'
      };
      await expect(
        competitionCapabilityService.change(change, randomUUID(), true, {})
      ).rejects.toThrow('allowlisted');
      process.env.NATIVE_COMPETITION_CAPABILITY_OPERATORS = actor;
      await competitionCapabilityService.change(change, randomUUID(), true, {});
      expect(
        await sqlExecutor.execute(
          `SELECT competition_id FROM ${COMPETITION_CAPABILITIES_TABLE}`
        )
      ).toEqual([]);
      const key = randomUUID();
      await competitionCapabilityService.change(change, key, false, {});
      await competitionCapabilityService.change(change, key, false, {});
      await expect(
        competitionCapabilityService.change(change, randomUUID(), false, {})
      ).rejects.toThrow('already in');
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITION_CAPABILITY_AUDITS_TABLE}`
        )
      ).toHaveLength(1);
      await activity(first.id);
      await expect(
        competitionCapabilityService.change(
          { ...change, action: 'remove' },
          randomUUID(),
          false,
          {}
        )
      ).rejects.toThrow('immutable after');
    });
  }
);
