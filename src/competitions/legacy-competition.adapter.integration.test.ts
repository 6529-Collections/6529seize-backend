import { LegacyCompetitionBaselineRepository } from '@/competitions/legacy-competition-baseline.repository';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import {
  LEGACY_PARITY_ROW_LIMIT,
  loadLegacyParityCandidate
} from '@/competitions/legacy-parity-snapshot';
import { CompetitionRowLimitError } from '@/competitions/competition-page';
import { CompetitionService } from '@/competitions/competition.service';
import { CompetitionShadowComparator } from '@/competitions/competition-shadow-comparator';
import { CompetitionCursorCodec } from '@/competitions/competition-cursor';
import {
  COMPETITION_PARITY_OBSERVATIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  IDENTITIES_TABLE,
  RATINGS_TABLE,
  TDH_NFT_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE
} from '@/constants';
import {
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE
} from '@/constants';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { legacyCompetitionEntryId } from '@/competitions/competition-id';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropType } from '@/entities/IDrop';
import {
  WaveCreditScope,
  WaveCreditType,
  WaveOutcomeCredit,
  WaveOutcomeType,
  WaveType
} from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { wavesApiDb } from '@/api/waves/waves.api.db';

function withRows(table: string, rows: Record<string, unknown>[]): Seed {
  return { table, rows };
}

function drop(id: string, createdAt: number, type: DropType) {
  return {
    id,
    wave_id: 'wave-rank',
    author_id: `author-${id}`,
    created_at: createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: type,
    signature: null,
    hide_link_preview: false
  };
}

const wave = aWave(
  {
    type: WaveType.RANK,
    decisions_strategy: {
      first_decision_time: 1_000,
      subsequent_decisions: [],
      is_rolling: false
    },
    next_decision_time: null,
    participation_period_start: 1,
    participation_period_end: 10_000,
    voting_period_start: 1,
    voting_period_end: 10_000
  },
  { id: 'wave-rank', name: 'Rank fixture', serial_no: 1 }
);

