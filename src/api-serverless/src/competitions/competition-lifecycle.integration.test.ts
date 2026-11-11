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
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  DROPS_TABLE,
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
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { assertCompetitionOpen } from './competition-command-access';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionEventRepository } from '@/competitions/competition-event.repository';

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
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.NATIVE_COMPETITION_CAPABILITY_OPERATORS;
    });

    it('defaults to public submissions and preserves anonymous configuration through publication and cloning', async () => {
      const publicDraft = await draft();
      expect(publicDraft.participation.anonymous_submissions).toBe(false);
      const anonymousConfig = config();
      anonymousConfig.participation.anonymous_submissions = true;
      const anonymousDraft = await service.create(
        wave.id,
        { idempotency_key: randomUUID(), config: anonymousConfig },
        ctx
      );
      expect(anonymousDraft.participation.anonymous_submissions).toBe(true);
      const published = await service.action(
        wave.id,
        anonymousDraft.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      const changingPrivacy = {
        ...anonymousConfig,
        participation: {
          ...anonymousConfig.participation,
          anonymous_submissions: false
        }
      };
      await expect(
        service.update(
          wave.id,
          published.id,
          {
            idempotency_key: randomUUID(),
            config_version: published.config_version,
            config: changingPrivacy
          },
          ctx
        )
      ).rejects.toThrow('anonymity cannot change after publication');
      await completeSchedule(published.id);
      const clone = await service.action(
        wave.id,
        published.id,
        'clone',
        {
          idempotency_key: randomUUID(),
          config_version: published.config_version
        },
        ctx
      );
      expect(clone.participation.anonymous_submissions).toBe(true);
      const updated = await service.update(
        wave.id,
        clone.id,
        {
          idempotency_key: randomUUID(),
          config_version: clone.config_version,
          config: changingPrivacy
        },
        ctx
      );
      expect(updated.participation.anonymous_submissions).toBe(false);
    });

    it('caps concurrently published competitions per wave and frees a slot when one is archived', async () => {
      process.env.COMPETITION_MAX_PUBLISHED_PER_WAVE = '2';
      try {
        const drafts = [await draft(), await draft(), await draft()];
        const publish = (competition: { id: string; config_version: number }) =>
          service.action(
            wave.id,
            competition.id,
            'publish',
            {
              idempotency_key: randomUUID(),
              config_version: competition.config_version
            },
            ctx
          );
        const first = await publish(drafts[0]);
        await publish(drafts[1]);
        await expect(publish(drafts[2])).rejects.toMatchObject({
          code: 'PUBLISHED_COMPETITION_LIMIT'
        });
        await service.action(
          wave.id,
          first.id,
          'archive',
          {
            idempotency_key: randomUUID(),
            config_version: first.config_version
          },
          ctx
        );
        await expect(publish(drafts[2])).resolves.toMatchObject({
          id: drafts[2].id
        });
      } finally {
        delete process.env.COMPETITION_MAX_PUBLISHED_PER_WAVE;
      }
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

    it('archives an unused published competition without fabricating completion', async () => {
      const first = await draft();
      const published = await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      expect(published.permissions).not.toHaveProperty(
        'archive_requires_reason'
      );
      const archived = await service.action(
        wave.id,
        first.id,
        'archive',
        {
          idempotency_key: randomUUID(),
          config_version: published.config_version
        },
        ctx
      );
      expect(archived).toMatchObject({
        lifecycle: 'ARCHIVED',
        computed_phase: 'ARCHIVED',
        ended_at: null,
        permissions: {
          submit: false,
          vote: false
        }
      });
    });

    it('archives without a reason after deleted entries and historical votes and preserves them idempotently', async () => {
      const first = await draft();
      const published = await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      const entryId = await activity(first.id);
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_ENTRIES_TABLE} SET status='DELETED' WHERE id=:entryId`,
        { entryId }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE}
         (competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at)
         VALUES (:competitionId,:entryId,'voter',0,10,0,-10,1)`,
        { competitionId: first.id, entryId }
      );
      const request = {
        idempotency_key: randomUUID(),
        config_version: published.config_version
      };
      const archived = await service.action(
        wave.id,
        first.id,
        'archive',
        request,
        ctx
      );
      expect(
        await service.action(wave.id, first.id, 'archive', request, ctx)
      ).toEqual(archived);
      const record = await competitionRepository.findCompetitionRecordById(
        first.id,
        ctx
      );
      const competition = await new NativeCompetitionReader(
        competitionRepository,
        ctx
      ).getCompetition(record!, Date.now());
      for (const command of ['submit', 'vote'] as const)
        expect(() =>
          assertCompetitionOpen(competition, Date.now(), command)
        ).toThrow('not accepting');
      await nativeCompetitionRuntimeService.processCompetition(
        first.id,
        Date.now() + 2 * 86400000
      );
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITION_DECISIONS_TABLE} WHERE competition_id=:id`,
          { id: first.id }
        )
      ).toHaveLength(0);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${COMPETITION_ENTRIES_TABLE} WHERE competition_id=:id`,
          { id: first.id }
        )
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `SELECT entry_id FROM ${COMPETITION_VOTE_HISTORY_TABLE} WHERE competition_id=:id`,
          { id: first.id }
        )
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `SELECT actor_id FROM ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
         WHERE competition_id=:id AND lifecycle='ARCHIVED'`,
          { id: first.id }
        )
      ).toEqual([{ actor_id: actor }]);
    });

    it('waits for an executing decision, preserves its winners and awards, and prevents later decisions', async () => {
      const input = config();
      const firstDecision = Date.now() + 86400000;
      input.rules.decisions_strategy = {
        first_decision_time: firstDecision,
        subsequent_decisions: [86400000],
        is_rolling: true
      };
      const first = await service.create(
        wave.id,
        { idempotency_key: randomUUID(), config: input },
        ctx
      );
      const published = await service.action(
        wave.id,
        first.id,
        'publish',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      const entryId = await activity(first.id);
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_CAPABILITIES_TABLE}
         (capability,competition_id,wave_id,assigned_at) VALUES ('MAIN_STAGE',:id,:waveId,0)`,
        { id: first.id, waveId: wave.id }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${DROPS_TABLE}
         (id,wave_id,author_id,created_at,parts_count,drop_type)
         VALUES (:id,:waveId,'entrant',1,1,'COMPETITION')`,
        { id: `drop-${entryId}`, waveId: wave.id }
      );
      const historyTables = [
        COMPETITION_ENTRIES_TABLE,
        COMPETITION_DECISIONS_TABLE,
        COMPETITION_DECISION_WINNERS_TABLE,
        COMPETITION_OUTCOME_AWARDS_TABLE
      ];
      let archiving: ReturnType<typeof service.action> | undefined;
      const before = await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await nativeCompetitionRuntimeService.processCompetition(
            first.id,
            firstDecision + 1,
            { ...ctx, connection }
          );
          const snapshots = [];
          for (const table of historyTables)
            snapshots.push(
              await sqlExecutor.execute(
                `SELECT * FROM ${table} WHERE competition_id=:id`,
                { id: first.id },
                { wrappedConnection: connection }
              )
            );
          // Archiving must wait for the decision transaction's competition lock.
          archiving = service.action(
            wave.id,
            first.id,
            'archive',
            {
              idempotency_key: randomUUID(),
              config_version: published.config_version,
              reason: 'Retiring after the current decision'
            },
            ctx
          );
          return snapshots;
        }
      );
      expect(before[1]).toHaveLength(1);
      expect(before[2]).toHaveLength(1);
      expect(before[3]).toHaveLength(1);
      expect((await archiving)?.lifecycle).toBe('ARCHIVED');
      const [decision] = await sqlExecutor.execute<{ id: string }>(
        `SELECT id FROM ${COMPETITION_DECISIONS_TABLE} WHERE competition_id=:id`,
        { id: first.id }
      );
      expect(
        await competitionEventRepository.getPrivilegedWinners(
          first.id,
          decision.id,
          ctx
        )
      ).toEqual([expect.objectContaining({ entry_id: entryId, rank: 1 })]);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        competitionEventRepository.assertNativeClaim(
          {
            competition_id: first.id,
            competition_entry_id: entryId,
            decision_id: decision.id
          },
          `drop-${entryId}`,
          { ...ctx, connection }
        )
      );
      await nativeCompetitionRuntimeService.processCompetition(
        first.id,
        firstDecision + 3 * 86400000
      );
      for (let index = 0; index < historyTables.length; index++) {
        const table = historyTables[index];
        expect(
          await sqlExecutor.execute(
            `SELECT * FROM ${table} WHERE competition_id=:id`,
            { id: first.id }
          )
        ).toEqual(before[index]);
      }
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
      ).rejects.toThrow('decision history');
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
