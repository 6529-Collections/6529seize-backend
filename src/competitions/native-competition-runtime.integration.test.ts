import { randomUUID } from 'node:crypto';
import { NewsletterDb } from '@/newsletter/newsletter.db';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  DROPS_TABLE,
  METRIC_ROLLUP_HOUR_TABLE,
  WAVES_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionRepository } from './competition.repository';
import { CompetitionExecutionRouter } from './competition-execution.router';
import { appFeatures } from '@/app-features';
import {
  CompetitionCreditBudget,
  competitionCreditService,
  CompetitionCreditService
} from './competition-credit.service';
import { competitionCreditRepository } from './competition-credit.repository';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { RequestContext } from '@/request.context';
import { competitionEventRepository } from './competition-event.repository';
import { competitionMainStageRepository } from './competition-main-stage.repository';
import { identitiesDb } from '@/identities/identities.db';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import {
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

const rankId = '10000000-0000-4000-8000-000000000001';
const approveId = '10000000-0000-4000-8000-000000000002';
const rankEntry = '20000000-0000-4000-8000-000000000001';
const secondRankEntry = '20000000-0000-4000-8000-000000000002';
const approveEntry = '20000000-0000-4000-8000-000000000003';

function competition(id: string, type: 'RANK' | 'APPROVE') {
  return {
    id,
    wave_id: 'shared-hub',
    legacy_wave_id: null,
    storage_mode: 'NATIVE',
    execution_mode: 'ACTIVE',
    type,
    lifecycle: 'PUBLISHED',
    title: type,
    description: null,
    config_version: 1,
    participation_config: {
      group_id: null,
      signature_required: false,
      max_entries_per_participant: null,
      required_metadata: [],
      required_media: [],
      submission_type: null,
      identity_submission_strategy: null,
      identity_submission_duplicates: null,
      starts_at: 0,
      ends_at: null,
      terms: null
    },
    voting_config: {
      group_id: null,
      credit_type: 'TDH',
      credit_scope: 'WAVE',
      credit_category: null,
      credit_creditor: null,
      credit_nfts: [],
      signature_required: false,
      starts_at: 0,
      ends_at: null,
      max_votes_per_identity_to_entry: null,
      forbid_negative_votes: false
    },
    decision_config: {
      strategy:
        type === 'RANK'
          ? {
              first_decision_time: 1000,
              subsequent_decisions: [],
              is_rolling: false
            }
          : null,
      next_decision_time: type === 'RANK' ? 1000 : null,
      time_lock_ms: null,
      winning_min_threshold: type === 'APPROVE' ? 10 : null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0,
      max_winners: type === 'APPROVE' ? 1 : null
    },
    winner_config: {
      max_winners: type === 'APPROVE' ? 1 : null,
      winning_min_threshold: type === 'APPROVE' ? 10 : null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0
    },
    outcome_config: [{ type: 'MANUAL', description: 'Winner', amount: 100 }],
    participation_starts_at: 0,
    participation_ends_at: null,
    voting_starts_at: 0,
    voting_ends_at: null,
    created_at: 0,
    updated_at: 0,
    published_at: 0,
    ended_at: null,
    cancelled_at: null,
    archived_at: null
  };
}

const entries = [
  {
    id: rankEntry,
    competition_id: rankId,
    drop_id: 'rank-drop',
    submitted_at: 1
  },
  {
    id: secondRankEntry,
    competition_id: rankId,
    drop_id: 'rank-drop-2',
    submitted_at: 2
  },
  {
    id: approveEntry,
    competition_id: approveId,
    drop_id: 'approve-drop',
    submitted_at: 1
  }
].map((entry) => ({
  ...entry,
  wave_id: 'shared-hub',
  submitter_id: 'artist',
  status: 'ACTIVE',
  config_version: 1
}));

describeWithSeed(
  'native competition execution isolation and retries',
  [
    withWaves([
      aWave(
        { created_by: 'artist' },
        { id: 'shared-hub', name: 'shared-hub', serial_no: 1 }
      ),
      aWave(
        { created_by: 'artist' },
        { id: 'parent-hub', name: 'parent-hub', serial_no: 2 }
      )
    ]),
    {
      table: COMPETITIONS_TABLE,
      rows: [competition(rankId, 'RANK'), competition(approveId, 'APPROVE')]
    },
    { table: COMPETITION_ENTRIES_TABLE, rows: entries },
    {
      table: DROPS_TABLE,
      rows: entries.map((entry) => ({
        id: entry.drop_id,
        wave_id: entry.wave_id,
        author_id: entry.submitter_id,
        created_at: entry.submitted_at,
        parts_count: 1,
        drop_type: 'COMPETITION'
      }))
    }
  ],
  () => {
    const repository = new NativeCompetitionRuntimeRepository(
      () => sqlExecutor
    );
    const getBudget = jest.fn() as jest.MockedFunction<
      CompetitionCreditService['getBudget']
    >;
    const getWaveBudgets = jest.fn() as jest.MockedFunction<
      CompetitionCreditService['getWaveBudgets']
    >;
    const service = new NativeCompetitionRuntimeService(
      repository,
      { getBudget, getWaveBudgets },
      new CompetitionExecutionRouter(competitionRepository, appFeatures),
      appFeatures
    );
    const originalFeature = process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;

    beforeEach(() => {
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      getBudget.mockReset();
      getBudget.mockImplementation(async (resource, profileId) => ({
        competition_id: resource.id,
        profile_id: profileId,
        entry_id: null,
        credit_type: 'TDH',
        credit_scope: 'WAVE',
        available: 100,
        spent: 0,
        remaining: 100,
        current_vote: null,
        min_vote: null,
        max_vote: null
      }));
      getWaveBudgets.mockReset();
      getWaveBudgets.mockImplementation(async (resource, profiles, ctx) => {
        const budgets = new Map<string, CompetitionCreditBudget>();
        for (const profile of profiles) {
          const budget = await getBudget(resource, profile, undefined, ctx);
          const spending = await competitionCreditRepository.getSpending(
            resource,
            profile,
            undefined,
            ctx
          );
          budgets.set(profile, {
            ...budget,
            spent: spending.namespace_spent,
            remaining: budget.available - spending.namespace_spent
          });
        }
        return budgets;
      });
    });
    afterEach(() => {
      if (originalFeature === undefined)
        delete process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
      else process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = originalFeature;
    });

    async function vote(
      competitionId: string,
      entryId: string,
      value: number,
      occurredAt: number,
      voterProfileId = 'voter'
    ): Promise<void> {
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await repository.lockCompetition(competitionId, ctx);
        const rows = await repository.getVoterActiveVotes(
          competitionId,
          voterProfileId,
          ctx
        );
        const previousVote =
          rows.find((row) => row.entryId === entryId)?.value ?? 0;
        await sqlExecutor.execute(
          `insert into ${COMPETITION_VOTES_TABLE}
        (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at)
        values (:id, :competitionId, :entryId, :voterProfileId, :value, abs(:value), :occurredAt, :occurredAt)
        on duplicate key update value = :value, credit_spent = abs(:value), updated_at = :occurredAt`,
          {
            id: randomUUID(),
            competitionId,
            entryId,
            voterProfileId,
            value,
            occurredAt
          },
          { wrappedConnection: connection }
        );
        await repository.recordVoteChange(
          {
            competitionId,
            entryId,
            voterProfileId,
            previousVote,
            value,
            occurredAt
          },
          ctx
        );
      });
    }

    async function largeLeaderboard() {
      await sqlExecutor.bulkInsert(
        COMPETITION_ENTRIES_TABLE,
        Array.from({ length: 473 }, (_, index) => ({
          ...entries[0],
          id: `batch-entry-${index}`,
          drop_id: `batch-drop-${index}`,
          submitted_at: index + 3
        })),
        Object.keys(entries[0])
      );
      const active = await repository.listActiveEntries(rankId, {});
      await sqlExecutor.bulkInsert(
        COMPETITION_ENTRY_RUNTIME_TABLE,
        active.map((entry, index) => ({
          competition_id: rankId,
          entry_id: entry.id,
          real_time_rating: index - 200,
          last_increased_at: 90,
          over_threshold_since: 5,
          updated_at: 10
        })),
        [
          'competition_id',
          'entry_id',
          'real_time_rating',
          'last_increased_at',
          'over_threshold_since',
          'updated_at'
        ]
      );
      return (await repository.listActiveEntries(rankId, {})).map(
        (entry, index) => ({
          entry,
          rating: index - 250,
          rank: index + 1,
          overThresholdSince: index % 2 === 0 ? null : 20,
          orderingTime: index % 2 === 0 ? undefined : 30,
          decisionRating: index % 2 === 0 ? undefined : index + 50
        })
      );
    }

    it('batches WAVE budgets and only reconciles voters over their shared credit', async () => {
      await vote(rankId, rankEntry, -60, 10, 'overspent');
      await vote(rankId, secondRankEntry, 60, 10, 'overspent');
      await vote(rankId, rankEntry, 100, 20, 'within-budget');
      const votes = jest.spyOn(repository, 'getVoterActiveVotes');
      try {
        await service.refreshCompetition(rankId, 500);
        expect(getWaveBudgets).toHaveBeenCalledTimes(1);
        expect(getWaveBudgets).toHaveBeenCalledWith(
          expect.objectContaining({ id: rankId }),
          ['overspent', 'within-budget'],
          expect.objectContaining({ connection: expect.anything() })
        );
        expect(votes.mock.calls.map((call) => call[1])).toEqual(['overspent']);
        expect(
          await repository.getVoterActiveVotes(rankId, 'overspent', {})
        ).toEqual([
          { entryId: rankEntry, value: -50 },
          { entryId: secondRankEntry, value: 50 }
        ]);
        expect(
          await repository.getVoterActiveVotes(rankId, 'within-budget', {})
        ).toEqual([{ entryId: rankEntry, value: 100 }]);
      } finally {
        votes.mockRestore();
      }
    });

    it('uses real batched credits to reconcile overspending and missing identities while preserving an exactly funded voter', async () => {
      const identities = ['overspent', 'within-budget'].map((profile, index) =>
        anIdentity(
          { tdh: 100 },
          {
            profile_id: profile,
            consolidation_key: profile,
            primary_address: `0x${(index + 1).toString(16).padStart(40, '0')}`,
            handle: profile
          }
        )
      );
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        identities,
        Object.keys(identities[0])
      );
      await vote(rankId, rankEntry, -60, 10, 'overspent');
      await vote(rankId, secondRankEntry, 60, 10, 'overspent');
      await vote(approveId, approveEntry, 90, 10, 'overspent');
      await vote(rankId, rankEntry, 100, 20, 'within-budget');
      await vote(rankId, rankEntry, 25, 30, 'missing-credit');
      const realRepository = new NativeCompetitionRuntimeRepository(
        () => sqlExecutor
      );
      const realService = new NativeCompetitionRuntimeService(
        realRepository,
        competitionCreditService,
        new CompetitionExecutionRouter(competitionRepository, appFeatures),
        appFeatures
      );
      const reads = jest.spyOn(realRepository, 'getVoterActiveVotes');
      try {
        await realService.refreshCompetition(rankId, 500);
        expect(reads.mock.calls.map((call) => call[1])).toEqual([
          'missing-credit',
          'overspent'
        ]);
      } finally {
        reads.mockRestore();
      }
      expect(
        await realRepository.getVoterActiveVotes(rankId, 'overspent', {})
      ).toEqual([
        { entryId: rankEntry, value: -50 },
        { entryId: secondRankEntry, value: 50 }
      ]);
      expect(
        await realRepository.getVoterActiveVotes(rankId, 'within-budget', {})
      ).toEqual([{ entryId: rankEntry, value: 100 }]);
      expect(
        await realRepository.getVoterActiveVotes(rankId, 'missing-credit', {})
      ).toEqual([{ entryId: rankEntry, value: 0 }]);
      expect(
        await realRepository.getVoterActiveVotes(approveId, 'overspent', {})
      ).toEqual([{ entryId: approveEntry, value: 90 }]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_VOTE_HISTORY_TABLE} where occurred_at = 500 and competition_id = :rankId`,
          { rankId }
        )
      ).toEqual([{ n: 3 }]);
    });

    it('still reconciles independent DROP budgets without a shared-spending shortcut', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set voting_config = json_set(voting_config, '$.credit_scope', 'DROP') where id = :rankId`,
        { rankId }
      );
      await vote(rankId, rankEntry, -120, 10);
      await vote(rankId, secondRankEntry, 80, 10);
      await service.refreshCompetition(rankId, 500);
      expect(getWaveBudgets).not.toHaveBeenCalled();
      expect(await repository.getVoterActiveVotes(rankId, 'voter', {})).toEqual(
        [
          { entryId: secondRankEntry, value: 80 },
          { entryId: rankEntry, value: -100 }
        ]
      );
    });

    it('retains published missing-entry snapshots while removing unpublished and inactive standings', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status='WITHDRAWN' where id=:id`,
        { id: secondRankEntry }
      );
      const snapshots = [
        {
          entry_id: randomUUID(),
          drop_id: 'retained-orphan',
          published_at: 12
        },
        {
          entry_id: randomUUID(),
          drop_id: 'unpublished-orphan',
          published_at: null
        },
        { entry_id: secondRankEntry, drop_id: 'rank-drop-2', published_at: 12 }
      ].map((row) => ({
        ...row,
        competition_id: rankId,
        rating: 40,
        real_time_rating: 40,
        rank: null,
        submitted_at: 12,
        updated_at: 12,
        ordering_time: 12,
        decision_rating: 90,
        over_threshold_since: null
      }));
      await sqlExecutor.bulkInsert(
        COMPETITION_LEADERBOARD_ENTRIES_TABLE,
        snapshots,
        Object.keys(snapshots[0])
      );
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await repository.lockCompetition(rankId, ctx);
        await repository.saveLeaderboard(rankId, [], 500, ctx);
      });
      expect(
        await sqlExecutor.execute(
          `select * from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:rankId`,
          { rankId }
        )
      ).toEqual([snapshots[0]]);
    });

    it('persists 475 leaderboard entries in bounded batches without replacing vote runtime fields', async () => {
      const rows = await largeLeaderboard();
      const batchRepository = new NativeCompetitionRuntimeRepository(
        () => sqlExecutor
      );
      const upsert = jest.spyOn(sqlExecutor, 'bulkUpsert');
      try {
        await batchRepository.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            await batchRepository.lockCompetition(rankId, ctx);
            await batchRepository.saveLeaderboard(rankId, rows, 500, ctx);
            // Exercise duplicate-key updates as well as initial insertion.
            await batchRepository.saveLeaderboard(
              rankId,
              rows.map((row) => ({ ...row, rating: row.rating + 1 })),
              600,
              ctx
            );
          }
        );
        expect(upsert).toHaveBeenCalledTimes(10);
        expect(upsert.mock.calls.map((call) => call[1].length)).toEqual([
          100, 100, 100, 100, 75, 100, 100, 100, 100, 75
        ]);
        const saved = await sqlExecutor.execute(
          `select * from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id = :rankId order by \`rank\``,
          { rankId }
        );
        expect(saved).toEqual(
          rows.map((row) => ({
            competition_id: rankId,
            entry_id: row.entry.id,
            drop_id: row.entry.drop_id,
            rating: row.rating + 1,
            real_time_rating: row.entry.real_time_rating,
            rank: row.rank,
            submitted_at: row.entry.submitted_at,
            updated_at: 600,
            ordering_time: row.orderingTime ?? 600,
            decision_rating: row.decisionRating ?? row.rating + 1,
            published_at: null,
            over_threshold_since: row.overThresholdSince
          }))
        );
        const runtime = await sqlExecutor.execute<{
          entry_id: string;
          over_threshold_since: number | null;
          updated_at: number;
          last_increased_at: number;
          real_time_rating: number;
        }>(
          `select * from ${COMPETITION_ENTRY_RUNTIME_TABLE} where competition_id = :rankId`,
          { rankId }
        );
        for (const row of rows) {
          expect(
            runtime.find((item) => item.entry_id === row.entry.id)
          ).toMatchObject({
            real_time_rating: row.entry.real_time_rating,
            over_threshold_since: row.overThresholdSince,
            last_increased_at: 90,
            updated_at: 10
          });
        }
      } finally {
        upsert.mockRestore();
      }
    });

    it('rolls back earlier leaderboard batches, thresholds and outbox events when a later batch fails', async () => {
      await largeLeaderboard();
      const batchRepository = new NativeCompetitionRuntimeRepository(
        () => sqlExecutor
      );
      const batchService = new NativeCompetitionRuntimeService(
        batchRepository,
        competitionCreditService,
        new CompetitionExecutionRouter(competitionRepository, appFeatures),
        appFeatures
      );
      const execute = sqlExecutor.execute.bind(sqlExecutor);
      let thresholdWrites = 0;
      const failure = jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation(async (...args) => {
          if (
            args[0].includes('set over_threshold_since = case') &&
            ++thresholdWrites === 2
          )
            throw new Error('Injected later batch failure');
          return execute(...args);
        });
      try {
        await expect(
          batchService.refreshCompetition(rankId, 500)
        ).rejects.toThrow('Injected later batch failure');
      } finally {
        failure.mockRestore();
      }
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
      expect(
        await sqlExecutor.execute(
          `select distinct over_threshold_since, updated_at from ${COMPETITION_ENTRY_RUNTIME_TABLE}`
        )
      ).toEqual([{ over_threshold_since: 5, updated_at: 10 }]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_OUTBOX_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
    });

    it.each([1, -1])(
      'rolls back a cross-voter aggregate outside the safe integer range with sign %s',
      async (sign) => {
        const value = sign * Number.MAX_SAFE_INTEGER;
        await vote(rankId, rankEntry, value, 100, 'first-voter');
        await expect(
          vote(rankId, rankEntry, sign * 2, 200, 'second-voter')
        ).rejects.toThrow('Entry aggregate vote');
        expect(
          await sqlExecutor.execute(
            `select voter_profile_id, value from ${COMPETITION_VOTES_TABLE}`
          )
        ).toEqual([{ voter_profile_id: 'first-voter', value }]);
        expect(
          await sqlExecutor.execute(
            `select aggregate_value from ${COMPETITION_VOTE_HISTORY_TABLE}`
          )
        ).toEqual([{ aggregate_value: value }]);
        expect(
          await sqlExecutor.execute(
            `select real_time_rating from ${COMPETITION_ENTRY_RUNTIME_TABLE}`
          )
        ).toEqual([{ real_time_rating: value }]);
        expect(
          await sqlExecutor.execute(
            `select count(*) as n from ${COMPETITION_OUTBOX_TABLE}`
          )
        ).toEqual([{ n: 1 }]);
      }
    );

    it('preserves representable boundary ratings on separate DROP entries even when their total exceeds the safe integer range', async () => {
      const value = Number.MAX_SAFE_INTEGER;
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set voting_config = json_set(voting_config, '$.credit_scope', 'DROP') where id = :rankId`,
        { rankId }
      );
      await vote(rankId, rankEntry, value, 100);
      await vote(rankId, secondRankEntry, value, 100);
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await repository.lockCompetition(rankId, ctx);
        await service.reconcileVoterCredit(
          {
            competitionId: rankId,
            voterProfileId: 'voter',
            availableCredit: value,
            creditScope: 'DROP',
            occurredAt: 101
          },
          ctx
        );
      });
      expect(await repository.listActiveEntries(rankId, {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: rankEntry, real_time_rating: value }),
          expect.objectContaining({
            id: secondRankEntry,
            real_time_rating: value
          })
        ])
      );
      // Exact cancellation across voters is valid; only the per-entry result is bounded.
      await vote(rankId, rankEntry, -value, 200, 'other-voter');
      expect(
        (await repository.listActiveEntries(rankId, {})).find(
          (entry) => entry.id === rankEntry
        )?.real_time_rating
      ).toBe(0);
    });

    it('keeps distinct extreme weighted scores in winner order and immutable voter snapshots', async () => {
      const value = Number.MAX_SAFE_INTEGER - 1;
      getBudget.mockResolvedValue({
        competition_id: rankId,
        profile_id: 'voter',
        entry_id: null,
        credit_type: 'TDH',
        credit_scope: 'WAVE',
        available: Number.MAX_SAFE_INTEGER,
        spent: 0,
        remaining: Number.MAX_SAFE_INTEGER,
        current_vote: null,
        min_vote: null,
        max_vote: null
      });
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = json_set(decision_config, '$.time_lock_ms', 2), outcome_config = :outcomes where id = :rankId`,
        {
          rankId,
          outcomes: JSON.stringify([
            { type: 'MANUAL', description: 'Prizes', distribution: [{}, {}] }
          ])
        }
      );
      await vote(rankId, rankEntry, value, 998, 'first-voter');
      await vote(rankId, rankEntry, value - 1, 999, 'first-voter');
      await vote(rankId, secondRankEntry, value, 998, 'second-voter');
      await service.processCompetition(rankId, 1001);
      expect(
        await sqlExecutor.execute(
          `select entry_id, final_rating from ${COMPETITION_DECISION_WINNERS_TABLE} order by \`rank\``
        )
      ).toEqual([
        { entry_id: secondRankEntry, final_rating: value },
        { entry_id: rankEntry, final_rating: value - 1 }
      ]);
      expect(
        await sqlExecutor.execute(
          `select entry_id, value from ${COMPETITION_WINNER_VOTES_TABLE} order by entry_id`
        )
      ).toEqual([
        { entry_id: rankEntry, value: value - 1 },
        { entry_id: secondRankEntry, value }
      ]);
    });

    it('finishes parallel Rank and Approve independently, preserves chat drops and emits immutable awards once', async () => {
      await vote(rankId, rankEntry, 80, 100);
      await vote(approveId, approveEntry, 80, 100);
      await sqlExecutor.execute(
        `insert into ${COMPETITION_CAPABILITIES_TABLE} (capability, competition_id, wave_id, assigned_at) values ('MAIN_STAGE', :rankId, 'shared-hub', 0)`,
        { rankId }
      );
      await Promise.all([
        service.processCompetition(rankId, 1001),
        service.processCompetition(approveId, 1001)
      ]);
      await service.processDueCompetitions({ now: 1100 });
      expect(
        await sqlExecutor.execute(
          `select lifecycle, actor_id from ${COMPETITION_LIFECYCLE_EVENTS_TABLE}`
        )
      ).toEqual([
        { lifecycle: 'ENDED', actor_id: null },
        { lifecycle: 'ENDED', actor_id: null }
      ]);
      const winners = await sqlExecutor.execute<{
        competition_id: string;
        entry_id: string;
        final_rating: number;
      }>(
        `select competition_id, entry_id, final_rating from ${COMPETITION_DECISION_WINNERS_TABLE} order by competition_id`
      );
      expect(winners).toEqual([
        { competition_id: rankId, entry_id: rankEntry, final_rating: 80 },
        { competition_id: approveId, entry_id: approveEntry, final_rating: 80 }
      ]);
      expect(
        await sqlExecutor.execute(`select drop_type from ${DROPS_TABLE}`)
      ).toEqual([
        { drop_type: 'COMPETITION' },
        { drop_type: 'COMPETITION' },
        { drop_type: 'COMPETITION' }
      ]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_OUTCOME_AWARDS_TABLE}`
        )
      ).toEqual([{ n: 2 }]);
      const decisions = await sqlExecutor.execute<{ id: string }>(
        `select id from ${COMPETITION_DECISIONS_TABLE}`
      );
      expect(
        await repository.listAwardsForDecisions(
          decisions.map((row) => row.id),
          {}
        )
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            amount: 100,
            description: 'Winner',
            entry_id: rankEntry
          })
        ])
      );
      const outbox = await repository.claimOutbox({ now: 2000, limit: 100 });
      const results = outbox.filter(
        (record) => record.event.event_type === 'COMPETITION_DECISION_COMPLETED'
      );
      expect(results).toHaveLength(2);
      expect(
        results.find((record) => record.event.competition_id === rankId)?.event
          .data.capabilities
      ).toEqual(['MAIN_STAGE']);
      expect(
        results.find((record) => record.event.competition_id === approveId)
          ?.event.data.capabilities
      ).toEqual([]);
    });

    it('serializes concurrent decision attempts and rolls every partial write back on failure', async () => {
      await vote(rankId, rankEntry, 20, 100);
      const original = repository.enqueueEvent.bind(repository);
      const spy = jest
        .spyOn(repository, 'enqueueEvent')
        .mockImplementation(async (event, ctx) => {
          if (event.event_type === 'COMPETITION_DECISION_COMPLETED')
            throw new Error('injected after awards');
          return original(event, ctx);
        });
      await expect(service.processCompetition(rankId, 1001)).rejects.toThrow(
        'injected'
      );
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISIONS_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_OUTCOME_AWARDS_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
      spy.mockRestore();
      await Promise.all([
        service.processCompetition(rankId, 1001),
        service.processCompetition(rankId, 1001)
      ]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISIONS_TABLE}`
        )
      ).toEqual([{ n: 1 }]);
    });

    it('uses scheduled historical weighted votes when execution is late and archives each voter independently', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = json_set(decision_config, '$.time_lock_ms', 1000) where id = :rankId`,
        { rankId }
      );
      await vote(rankId, rankEntry, 100, 500);
      await vote(rankId, secondRankEntry, 70, 1, 'other');
      await service.processCompetition(rankId, 3000);
      expect(
        await sqlExecutor.execute(
          `select entry_id, final_rating from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ entry_id: secondRankEntry, final_rating: 69 }]);
      expect(
        await sqlExecutor.execute(
          `select entry_id, voter_profile_id, value from ${COMPETITION_WINNER_VOTES_TABLE}`
        )
      ).toEqual([
        { entry_id: secondRankEntry, voter_profile_id: 'other', value: 69 }
      ]);
      const page = {
        offset: 0,
        limit: 10,
        sort: 'rating' as const,
        direction: 'DESC' as const
      };
      expect(
        (
          await competitionRepository.listNativeEntryVotes(
            rankId,
            secondRankEntry,
            page,
            {}
          )
        ).data[0].value
      ).toBe(69);
      expect(
        (
          await competitionRepository.listNativeVoters(
            rankId,
            page,
            {},
            secondRankEntry
          )
        ).data[0].votes
      ).toBe(69);
      expect(
        (
          await competitionRepository.listNativeVoters(rankId, page, {})
        ).data.find((row) => row.profile_id === 'other')?.votes
      ).toBe(70);
    });

    it('skips paused Rank occurrences and awards a later sequential occurrence without sharing another competition pause', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = json_set(decision_config, '$.strategy.subsequent_decisions', json_array(1000)) where id = :rankId`,
        { rankId }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_PAUSES_TABLE} (id, competition_id, start_time, end_time) values (:id, :rankId, 900, 1100)`,
        { id: randomUUID(), rankId }
      );
      await vote(rankId, rankEntry, 20, 100);
      await vote(approveId, approveEntry, 20, 100);
      await service.processCompetition(rankId, 2001);
      await service.processCompetition(approveId, 1001);
      expect(
        await sqlExecutor.execute(
          `select scheduled_at, status from ${COMPETITION_DECISIONS_TABLE} where competition_id = :rankId order by scheduled_at`,
          { rankId }
        )
      ).toEqual([
        { scheduled_at: 1000, status: 'CANCELLED' },
        { scheduled_at: 2000, status: 'COMPLETED' }
      ]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ n: 2 }]);
    });

    it('requires continuous Approve duration, retries stale threshold readings and respects boundary times', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set decision_config = json_set(decision_config, '$.time_lock_ms', 100, '$.winning_min_threshold', 50, '$.winning_threshold_min_duration_ms', 30) where id = :approveId`,
        { approveId }
      );
      await vote(approveId, approveEntry, 100, 10);
      await service.processCompetition(approveId, 89);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISIONS_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
      await service.processCompetition(approveId, 90);
      expect(
        await sqlExecutor.execute(
          `select final_rating from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ final_rating: 80 }]);
    });

    it('reconciles credit reductions within one namespace, retains history and releases winner spending', async () => {
      await vote(rankId, rankEntry, -60, 10);
      await vote(rankId, secondRankEntry, 40, 10);
      await vote(approveId, approveEntry, 90, 10);
      await repository.executeNativeQueriesInTransaction(async (connection) => {
        const ctx: RequestContext = { connection };
        await repository.lockCompetition(rankId, ctx);
        await service.reconcileVoterCredit(
          {
            competitionId: rankId,
            voterProfileId: 'voter',
            availableCredit: 50,
            creditScope: 'WAVE',
            occurredAt: 20
          },
          ctx
        );
      });
      expect(await repository.getVoterActiveVotes(rankId, 'voter', {})).toEqual(
        [
          { entryId: rankEntry, value: -30 },
          { entryId: secondRankEntry, value: 20 }
        ]
      );
      expect(
        await repository.getVoterActiveVotes(approveId, 'voter', {})
      ).toEqual([{ entryId: approveEntry, value: 90 }]);
      await service.processCompetition(rankId, 1001);
      expect(await repository.getVoterActiveVotes(rankId, 'voter', {})).toEqual(
        [{ entryId: rankEntry, value: -30 }]
      );
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_VOTE_HISTORY_TABLE}`
        )
      ).toEqual([{ n: 5 }]);
    });

    it('leaves cancelled, shadow and feature-disabled competitions untouched', async () => {
      await vote(rankId, rankEntry, 20, 100);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set lifecycle = 'CANCELLED' where id = :rankId`,
        { rankId }
      );
      await service.processCompetition(rankId, 1001);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set lifecycle = 'PUBLISHED', execution_mode = 'SHADOW' where id = :rankId`,
        { rankId }
      );
      await service.processCompetition(rankId, 1001);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set execution_mode = 'ACTIVE' where id = :rankId`,
        { rankId }
      );
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'false';
      await service.processCompetition(rankId, 1001);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISIONS_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
    });

    it('keeps visible ranks consistent with earlier increases while decision ties prefer latest changes', async () => {
      await vote(rankId, secondRankEntry, 20, 100, 'second');
      await vote(rankId, rankEntry, 20, 200);
      await service.refreshCompetition(rankId, 500);
      const page = {
        offset: 0,
        limit: 10,
        sort: 'rating' as const,
        direction: 'DESC' as const
      };
      expect(
        (
          await competitionRepository.listNativeLeaderboard(rankId, page, {})
        ).data.map((row) => [row.entry_id, row.rank])
      ).toEqual([
        [secondRankEntry, 1],
        [rankEntry, 2]
      ]);
      expect(
        (
          await competitionRepository.listNativeEntries(rankId, page, {})
        ).data.map((row) => [row.id, row.rank])
      ).toEqual([
        [secondRankEntry, 1],
        [rankEntry, 2]
      ]);
      await service.processCompetition(rankId, 1001);
      expect(
        await sqlExecutor.execute(
          `select entry_id from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ entry_id: rankEntry }]);
    });

    it('uses latest reconciled balance for delayed Rank without a time lock', async () => {
      await vote(rankId, rankEntry, 90, 100);
      await vote(rankId, secondRankEntry, 60, 100, 'other');
      const initial = getBudget.getMockImplementation()!;
      getBudget.mockImplementation(async (...args) => ({
        ...(await initial(...args)),
        available: args[1] === 'voter' ? 10 : 100
      }));
      await service.processCompetition(rankId, 3000);
      expect(
        await sqlExecutor.execute(
          `select entry_id, final_rating from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ entry_id: secondRankEntry, final_rating: 60 }]);
      expect(await repository.getVoterActiveVotes(rankId, 'voter', {})).toEqual(
        [{ entryId: rankEntry, value: 10 }]
      );
    });

    it('holds Approve during a paused final instant and formalizes accepted votes after resume', async () => {
      await vote(approveId, approveEntry, 80, 100);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set voting_config = json_set(voting_config, '$.ends_at', 1000), voting_ends_at = 1000 where id = :approveId`,
        { approveId }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_PAUSES_TABLE} (id, competition_id, start_time, end_time) values (:id, :approveId, 900, 1000)`,
        { id: randomUUID(), approveId }
      );
      await service.processCompetition(approveId, 1000);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ n: 0 }]);
      await service.processCompetition(approveId, 2000);
      await service.processCompetition(approveId, 3000);
      expect(
        await sqlExecutor.execute(
          `select lifecycle from ${COMPETITIONS_TABLE} where id = :approveId`,
          { approveId }
        )
      ).toEqual([{ lifecycle: 'ENDED' }]);
      expect(
        await sqlExecutor.execute(
          `select count(*) as n from ${COMPETITION_DECISION_WINNERS_TABLE}`
        )
      ).toEqual([{ n: 1 }]);
    });

    it.each([false, true])(
      'gates claims, badges, metrics and active TDH by explicit capability within the same wave (GET facade: %s)',
      async (useFacade) => {
        const readBadges = useFacade
          ? withLegacyCompetitionGetFacade
          : withoutLegacyCompetitionGetFacade;
        await sqlExecutor.execute(
          `insert into ${COMPETITION_CAPABILITIES_TABLE} (capability, competition_id, wave_id, assigned_at) values ('MAIN_STAGE', :rankId, 'shared-hub', 0)`,
          { rankId }
        );
        await vote(rankId, rankEntry, 80, 100);
        await vote(approveId, approveEntry, 90, 100);
        expect(
          await competitionMainStageRepository.totalActiveVotes(null, {})
        ).toBe(80);
        expect(
          await readBadges(() =>
            identitiesDb.getActiveMainStageDropIds(['artist'], {})
          )
        ).toEqual({ artist: ['rank-drop', 'rank-drop-2'] });
        await repository.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            await metricsRecorder.recordNativeCompetitionSubmission(
              { competitionId: rankId },
              ctx
            );
            await metricsRecorder.recordNativeCompetitionSubmission(
              { competitionId: approveId },
              ctx
            );
            await metricsRecorder.recordNativeCompetitionVote(
              { competitionId: rankId, voterId: 'voter', voteChange: 80 },
              ctx
            );
            await metricsRecorder.recordNativeCompetitionVote(
              { competitionId: approveId, voterId: 'voter', voteChange: 90 },
              ctx
            );
          }
        );
        expect(
          await sqlExecutor.execute(
            `select metric, event_count, value_sum from ${METRIC_ROLLUP_HOUR_TABLE} order by metric`
          )
        ).toEqual([
          { metric: 'MAIN_STAGE_SUBMISSION', event_count: 1, value_sum: 1 },
          { metric: 'MAIN_STAGE_VOTE', event_count: 1, value_sum: 80 }
        ]);
        await service.processCompetition(rankId, 1001);
        await service.processCompetition(approveId, 1001);
        expect(
          await competitionMainStageRepository.totalActiveVotes(null, {})
        ).toBe(0);
        expect(
          await readBadges(() =>
            identitiesDb.getMainStageWinnerDropIds(['artist'], {})
          )
        ).toEqual({ artist: ['rank-drop'] });
        const newsletter = new NewsletterDb(() => sqlExecutor);
        const newsletterWindow = { start: 0, end: 2000, scheduled: false };
        expect(
          (await newsletter.winners(newsletterWindow, {})).map((winner) => [
            winner.competition_id,
            winner.entry_id
          ])
        ).toEqual([[rankId, rankEntry]]);
        const decisions = await sqlExecutor.execute<{
          id: string;
          competition_id: string;
        }>(`select id, competition_id from ${COMPETITION_DECISIONS_TABLE}`);
        const decisionId = decisions.find(
          (row) => row.competition_id === rankId
        )!.id;
        const wrongDecisionId = decisions.find(
          (row) => row.competition_id === approveId
        )!.id;
        expect(
          await competitionEventRepository.getPrivilegedWinners(
            approveId,
            wrongDecisionId,
            {}
          )
        ).toEqual([]);
        await repository.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            const context = {
              competition_id: rankId,
              competition_entry_id: rankEntry,
              decision_id: decisionId
            };
            await competitionEventRepository.assertNativeClaim(
              context,
              'rank-drop',
              ctx
            );
            await competitionEventRepository.recordNativeClaim(
              context,
              'rank-drop',
              ctx
            );
            await competitionEventRepository.recordNativeClaim(
              context,
              'rank-drop',
              ctx
            );
            await memeCardDropMappingsDb.setMemeCardIdForDrop(
              'rank-drop',
              800,
              'unrelated-legacy-wave',
              ctx
            );
            expect(
              await memeCardDropMappingsDb.isMainStageWinnerDrop(
                'approve-drop',
                'unrelated-legacy-wave',
                ctx
              )
            ).toBe(false);
          }
        );
        expect(
          await memeCardDropMappingsDb.findByMemeCardId(
            800,
            'unrelated-legacy-wave',
            {}
          )
        ).toEqual({ drop_id: 'rank-drop', meme_card_id: 800 });
        expect(
          await memeCardDropMappingsDb.findMemeCardIdsByEntryIds(
            rankId,
            [rankEntry, secondRankEntry],
            {}
          )
        ).toEqual({ [rankEntry]: 800 });
        expect(
          await memeCardDropMappingsDb.findMemeCardIdsByEntryIds(
            approveId,
            [rankEntry, approveEntry],
            {}
          )
        ).toEqual({});
        await expect(
          repository.executeNativeQueriesInTransaction((connection) =>
            competitionEventRepository.assertNativeClaim(
              {
                competition_id: approveId,
                competition_entry_id: approveEntry,
                decision_id: wrongDecisionId
              },
              'approve-drop',
              { connection }
            )
          )
        ).rejects.toThrow('explicitly designated');
        await sqlExecutor.execute(
          `update ${WAVES_TABLE} set parent_wave_id = 'parent-hub' where id = 'shared-hub'`
        );
        await sqlExecutor.execute(
          `update ${WAVES_TABLE} set visibility_group_id = 'private' where id = 'parent-hub'`
        );
        expect(
          await competitionEventRepository.getPrivilegedWinners(
            rankId,
            decisionId,
            {}
          )
        ).toEqual([]);
        expect(
          await memeCardDropMappingsDb.findByMemeCardId(800, null, {})
        ).toBeNull();
        expect(
          await memeCardDropMappingsDb.findMemeCardIdsByEntryIds(
            rankId,
            [rankEntry],
            {}
          )
        ).toEqual({});
        expect(
          await readBadges(() =>
            identitiesDb.getMainStageWinnerDropIds(['artist'], {})
          )
        ).toEqual({});
        expect(await newsletter.winners(newsletterWindow, {})).toEqual([]);
        await sqlExecutor.execute(
          `update ${WAVES_TABLE} set visibility_group_id = null where id = 'parent-hub'`
        );
        await sqlExecutor.execute(
          `delete from ${COMPETITION_CAPABILITIES_TABLE} where competition_id = :rankId`,
          { rankId }
        );
        expect(
          await readBadges(() =>
            identitiesDb.getMainStageWinnerDropIds(['artist'], {})
          )
        ).toEqual({});
        expect(
          await memeCardDropMappingsDb.findByMemeCardId(
            800,
            'unrelated-legacy-wave',
            {}
          )
        ).toBeNull();
      }
    );

    it('attributes native badges to the submitter and excludes inactive or hidden submissions', async () => {
      await sqlExecutor.execute(
        `insert into ${COMPETITION_CAPABILITIES_TABLE} (capability, competition_id, wave_id, assigned_at) values ('MAIN_STAGE', :rankId, 'shared-hub', 0)`,
        { rankId }
      );
      await sqlExecutor.execute(
        `update ${DROPS_TABLE} set author_id = 'different-author'`
      );
      for (const read of [
        withoutLegacyCompetitionGetFacade,
        withLegacyCompetitionGetFacade
      ]) {
        expect(
          await read(() =>
            identitiesDb.getActiveMainStageDropIds(['artist'], {})
          )
        ).toEqual({ artist: ['rank-drop', 'rank-drop-2'] });
        expect(
          await read(() =>
            identitiesDb.getActiveMainStageDropIds(['different-author'], {})
          )
        ).toEqual({});
      }
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status = 'WITHDRAWN' where id = :rankEntry`,
        { rankEntry }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          identitiesDb.getActiveMainStageDropIds(['artist'], {})
        )
      ).toEqual({ artist: ['rank-drop-2'] });
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set lifecycle = 'ENDED' where id = :rankId`,
        { rankId }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          identitiesDb.getActiveMainStageDropIds(['artist'], {})
        )
      ).toEqual({});
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set lifecycle = 'PUBLISHED' where id = :rankId`,
        { rankId }
      );
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = 'private' where id = 'shared-hub'`
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          identitiesDb.getActiveMainStageDropIds(['artist'], {})
        )
      ).toEqual({});
    });

    it('preserves derived legacy badge types after native ownership without changing non-GET reads', async () => {
      const previousMainStageWave = process.env.MAIN_STAGE_WAVE_ID;
      process.env.MAIN_STAGE_WAVE_ID = 'shared-hub';
      try {
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set legacy_wave_id = wave_id where id = :rankId`,
          { rankId }
        );
        await sqlExecutor.execute(
          `update ${COMPETITION_ENTRIES_TABLE} set status = 'WINNER' where id = :rankEntry`,
          { rankEntry }
        );
        expect(
          await identitiesDb.getActiveMainStageDropIds(['artist'], {})
        ).toEqual({});
        expect(
          await identitiesDb.getMainStageWinnerDropIds(['artist'], {})
        ).toEqual({});
        expect(
          await withLegacyCompetitionGetFacade(() =>
            identitiesDb.getActiveMainStageDropIds(['artist'], {})
          )
        ).toEqual({ artist: ['rank-drop-2'] });
        expect(
          await withLegacyCompetitionGetFacade(() =>
            identitiesDb.getMainStageWinnerDropIds(['artist'], {})
          )
        ).toEqual({ artist: ['rank-drop'] });
        await sqlExecutor.execute(
          `update ${COMPETITION_ENTRIES_TABLE} set status = 'WITHDRAWN' where id = :secondRankEntry`,
          { secondRankEntry }
        );
        expect(
          await withLegacyCompetitionGetFacade(() =>
            identitiesDb.getActiveMainStageDropIds(['artist'], {})
          )
        ).toEqual({});
      } finally {
        if (previousMainStageWave === undefined)
          delete process.env.MAIN_STAGE_WAVE_ID;
        else process.env.MAIN_STAGE_WAVE_ID = previousMainStageWave;
      }
    });

    it('commits durable effect receipts once and rolls failed effects back', async () => {
      const eventId = randomUUID();
      const apply = jest.fn(async () => ['notification-id']);
      expect(
        await Promise.all([
          competitionEventRepository.applyEffect(
            eventId,
            'notify:artist',
            apply
          ),
          competitionEventRepository.applyEffect(
            eventId,
            'notify:artist',
            apply
          )
        ])
      ).toEqual([['notification-id'], ['notification-id']]);
      expect(apply).toHaveBeenCalledTimes(1);
      await expect(
        competitionEventRepository.applyEffect(eventId, 'fail', async () => {
          throw new Error('injected');
        })
      ).rejects.toThrow('injected');
      await expect(
        competitionEventRepository.applyEffect(eventId, 'fail', async () => 42)
      ).resolves.toBe(42);
    });

    it('leases durable delivery exclusively and recovers expiry without accepting a stale acknowledgement', async () => {
      await vote(rankId, rankEntry, 20, 100);
      const [first] = await repository.claimOutbox({
        now: 100,
        limit: 1,
        leaseMs: 10
      });
      expect(await repository.claimOutbox({ now: 105, limit: 1 })).toEqual([]);
      const [second] = await repository.claimOutbox({ now: 110, limit: 1 });
      expect(second.id).toBe(first.id);
      expect(second.lease_token).not.toBe(first.lease_token);
      await repository.acknowledgeOutbox(first.id, first.lease_token, 111);
      await repository.retryOutbox(second.id, second.lease_token, 111);
      expect(await repository.claimOutbox({ now: 112, limit: 1 })).toEqual([]);
      const [third] = await repository.claimOutbox({ now: 10_000, limit: 1 });
      await repository.acknowledgeOutbox(third.id, third.lease_token, 10_001);
      expect(
        await sqlExecutor.execute(
          `select delivered_at from ${COMPETITION_OUTBOX_TABLE} where id = :id`,
          { id: third.id }
        )
      ).toEqual([{ delivered_at: 10_001 }]);
    });
  }
);