describeWithSeed(
  'LegacyCompetitionAdapter parity',
  [
    withWaves([wave]),
    withRows(DROPS_TABLE, [
      drop('drop-high', 1, DropType.PARTICIPATORY),
      drop('drop-tie-older', 2, DropType.PARTICIPATORY),
      drop('drop-tie-newer', 3, DropType.PARTICIPATORY),
      drop('drop-winner', 4, DropType.WINNER)
    ]),
    withRows(DROP_RANK_TABLE, [
      {
        drop_id: 'drop-high',
        wave_id: wave.id,
        vote: 60,
        last_increased: 90
      },
      {
        drop_id: 'drop-tie-older',
        wave_id: wave.id,
        vote: 55,
        last_increased: 100
      },
      {
        drop_id: 'drop-tie-newer',
        wave_id: wave.id,
        vote: 55,
        last_increased: 101
      }
    ]),
    withRows(DROP_VOTER_STATE_TABLE, [
      {
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        votes: 7,
        wave_id: wave.id
      }
    ]),
    withRows(DROPS_VOTES_CREDIT_SPENDINGS_TABLE, [
      {
        id: 1,
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        credit_spent: 3,
        created_at: 100,
        wave_id: wave.id
      },
      {
        id: 2,
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        credit_spent: 4,
        created_at: 101,
        wave_id: wave.id
      }
    ]),
    withRows(WAVES_DECISIONS_TABLE, [
      { wave_id: wave.id, decision_time: 1_000 },
      { wave_id: wave.id, decision_time: 2_000 },
      { wave_id: wave.id, decision_time: 3_000 }
    ]),
    withRows(WAVES_DECISION_WINNER_DROPS_TABLE, [
      {
        wave_id: wave.id,
        decision_time: 1_000,
        drop_id: 'drop-winner',
        ranking: 1,
        final_vote: 144,
        prizes: []
      }
    ]),
    withRows(WAVE_OUTCOMES_TABLE, [
      {
        wave_id: wave.id,
        wave_outcome_position: 1,
        type: WaveOutcomeType.MANUAL,
        subtype: null,
        description: 'Winner award',
        credit: WaveOutcomeCredit.CIC,
        rep_category: 'Builder',
        amount: 10
      }
    ]),
    withRows(WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE, [
      {
        wave_id: wave.id,
        wave_outcome_position: 1,
        wave_outcome_distribution_item_position: 1,
        amount: 10,
        description: null
      }
    ]),
    withRows(WAVES_DECISION_PAUSES_TABLE, [
      { id: 1, wave_id: wave.id, start_time: 500, end_time: 600 }
    ])
  ],
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);

    async function adapter() {
      await repository.backfillLegacyMappings({});
      const [record] = await repository.listCompetitionRecordsForWave(
        wave.id,
        {}
      );
      if (!record) throw new Error('Missing mapping');
      return {
        record,
        reader: new LegacyCompetitionAdapter(repository, wavesApiDb, {})
      };
    }

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.MAIN_STAGE_WAVE_ID;
    });

    it('matches independently read legacy rows across every supported parity surface', async () => {
      process.env.MAIN_STAGE_WAVE_ID = wave.id;
      const { record, reader } = await adapter();
      const baseline = new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      );
      const expected = await baseline.getSnapshot(record, 5_000, {});
      const candidate = await loadLegacyParityCandidate(
        reader,
        record,
        5_000,
        {}
      );
      expect(candidate).toEqual(expected);
    });

    it('preserves the existing zero-end sentinel in the parity projection', async () => {
      await sqlExecutor.execute(
        'update waves set participation_period_end = 0, voting_period_end = 0 where id = :id',
        { id: wave.id }
      );
      const { record, reader } = await adapter();
      const baseline = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, 5_000, {});
      expect(baseline.configuration).toMatchObject({ ended_at: null });
      expect(
        await loadLegacyParityCandidate(reader, record, 5_000, {})
      ).toEqual(baseline);
    });

    it.each([WaveCreditScope.WAVE, WaveCreditScope.DROP])(
      'independently verifies available and remaining credit with %s scope',
      async (scope) => {
        await sqlExecutor.execute(
          `insert into ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw) values ('parity-budget', 'profile-voter', 'parity-wallet', 100, 0, 0, 0)`
        );
        await sqlExecutor.execute(
          'update waves set voting_credit_scope = :scope where id = :id',
          { scope, id: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${DROP_VOTER_STATE_TABLE} (voter_id, drop_id, wave_id, votes) values ('profile-voter', 'drop-tie-older', :waveId, -13), ('profile-voter', 'drop-winner', :waveId, 90)`,
          { waveId: wave.id }
        );
        const { record, reader } = await adapter();
        const baseline = await new LegacyCompetitionBaselineRepository(
          () => sqlExecutor
        ).getSnapshot(record, 5_000, {});
        const candidate = await loadLegacyParityCandidate(
          reader,
          record,
          5_000,
          {}
        );
        expect(candidate.credit_budgets).toEqual(baseline.credit_budgets);
        expect(baseline.credit_budgets).toEqual(
          scope === WaveCreditScope.WAVE
            ? [
                {
                  profile_id: 'profile-voter',
                  drop_id: null,
                  available: 100,
                  spent: 20,
                  remaining: 80
                }
              ]
            : [
                {
                  profile_id: 'profile-voter',
                  drop_id: 'drop-high',
                  available: 100,
                  spent: 7,
                  remaining: 93
                },
                {
                  profile_id: 'profile-voter',
                  drop_id: 'drop-tie-older',
                  available: 100,
                  spent: 13,
                  remaining: 87
                }
              ]
        );
        const original = competitionCreditService.getBudget.bind(
          competitionCreditService
        );
        jest
          .spyOn(competitionCreditService, 'getBudget')
          .mockImplementation(async (...args) => ({
            ...(await original(...args)),
            remaining: 999
          }));
        const corrupted = await loadLegacyParityCandidate(
          reader,
          record,
          5_000,
          {}
        );
        expect(corrupted.votes_and_credits).toEqual(baseline.votes_and_credits);
        expect(corrupted.credit_budgets).not.toEqual(baseline.credit_budgets);
        const independent = await new LegacyCompetitionBaselineRepository(
          () => sqlExecutor
        ).getSnapshot(record, 5_000, {});
        expect(independent.credit_budgets).toEqual(baseline.credit_budgets);
      }
    );

    it.each([
      [WaveCreditType.TDH, 100],
      [WaveCreditType.XTDH, 12],
      [WaveCreditType.TDH_PLUS_XTDH, 112],
      [WaveCreditType.REP, 81],
      [WaveCreditType.CARD_SET_TDH, 91]
    ])(
      'independently derives %s budget availability',
      async (creditType, expectedAvailable) => {
        await sqlExecutor.execute(
          `insert into ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, xtdh, rep, cic, level_raw) values ('parity-budget', 'profile-voter', 'parity-wallet', 100, 12.75, 0, 0, 0)`
        );
        await sqlExecutor.execute(
          'update waves set voting_credit_type = :creditType, voting_credit_category = :category, voting_credit_creditor = :creditor where id = :id',
          { creditType, category: 'art', creditor: 'curator', id: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${RATINGS_TABLE} (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified) values ('curator', 'profile-voter', 'REP', 'art', 81, now()), ('someone-else', 'profile-voter', 'REP', 'art', 800, now()), ('curator', 'profile-voter', 'CIC', 'art', 999, now())`
        );
        const contract = `0x${'c'.repeat(40)}`;
        await sqlExecutor.execute(
          `insert into ${WAVE_VOTING_CREDIT_NFTS_TABLE} (wave_id, contract, token_id) values (:waveId, :contract, 1)`,
          { waveId: wave.id, contract }
        );
        await sqlExecutor.execute(
          `insert into ${TDH_NFT_TABLE} (id, contract, consolidation_key, balance, tdh, boost, boosted_tdh, tdh__raw, tdh_rank) values (1, :contract, 'parity-budget', 1, 91, 1, 91, 91, 1), (2, :contract, 'parity-budget', 1, 999, 1, 999, 999, 1)`,
          { contract }
        );
        const { record, reader } = await adapter();
        const baseline = await new LegacyCompetitionBaselineRepository(
          () => sqlExecutor
        ).getSnapshot(record, 5_000, {});
        const candidate = await loadLegacyParityCandidate(
          reader,
          record,
          5_000,
          {}
        );
        expect(candidate.credit_budgets).toEqual(baseline.credit_budgets);
        expect(baseline.credit_budgets).toEqual([
          {
            profile_id: 'profile-voter',
            drop_id: null,
            available: expectedAvailable,
            spent: 7,
            remaining: Number(expectedAvailable) - 7
          }
        ]);
      }
    );

    it('rejects over-limit source rows on both sides without recording truncated parity', async () => {
      await sqlExecutor.bulkInsert(
        DROPS_TABLE,
        Array.from({ length: LEGACY_PARITY_ROW_LIMIT + 1 - 4 }, (_, index) =>
          drop(`limit-${index}`, index + 10, DropType.PARTICIPATORY)
        ),
        Object.keys(drop('template', 0, DropType.PARTICIPATORY)),
        {}
      );
      const { record, reader } = await adapter();
      await expect(
        new LegacyCompetitionBaselineRepository(() => sqlExecutor).getSnapshot(
          record,
          5_000,
          {}
        )
      ).rejects.toBeInstanceOf(CompetitionRowLimitError);
      await expect(
        loadLegacyParityCandidate(reader, record, 5_000, {})
      ).rejects.toBeInstanceOf(CompetitionRowLimitError);
      expect(
        await sqlExecutor.execute(
          `select id from ${COMPETITION_PARITY_OBSERVATIONS_TABLE}`
        )
      ).toEqual([]);
    });

    it('rejects duplicate voter state pairs so spending cannot be counted twice', async () => {
      await expect(
        sqlExecutor.execute(
          `insert into ${DROP_VOTER_STATE_TABLE} (voter_id,drop_id,votes,wave_id) values ('profile-voter','drop-high',8,:id)`,
          { id: wave.id }
        )
      ).rejects.toThrow();
      const { record, reader } = await adapter();
      const baseline = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, 5_000, {});
      expect(baseline.votes_and_credits).toEqual([
        { profile_id: 'profile-voter', votes: 7, credit_spent: 7 }
      ]);
      expect(
        await loadLegacyParityCandidate(reader, record, 5_000, {})
      ).toEqual(baseline);
    });

    it.each(['slow-query', 'stalled-reader'])(
      'bounds a %s sample and releases capacity for the next request',
      async (failure) => {
        const { record } = await adapter();
        const logger = { info: jest.fn(), warn: jest.fn() };
        const comparator = new CompetitionShadowComparator(
          repository,
          {
            isLegacyCompetitionShadowCompareEnabled: () => true,
            getLegacyCompetitionShadowSampleRate: () => 1
          } as never,
          logger
        );
        const candidate = jest.fn(async (ctx, now) =>
          loadLegacyParityCandidate(
            new LegacyCompetitionAdapter(repository, wavesApiDb, ctx),
            record,
            now,
            ctx
          )
        );
        const baseline = new LegacyCompetitionBaselineRepository(
          () => sqlExecutor
        );
        const started = Date.now();
        await expect(
          comparator.compareIfSampled(
            record,
            async (ctx, now) => {
              if (failure === 'slow-query')
                await sqlExecutor.execute('select sleep(5)', undefined, {
                  wrappedConnection: ctx.connection
                });
              else await new Promise<void>(() => {});
              return baseline.getSnapshot(record, now, ctx);
            },
            candidate,
            {}
          )
        ).resolves.toBe(false);
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(candidate).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('reason=deadline_exceeded')
        );
        expect(
          await sqlExecutor.execute(
            `select id from ${COMPETITION_PARITY_OBSERVATIONS_TABLE}`
          )
        ).toEqual([]);
        await expect(
          comparator.compareIfSampled(
            record,
            (ctx, now) => baseline.getSnapshot(record, now, ctx),
            candidate,
            {}
          )
        ).resolves.toBe(true);
        expect(
          await sqlExecutor.execute(
            `select id from ${COMPETITION_PARITY_OBSERVATIONS_TABLE}`
          )
        ).toHaveLength(13);
      }
    );

    it.each([false, true])(
      'compares time-locked leaderboards with snapshots present=%s',
      async (hasSnapshot) => {
        await sqlExecutor.execute(
          'update waves set time_lock_ms = 1000 where id = :id',
          { id: wave.id }
        );
        if (hasSnapshot)
          await sqlExecutor.execute(
            `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (wave_id, drop_id, vote, timestamp) values (:id, 'drop-high', 4, 50)`,
            { id: wave.id }
          );
        const { record, reader } = await adapter();
        const expected = await new LegacyCompetitionBaselineRepository(
          () => sqlExecutor
        ).getSnapshot(record, 5_000, {});
        expect(
          await loadLegacyParityCandidate(reader, record, 5_000, {})
        ).toEqual(expected);
      }
    );

    it('the real service detects unified query drift while returning its normal response', async () => {
      const { record } = await adapter();
      const original = repository.listLegacyLeaderboard.bind(repository);
      jest
        .spyOn(repository, 'listLegacyLeaderboard')
        .mockImplementation(async (...args) => {
          const page = await original(...args);
          return {
            ...page,
            data: page.data.map((entry) => ({
              ...entry,
              rating: entry.rating + 1
            }))
          };
        });
      const features = {
        isUnifiedCompetitionReadsEnabled: () => true,
        isLegacyCompetitionShadowCompareEnabled: () => true,
        getLegacyCompetitionShadowSampleRate: () => 1,
        isNativeCompetitionWritesEnabled: () => false
      };
      const comparator = new CompetitionShadowComparator(
        repository,
        features as never,
        { info: jest.fn(), warn: jest.fn() }
      );
      const service = new CompetitionService(
        repository,
        wavesApiDb,
        { getGroupsUserIsEligibleFor: async () => [] } as never,
        features as never,
        new CompetitionCursorCodec(),
        comparator
      );
      await expect(
        service.getCompetition(wave.id, record.id, {})
      ).resolves.toMatchObject({ id: record.id, title: wave.name });
      const observations = await sqlExecutor.execute<{
        category: string;
        matched: number;
      }>(
        `select category, matched from ${COMPETITION_PARITY_OBSERVATIONS_TABLE}`
      );
      expect(observations).toHaveLength(13);
      expect(
        observations
          .filter((row) => !row.matched)
          .map((row) => row.category)
          .sort((a, b) => a.localeCompare(b))
      ).toEqual(['LEADERBOARD_FIELD', 'LEADERBOARD_ORDER']);
    });

    it('does not accept corrupted capability mappings as their own baseline', async () => {
      process.env.MAIN_STAGE_WAVE_ID = wave.id;
      const { record, reader } = await adapter();
      await sqlExecutor.execute(
        `delete from ${COMPETITION_CAPABILITIES_TABLE} where competition_id = :id`,
        { id: record.id }
      );
      const expected = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, 5_000, {});
      const candidate = await loadLegacyParityCandidate(
        reader,
        record,
        5_000,
        {}
      );
      expect(expected.capabilities).toEqual(['MAIN_STAGE']);
      expect(candidate.capabilities).toEqual([]);
    });

    it('compares an Approve wave and crosses the 500-entry page boundary', async () => {
      await sqlExecutor.execute(
        'update waves set type = :type, winning_min_threshold = 10 where id = :id',
        { type: WaveType.APPROVE, id: wave.id }
      );
      const more = Array.from({ length: 501 }, (_, index) =>
        drop(
          `extra-${index.toString().padStart(4, '0')}`,
          index + 100,
          DropType.PARTICIPATORY
        )
      );
      await sqlExecutor.bulkInsert(
        DROPS_TABLE,
        more,
        Object.keys(more[0]!),
        {}
      );
      const { record, reader } = await adapter();
      const baseline = await new LegacyCompetitionBaselineRepository(
        () => sqlExecutor
      ).getSnapshot(record, 5_000, {});
      const candidate = await loadLegacyParityCandidate(
        reader,
        record,
        5_000,
        {}
      );
      expect(candidate.entries).toHaveLength(505);
      expect(candidate).toEqual(baseline);
    });

    it('does not manufacture mismatches when votes change during a sample', async () => {
      const { record } = await adapter();
      await repository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const baseline = await new LegacyCompetitionBaselineRepository(
            () => sqlExecutor
          ).getSnapshot(record, 5_000, ctx);
          await sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes = 99 where wave_id = :id`,
            { id: wave.id }
          );
          const candidate = await loadLegacyParityCandidate(
            new LegacyCompetitionAdapter(repository, wavesApiDb, ctx),
            record,
            5_000,
            ctx
          );
          expect(candidate).toEqual(baseline);
        },
        { isolationLevel: 'REPEATABLE READ' }
      );
    });

    it('rolls back partial observations when persistence fails', async () => {
      const { record, reader } = await adapter();
      const original = repository.recordParityObservation.bind(repository);
      let inserts = 0;
      jest
        .spyOn(repository, 'recordParityObservation')
        .mockImplementation(async (...args) => {
          if (++inserts === 4) throw new Error('simulated insert failure');
          await original(...args);
        });
      const comparator = new CompetitionShadowComparator(
        repository,
        {
          isLegacyCompetitionShadowCompareEnabled: () => true,
          getLegacyCompetitionShadowSampleRate: () => 1
        } as never,
        { info: jest.fn(), warn: jest.fn() }
      );
      await expect(
        comparator.compareIfSampled(
          record,
          (ctx, now) =>
            new LegacyCompetitionBaselineRepository(
              () => sqlExecutor
            ).getSnapshot(record, now, ctx),
          (ctx, now) =>
            loadLegacyParityCandidate(
              new LegacyCompetitionAdapter(repository, wavesApiDb, ctx),
              record,
              now,
              ctx
            ),
          {}
        )
      ).resolves.toBe(false);
      expect(
        await sqlExecutor.execute(
          `select id from ${COMPETITION_PARITY_OBSERVATIONS_TABLE}`
        )
      ).toEqual([]);
    });

    it('preserves leaderboard tie order and cursor-safe page boundaries', async () => {
      const { record, reader } = await adapter();
      const first = await reader.listLeaderboard(record, {
        offset: 0,
        limit: 2,
        direction: 'DESC'
      });
      const second = await reader.listLeaderboard(record, {
        offset: 2,
        limit: 2,
        direction: 'DESC'
      });
      expect(first.data.map((item) => item.drop_id)).toEqual([
        'drop-high',
        'drop-tie-older'
      ]);
      expect(first.data.map((item) => item.rank)).toEqual([1, 2]);
      expect(first.has_more).toBe(true);
      expect(second.data.map((item) => item.drop_id)).toEqual([
        'drop-tie-newer'
      ]);
      expect(second.data[0]?.rank).toBe(3);
      expect(
        new Set([...first.data, ...second.data].map((item) => item.entry_id))
          .size
      ).toBe(3);
    });

    it('orders legacy entries by approved rating and rank projections', async () => {
      const { record, reader } = await adapter();
      const byRating = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'DESC',
        sort: 'rating'
      });
      const byRank = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'ASC',
        sort: 'rank'
      });
      expect(byRating.data.map((entry) => entry.drop_id)).toEqual([
        'drop-high',
        'drop-tie-older',
        'drop-tie-newer',
        'drop-winner'
      ]);
      expect(byRank.data.slice(0, 2).map((entry) => entry.rank)).toEqual([
        1, 1
      ]);
      expect(byRank.data.at(-1)?.rank).toBe(3);
    });

    it('preserves winner, decision, outcome, distribution, and pause context', async () => {
      const { record, reader } = await adapter();
      const request = { offset: 0, limit: 50, direction: 'ASC' as const };
      const [winners, decisions, outcomes, pauses] = await Promise.all([
        reader.listWinners(record, request),
        reader.listDecisions(record, request),
        reader.listOutcomes(record, request),
        reader.listPauses(record, request)
      ]);
      expect(winners.data[0]).toMatchObject({
        drop_id: 'drop-winner',
        status: CompetitionEntryStatus.WINNER,
        rank: 1,
        won_at: 1_000
      });
      expect(decisions.data[0]).toMatchObject({
        scheduled_at: 1_000,
        winners: [
          {
            entry_id: legacyCompetitionEntryId(record.id, 'drop-winner'),
            rank: 1,
            final_rating: 144
          }
        ]
      });
      expect(outcomes.data[0]).toMatchObject({
        position: 1,
        legacy_index: 1,
        description: 'Winner award'
      });
      const distribution = await reader.listDistribution(
        record,
        outcomes.data[0]!.id,
        request
      );
      expect(distribution.data).toHaveLength(1);
      expect(pauses.data[0]).toMatchObject({ start_time: 500, end_time: 600 });
    });

    it('paginates decision rounds before fetching their winners', async () => {
      const { record, reader } = await adapter();
      const first = await reader.listDecisions(record, {
        offset: 0,
        limit: 1,
        direction: 'ASC'
      });
      const second = await reader.listDecisions(record, {
        offset: 1,
        limit: 1,
        direction: 'ASC'
      });
      const last = await reader.listDecisions(record, {
        offset: 2,
        limit: 1,
        direction: 'ASC'
      });

      expect(first).toMatchObject({
        data: [{ scheduled_at: 1_000, winners: [{ rank: 1 }] }],
        has_more: true
      });
      expect(second).toMatchObject({
        data: [{ scheduled_at: 2_000, winners: [] }],
        has_more: true
      });
      expect(last).toMatchObject({
        data: [{ scheduled_at: 3_000, winners: [] }],
        has_more: false
      });
    });

    it('preserves vote totals and sums credit spend without multiplying votes', async () => {
      const { record, reader } = await adapter();
      const entryId = legacyCompetitionEntryId(record.id, 'drop-high');
      const request = { offset: 0, limit: 50, direction: 'DESC' as const };
      const [voters, votes] = await Promise.all([
        reader.listVoters(record, request, entryId),
        reader.listEntryVotes(record, entryId, request)
      ]);
      expect(voters.data).toEqual([
        { profile_id: 'profile-voter', votes: 7, credit_spent: 7 }
      ]);
      expect(votes.data[0]).toMatchObject({
        voter_profile_id: 'profile-voter',
        value: 7,
        credit_spent: 7,
        created_at: 100
      });
    });

    it('binds legacy entries to the configuration version at submission time', async () => {
      const { record, reader } = await adapter();
      await repository.ensureLegacyMappingForWave(
        { ...wave, updated_at: 3 },
        {}
      );
      const entries = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'ASC'
      });
      expect(
        Object.fromEntries(
          entries.data.map((entry) => [entry.drop_id, entry.config_version])
        )
      ).toMatchObject({
        'drop-high': 1,
        'drop-tie-older': 1,
        'drop-tie-newer': 2,
        'drop-winner': 2
      });
    });
  }
);
