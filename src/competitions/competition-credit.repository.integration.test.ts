import { randomUUID } from 'node:crypto';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  RATINGS_TABLE,
  TDH_NFT_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import {
  CompetitionEntryStatus,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { identitiesDb } from '@/identities/identities.db';
import { competitionCreditRepository } from './competition-credit.repository';
import { competitionTdhOvervotesDb } from './competition-tdh-overvotes.db';

const profileId = 'budget-voter';
const waveId = 'shared-wave';
const nativeId = 'budget-native';
const originalPrimaryId = 'budget-original-primary';
const entry = {
  id: 'entry-a',
  drop_id: 'drop-a',
  status: CompetitionEntryStatus.ACTIVE
};
const native = {
  id: nativeId,
  wave_id: waveId,
  storage_mode: CompetitionStorageMode.NATIVE,
  voting: {
    group_id: null,
    credit_type: WaveCreditType.TDH,
    credit_scope: WaveCreditScope.WAVE,
    credit_category: null,
    credit_creditor: null,
    credit_nfts: [],
    signature_required: false,
    starts_at: null,
    ends_at: null,
    max_votes_per_identity_to_entry: null,
    forbid_negative_votes: false
  }
};
const identity = anIdentity(
  { tdh: 100, xtdh: 12.75 },
  {
    profile_id: profileId,
    consolidation_key: 'budget-key',
    primary_address: `0x${'a'.repeat(40)}`,
    handle: 'budget-voter'
  }
);
const nativeEntries = [
  {
    id: entry.id,
    competition_id: nativeId,
    status: CompetitionEntryStatus.ACTIVE
  },
  {
    id: 'entry-b',
    competition_id: nativeId,
    status: CompetitionEntryStatus.ACTIVE
  },
  {
    id: 'entry-winner',
    competition_id: nativeId,
    status: CompetitionEntryStatus.WINNER
  },
  {
    id: 'entry-withdrawn',
    competition_id: nativeId,
    status: CompetitionEntryStatus.WITHDRAWN
  },
  {
    id: 'entry-disqualified',
    competition_id: nativeId,
    status: CompetitionEntryStatus.DISQUALIFIED
  },
  {
    id: 'entry-other-competition',
    competition_id: 'parallel-native',
    status: CompetitionEntryStatus.ACTIVE
  }
];
const nativeValues = [-20, 30, 45, 50, 60, 70];
const originalPrimaryEntries = [
  {
    id: 'original-entry-a',
    drop_id: 'legacy-a',
    competition_id: originalPrimaryId,
    status: CompetitionEntryStatus.ACTIVE
  },
  {
    id: 'original-entry-b',
    drop_id: 'legacy-b',
    competition_id: originalPrimaryId,
    status: CompetitionEntryStatus.ACTIVE
  },
  {
    id: 'original-entry-winner',
    drop_id: 'legacy-winner',
    competition_id: originalPrimaryId,
    status: CompetitionEntryStatus.WINNER
  }
];
const currentEntries = [
  ...nativeEntries.map((item) => ({
    ...item,
    drop_id: item.id === entry.id ? entry.drop_id : `drop-${item.id}`
  })),
  ...originalPrimaryEntries
];
const currentValues = [...nativeValues, 10, -15, 100];
// Retained shared rows deliberately disagree with native membership and votes.
const legacyDrops = [
  { id: 'legacy-a', drop_type: 'WINNER' },
  { id: 'legacy-b', drop_type: 'CHAT' },
  { id: 'legacy-winner', drop_type: 'PARTICIPATORY' }
];

describeWithSeed(
  'Competition credit isolation and transaction accounting',
  [
    withIdentities([identity]),
    {
      table: COMPETITIONS_TABLE,
      rows: [nativeId, 'parallel-native', originalPrimaryId].map((id) => ({
        id,
        wave_id: waveId,
        legacy_wave_id: id === originalPrimaryId ? waveId : null,
        storage_mode: 'NATIVE',
        execution_mode: 'ACTIVE',
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        title: 'Budget fixture',
        participation_config: {},
        voting_config: native.voting,
        decision_config: {},
        winner_config: {},
        outcome_config: [],
        created_at: 1,
        updated_at: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: currentEntries.map((item) => ({
        ...item,
        wave_id: waveId,
        submitter_id: 'submitter',
        config_version: 1,
        submitted_at: 1
      }))
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: currentEntries.map((item, index) => ({
        id: `vote-${index}`,
        competition_id: item.competition_id,
        entry_id: item.id,
        voter_profile_id: profileId,
        value: currentValues[index],
        credit_spent: Math.abs(currentValues[index]),
        created_at: 1,
        updated_at: 1
      }))
    },
    {
      table: DROPS_TABLE,
      rows: legacyDrops.map((item) => ({
        ...item,
        wave_id: waveId,
        author_id: 'submitter',
        created_at: 1,
        updated_at: null,
        title: null,
        parts_count: 1,
        reply_to_drop_id: null,
        reply_to_part_id: null,
        signature: null,
        hide_link_preview: false
      }))
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: legacyDrops.map((item, index) => ({
        voter_id: profileId,
        drop_id: item.id,
        wave_id: waveId,
        votes: [91, -92, 1_000][index]
      }))
    }
  ],
  () => {
    it('isolates two native siblings and their native original primary from stale physical votes', async () => {
      expect(
        await competitionCreditService.getBudget(native, profileId, entry, {})
      ).toMatchObject({
        available: 100,
        spent: 50,
        remaining: 50,
        current_vote: -20,
        min_vote: -70,
        max_vote: 70
      });
      expect(
        await competitionCreditService.getBudget(
          { ...native, id: 'parallel-native' },
          profileId,
          undefined,
          {}
        )
      ).toMatchObject({ available: 100, spent: 70, remaining: 30 });
      expect(
        await competitionCreditService.getBudget(
          {
            ...native,
            id: originalPrimaryId
          },
          profileId,
          originalPrimaryEntries[0],
          {}
        )
      ).toMatchObject({
        available: 100,
        spent: 25,
        remaining: 75,
        current_vote: 10,
        max_vote: 85
      });
    });

    it('reads 710 active voter budgets in bounded source pages', async () => {
      const profileIds = Array.from(
        { length: 710 },
        (_, index) => `batch-voter-${index}`
      );
      const identities = profileIds.map((profileId, index) =>
        anIdentity(
          { tdh: 100 },
          {
            profile_id: profileId,
            consolidation_key: `batch-key-${index}`,
            primary_address: `0x${index.toString(16).padStart(40, '0')}`,
            handle: `batch-voter-${index}`
          }
        )
      );
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        identities,
        Object.keys(identities[0])
      );
      await sqlExecutor.bulkInsert(
        COMPETITION_VOTES_TABLE,
        identities.map((identity, index) => ({
          id: randomUUID(),
          competition_id: nativeId,
          entry_id: entry.id,
          voter_profile_id: identity.profile_id,
          value: index % 2 === 0 ? -120 : 80,
          credit_spent: index % 2 === 0 ? 120 : 80,
          created_at: 1,
          updated_at: 1
        })),
        [
          'id',
          'competition_id',
          'entry_id',
          'voter_profile_id',
          'value',
          'credit_spent',
          'created_at',
          'updated_at'
        ]
      );
      const identityPages = jest.spyOn(identitiesDb, 'getIdentitiesByIds');
      const spendingPages = jest.spyOn(
        competitionCreditRepository,
        'getNamespaceSpendings'
      );
      const single = jest.spyOn(competitionCreditRepository, 'getSpending');
      try {
        const budgets = await sqlExecutor.executeNativeQueriesInTransaction(
          (connection) =>
            competitionCreditService.getWaveBudgets(native, profileIds, {
              connection
            })
        );
        expect(identityPages).toHaveBeenCalledTimes(8);
        expect(spendingPages).toHaveBeenCalledTimes(8);
        expect(single).not.toHaveBeenCalled();
        expect(budgets.size).toBe(710);
        profileIds.forEach((profileId, index) => {
          expect(budgets.get(profileId)).toMatchObject({
            available: 100,
            spent: index % 2 === 0 ? 120 : 80,
            remaining: index % 2 === 0 ? 0 : 20
          });
        });
        const discovery = jest.spyOn(sqlExecutor, 'execute');
        try {
          const overvotes = await sqlExecutor.executeNativeQueriesInTransaction(
            (connection) =>
              competitionTdhOvervotesDb.findOvervoters(native, { connection })
          );
          expect(new Set(overvotes)).toEqual(
            new Set(profileIds.filter((_, index) => index % 2 === 0))
          );
          expect(discovery).toHaveBeenCalledTimes(1);
          expect(identityPages).toHaveBeenCalledTimes(8);
          expect(single).not.toHaveBeenCalled();
        } finally {
          discovery.mockRestore();
        }
      } finally {
        identityPages.mockRestore();
        spendingPages.mockRestore();
        single.mockRestore();
      }
    });

    it.each([
      WaveCreditType.TDH,
      WaveCreditType.XTDH,
      WaveCreditType.TDH_PLUS_XTDH
    ])(
      'matches single-profile %s budgets across native siblings and the native original primary',
      async (credit_type) => {
        for (const namespace of [
          native,
          { ...native, id: 'parallel-native' },
          {
            ...native,
            id: originalPrimaryId
          }
        ]) {
          const selected = {
            ...namespace,
            voting: { ...namespace.voting, credit_type }
          };
          await sqlExecutor.executeNativeQueriesInTransaction(
            async (connection) => {
              const ctx = { connection };
              const batched = await competitionCreditService.getWaveBudgets(
                selected,
                [profileId, profileId.toUpperCase(), 'missing-profile'],
                ctx
              );
              for (const voter of [
                profileId,
                profileId.toUpperCase(),
                'missing-profile'
              ])
                expect(batched.get(voter)).toEqual(
                  await competitionCreditService.getBudget(
                    selected,
                    voter,
                    undefined,
                    ctx
                  )
                );
            }
          );
        }
      }
    );

    it('uses per-entry DROP spending and preserves credits on every other entry', async () => {
      const dropScoped = {
        ...native,
        voting: { ...native.voting, credit_scope: WaveCreditScope.DROP }
      };
      expect(
        await competitionCreditService.getBudget(
          dropScoped,
          profileId,
          entry,
          {}
        )
      ).toMatchObject({
        available: 100,
        spent: 20,
        remaining: 80,
        max_vote: 100
      });
      expect(
        await competitionCreditService.getBudget(
          dropScoped,
          profileId,
          { id: 'entry-b', drop_id: 'drop-entry-b' },
          {}
        )
      ).toMatchObject({
        available: 100,
        spent: 30,
        remaining: 70,
        max_vote: 100
      });
    });

    it('releases only active-entry encumbrance and preserves terminal vote history', async () => {
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set status = 'WINNER' where id = :id`,
        { id: entry.id }
      );
      expect(
        await competitionCreditService.getBudget(
          native,
          profileId,
          undefined,
          {}
        )
      ).toMatchObject({ spent: 30, remaining: 70 });
      expect(
        await sqlExecutor.oneOrNull<{ value: number }>(
          `select value from ${COMPETITION_VOTES_TABLE} where entry_id = :id`,
          { id: entry.id }
        )
      ).toEqual({ value: -20 });
      expect(
        await competitionCreditService.getBudget(native, 'new-voter', entry, {})
      ).toMatchObject({
        available: 0,
        spent: 0,
        remaining: 0,
        current_vote: 0
      });
    });

    it('ignores an entry from another competition even when its ID is supplied', async () => {
      expect(
        await competitionCreditService.getBudget(
          native,
          profileId,
          {
            id: 'entry-other-competition',
            drop_id: 'drop-entry-other-competition'
          },
          {}
        )
      ).toMatchObject({ spent: 50, current_vote: 0, max_vote: 50 });
    });

    it('derives REP only from the configured creditor and category, excluding CIC/outcome ratings', async () => {
      for (const [matter, category, creditor, amount] of [
        ['REP', 'art', 'curator', 70],
        ['REP', 'other', 'curator', 500],
        ['REP', 'art', 'other', 400],
        ['CIC', 'art', 'curator', 900]
      ] as const) {
        await sqlExecutor.execute(
          `insert into ${RATINGS_TABLE} (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified) values (:creditor, :profileId, :matter, :category, :amount, now())`,
          { creditor, profileId, matter, category, amount }
        );
      }
      expect(
        await competitionCreditService.getBudget(
          {
            ...native,
            voting: {
              ...native.voting,
              credit_type: WaveCreditType.REP,
              credit_category: 'art',
              credit_creditor: 'curator'
            }
          },
          profileId,
          entry,
          {}
        )
      ).toMatchObject({ available: 70, remaining: 20 });
    });

    it('derives only the configured NFT set for the voter consolidation', async () => {
      const contract = `0x${'b'.repeat(40)}`;
      for (const [tokenId, consolidation, credit] of [
        [1, identity.consolidation_key, 40],
        [2, identity.consolidation_key, 35],
        [3, identity.consolidation_key, 999],
        [1, 'unrelated-consolidation', 999]
      ] as const) {
        await sqlExecutor.execute(
          `insert into ${TDH_NFT_TABLE} (id, contract, consolidation_key, balance, tdh, boost, boosted_tdh, tdh__raw, tdh_rank) values (:tokenId, :contract, :consolidation, 1, :credit, 1, :credit, :credit, 1)`,
          { tokenId, contract, consolidation, credit }
        );
      }
      const configured = {
        ...native,
        voting: {
          ...native.voting,
          credit_type: WaveCreditType.CARD_SET_TDH,
          credit_nfts: [
            { contract, token_id: 1 },
            { contract, token_id: 2 }
          ]
        }
      };
      expect(
        await competitionCreditService.getBudget(
          configured,
          profileId,
          entry,
          {}
        )
      ).toMatchObject({ available: 75, spent: 50, remaining: 25 });
    });

    it.each([
      [WaveCreditType.TDH, 40, 100, true],
      [WaveCreditType.XTDH, 100, 49.9, true],
      [WaveCreditType.XTDH, 100, 50.9, false],
      [WaveCreditType.TDH_PLUS_XTDH, 40, 9.9, true],
      [WaveCreditType.TDH_PLUS_XTDH, 40, 10.1, false]
    ])(
      'discovers only %s spending above the floored credit',
      async (credit_type, tdh, xtdh, overlimit) => {
        await sqlExecutor.execute(
          `update ${IDENTITIES_TABLE} set tdh=:tdh,xtdh=:xtdh where profile_id=:profileId`,
          { tdh, xtdh, profileId }
        );
        const selected = {
          ...native,
          voting: { ...native.voting, credit_type }
        };
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            expect(
              await competitionTdhOvervotesDb.findOvervoters(selected, {
                connection
              })
            ).toEqual(overlimit ? [profileId] : []);
            const budget = await competitionCreditService.getBudget(
              selected,
              profileId,
              undefined,
              { connection }
            );
            expect(budget.spent! > budget.available).toBe(overlimit);
          }
        );
      }
    );

    it('uses independent DROP caps, excludes terminal entries and isolates sibling namespaces', async () => {
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=30 where profile_id=:profileId`,
        { profileId }
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          const drop = {
            ...native,
            voting: { ...native.voting, credit_scope: WaveCreditScope.DROP }
          };
          expect(
            await competitionTdhOvervotesDb.findOvervoters(native, ctx)
          ).toEqual([profileId]);
          expect(
            await competitionTdhOvervotesDb.findOvervoters(drop, ctx)
          ).toEqual([]);
          expect(
            await competitionTdhOvervotesDb.findOvervoters(
              { ...drop, id: 'parallel-native' },
              ctx
            )
          ).toEqual([profileId]);
          expect(
            await competitionTdhOvervotesDb.findOvervoters(
              { ...drop, id: originalPrimaryId },
              ctx
            )
          ).toEqual([]);
        }
      );
    });

    it('includes missing identities and negative budgets as zero credit', async () => {
      await sqlExecutor.execute(
        `delete from ${IDENTITIES_TABLE} where profile_id=:profileId`,
        { profileId }
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          expect(
            await competitionTdhOvervotesDb.findOvervoters(native, {
              connection
            })
          ).toEqual([profileId]);
        }
      );
    });

    it('matches deduplicated card set credits across consolidation keys and missing cards', async () => {
      const contract = `0x${'b'.repeat(40)}`;
      const second = anIdentity(
        { tdh: 0 },
        {
          profile_id: profileId,
          consolidation_key: 'second-key',
          primary_address: `0x${'c'.repeat(40)}`,
          handle: 'second'
        }
      );
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        [second],
        Object.keys(second)
      );
      for (const [tokenId, consolidation, credit] of [
        [1, identity.consolidation_key, 20],
        [1, 'second-key', 30],
        [2, identity.consolidation_key, 19],
        [3, identity.consolidation_key, 999],
        [1, 'unrelated-consolidation', 999]
      ] as const) {
        await sqlExecutor.execute(
          `insert into ${TDH_NFT_TABLE} (id,contract,consolidation_key,balance,tdh,boost,boosted_tdh,tdh__raw,tdh_rank) values (:tokenId,:contract,:consolidation,1,:credit,1,:credit,:credit,1)`,
          { tokenId, contract, consolidation, credit }
        );
      }
      const selected = {
        ...native,
        voting: {
          ...native.voting,
          credit_type: WaveCreditType.CARD_SET_TDH,
          credit_nfts: [
            { contract, token_id: 1 },
            {
              contract: contract.toUpperCase().replace('0X', '0x'),
              tokenId: 1
            },
            { contract, token_id: 2 },
            { contract, token_id: 4 }
          ]
        }
      };
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          expect(
            (
              await competitionCreditService.getBudget(
                selected,
                profileId,
                undefined,
                ctx
              )
            ).available
          ).toBe(49);
          expect(
            await competitionTdhOvervotesDb.findOvervoters(selected, ctx)
          ).toEqual([profileId]);
          await sqlExecutor.execute(
            `update ${TDH_NFT_TABLE} set boosted_tdh=20 where id=2`,
            {},
            { wrappedConnection: connection }
          );
          expect(
            (
              await competitionCreditService.getBudget(
                selected,
                profileId,
                undefined,
                ctx
              )
            ).available
          ).toBe(50);
          expect(
            await competitionTdhOvervotesDb.findOvervoters(selected, ctx)
          ).toEqual([]);
        }
      );
    });

    it('discovers against uncommitted TDH changes and leaves the source unchanged on rollback', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          const ctx = { connection };
          await sqlExecutor.execute(
            `update ${IDENTITIES_TABLE} set tdh=0 where profile_id=:profileId`,
            { profileId },
            { wrappedConnection: connection }
          );
          expect(
            await competitionTdhOvervotesDb.findOvervoters(native, ctx)
          ).toEqual([profileId]);
          throw new Error('rollback TDH discovery');
        })
      ).rejects.toThrow('rollback TDH discovery');
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          expect(
            await competitionTdhOvervotesDb.findOvervoters(native, {
              connection
            })
          ).toEqual([]);
        }
      );
    });

    it('prevents concurrent overspending after acquiring the competition lock', async () => {
      await sqlExecutor.execute(
        `delete from ${COMPETITION_VOTES_TABLE} where competition_id = :id`,
        { id: nativeId }
      );
      const vote = (entryId: string) =>
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          const ctx = { connection };
          await sqlExecutor.execute(
            `select id from ${COMPETITIONS_TABLE} where id = :id for update`,
            { id: nativeId },
            { wrappedConnection: connection }
          );
          const budget = await competitionCreditService.getBudget(
            native,
            profileId,
            { id: entryId, drop_id: `drop-${entryId}` },
            ctx
          );
          competitionCreditService.assertVoteFits(budget, 70);
          await sqlExecutor.execute(
            `insert into ${COMPETITION_VOTES_TABLE} (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at) values (:id, :competitionId, :entryId, :profileId, 70, 70, 1, 1)`,
            { id: randomUUID(), competitionId: nativeId, entryId, profileId },
            { wrappedConnection: connection }
          );
        });
      const attempts = await Promise.allSettled([
        vote(entry.id),
        vote('entry-b')
      ]);
      expect(
        attempts.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result.status === 'rejected')
      ).toHaveLength(1);
      expect(
        await competitionCreditService.getBudget(
          native,
          profileId,
          undefined,
          {}
        )
      ).toMatchObject({ spent: 70, remaining: 30 });
      expect(
        await competitionCreditService.getBudget(
          { ...native, id: 'parallel-native' },
          profileId,
          undefined,
          {}
        )
      ).toMatchObject({ spent: 70, remaining: 30 });
    });

    it('observes transaction-local writes and does not expose rolled-back spending', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sqlExecutor.execute(
            `update ${COMPETITION_VOTES_TABLE} set value = 45, credit_spent = 45 where entry_id = :entryId`,
            { entryId: entry.id },
            { wrappedConnection: connection }
          );
          expect(
            await competitionCreditService.getBudget(native, profileId, entry, {
              connection
            })
          ).toMatchObject({ spent: 75, remaining: 25, current_vote: 45 });
          throw new Error('rollback fixture');
        })
      ).rejects.toThrow('rollback fixture');
      expect(
        await competitionCreditService.getBudget(native, profileId, entry, {})
      ).toMatchObject({ spent: 50, remaining: 50, current_vote: -20 });
    });
  }
);
