import { randomUUID } from 'node:crypto';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  RATINGS_TABLE,
  TDH_NFT_TABLE
} from '@/constants';
import {
  CompetitionEntryStatus,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';

const profileId = 'budget-voter';
const waveId = 'shared-wave';
const nativeId = 'budget-native';
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
const legacyDrops = [
  { id: 'legacy-a', drop_type: 'PARTICIPATORY' },
  { id: 'legacy-b', drop_type: 'PARTICIPATORY' },
  { id: 'legacy-winner', drop_type: 'WINNER' }
];

describeWithSeed(
  'Competition credit isolation and transaction accounting',
  [
    withIdentities([identity]),
    {
      table: COMPETITIONS_TABLE,
      rows: [
        {
          id: nativeId,
          wave_id: waveId,
          legacy_wave_id: null,
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
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: nativeEntries.map((item) => ({
        ...item,
        wave_id: waveId,
        drop_id: item.id === entry.id ? entry.drop_id : `drop-${item.id}`,
        submitter_id: 'submitter',
        config_version: 1,
        submitted_at: 1
      }))
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: nativeEntries.map((item, index) => ({
        id: `vote-${index}`,
        competition_id: item.competition_id,
        entry_id: item.id,
        voter_profile_id: profileId,
        value: nativeValues[index],
        credit_spent: Math.abs(nativeValues[index]),
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
        votes: [10, -15, 100][index]
      }))
    }
  ],
  () => {
    it('separates two native competitions and the legacy primary in one shared wave', async () => {
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
            id: 'legacy',
            storage_mode: CompetitionStorageMode.LEGACY_ADAPTER
          },
          profileId,
          { id: 'legacy-entry-a', drop_id: 'legacy-a' },
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
