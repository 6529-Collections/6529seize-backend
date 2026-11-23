import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import {
  aCicRating,
  aRepRating,
  withRatings
} from '@/tests/fixtures/rating.fixture';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import {
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILES_ARCHIVE_TABLE,
  TDH_BLOCKS_TABLE
} from '@/constants';
import { SqlIdentityExportSource } from './identity-export.db';
import { buildIdentityExport } from './identity-export.service';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const ALICE = '00000000-0000-4000-8000-0000000a11ce';
const BOB = '00000000-0000-4000-8000-000000000b0b';
const PLACE = '00000000-0000-4000-8000-000000000001';
const LONELY = '00000000-0000-4000-8000-000000000002';
const PAIR_KEY = `${W(6)}-${W(7)}`;
const HELP_BOT = '00000000-0000-4000-8000-0000000000b0';
const FREEZE = Date.UTC(2026, 10, 24);
// Stored with an upper-case F: bytewise it sorts before ...0e, lower-cased
// after it.
const MIXED = `0x${'0'.repeat(39)}F`;
const LOWER_E = `0x${'0'.repeat(39)}e`;

function archiveRow(createdAt: number) {
  return {
    external_id: ALICE,
    handle: 'Alice',
    normalised_handle: 'alice',
    primary_wallet: W(1),
    created_at: new Date(createdAt),
    created_by_wallet: W(1)
  };
}

function delegation(
  block: number,
  from: string,
  useCase: number,
  token: number
) {
  return {
    block,
    from_address: from,
    to_address: W(9),
    collection: W(10),
    use_case: useCase,
    expiry: 64_060_588_800,
    all_tokens: token === 0,
    token_id: token
  };
}

function ratingEdit(
  id: string,
  matter: string,
  reason: string,
  createdAt: number
) {
  return {
    id,
    profile_id: ALICE,
    target_id: BOB,
    contents: JSON.stringify({
      old_rating: 0,
      new_rating: 1,
      rating_matter: matter,
      rating_category: 'Good',
      change_reason: reason
    }),
    type: 'RATING_EDIT',
    additional_data_1: matter,
    additional_data_2: 'Good',
    created_at: new Date(createdAt)
  };
}

const identities = [
  anIdentity(
    // 4 of Alice's REP is the help bot's credit: 6529.io's level 3 (102)
    // is the chain's level 2 (98).
    { tdh: 98, rep: 4, level_raw: 102 },
    {
      consolidation_key: W(1),
      profile_id: ALICE,
      primary_address: W(1),
      handle: 'Alice'
    }
  ),
  anIdentity(
    {},
    {
      consolidation_key: W(2),
      profile_id: BOB,
      primary_address: W(2),
      handle: 'bob'
    }
  ),
  anIdentity(
    {},
    {
      consolidation_key: W(3),
      profile_id: PLACE,
      primary_address: W(3),
      handle: `id-${W(3)}`
    }
  ),
  anIdentity(
    {},
    {
      consolidation_key: W(4),
      profile_id: LONELY,
      primary_address: W(4),
      handle: `id-${W(4)}`
    }
  ),
  {
    ...anIdentity(
      {},
      {
        consolidation_key: PAIR_KEY,
        profile_id: '',
        primary_address: W(6),
        handle: ''
      }
    ),
    profile_id: null,
    handle: null,
    normalised_handle: null
  }
];

const profiles = [
  aProfile(
    { external_id: ALICE, handle: 'Alice', primary_wallet: W(1) },
    { website: 'https://example.org' }
  ),
  aProfile({ external_id: BOB, handle: 'bob', primary_wallet: W(2) }),
  aProfile({ external_id: PLACE, handle: `id-${W(3)}`, primary_wallet: W(3) }),
  aProfile({ external_id: LONELY, handle: `id-${W(4)}`, primary_wallet: W(4) }),
  aProfile({ external_id: HELP_BOT, handle: 'help6529', primary_wallet: W(11) })
];

const ratings = [
  aRepRating({
    rater_profile_id: HELP_BOT,
    matter_target_id: ALICE,
    matter_category: 'Help6529 Credits',
    rating: 4
  }),
  aRepRating({
    rater_profile_id: ALICE,
    matter_target_id: BOB,
    matter_category: 'Good',
    rating: 5
  }),
  aRepRating({
    rater_profile_id: ALICE,
    matter_target_id: PLACE,
    matter_category: 'Good',
    rating: -3
  }),
  aRepRating({
    rater_profile_id: BOB,
    matter_target_id: ALICE,
    matter_category: 'Kind',
    rating: 0
  }),
  aCicRating({
    rater_profile_id: BOB,
    matter_target_id: ALICE,
    rating: 9
  })
];

describeWithSeed(
  'SqlIdentityExportSource',
  [
    withIdentities(identities as any),
    withProfiles(profiles),
    withRatings(ratings),
    withAddressConsolidationKeys([
      ...anAddressConsolidationKeys([W(1)]),
      ...anAddressConsolidationKeys([W(2)]),
      ...anAddressConsolidationKeys([W(3)]),
      ...anAddressConsolidationKeys([W(4)]),
      { address: W(6), consolidation_key: PAIR_KEY },
      { address: W(7), consolidation_key: PAIR_KEY }
    ]),
    {
      table: CIC_STATEMENTS_TABLE,
      rows: [
        {
          id: 'statement-1',
          profile_id: ALICE,
          statement_group: 'GENERAL',
          statement_type: 'BIO',
          statement_comment: null,
          statement_value: 'hello',
          crated_at: new Date('2024-01-01T00:00:00Z')
        }
      ]
    },
    {
      table: TDH_BLOCKS_TABLE,
      rows: [
        {
          block_number: 23_999_000,
          timestamp: new Date('2026-11-22T00:00:00Z')
        },
        {
          block_number: 24_000_000,
          timestamp: new Date('2026-11-23T00:00:00Z')
        }
      ]
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        ratingEdit('edit-1', 'REP', 'USER_EDIT', FREEZE + 60_000),
        ratingEdit('edit-2', 'CIC', 'USER_EDIT', FREEZE + 60_000),
        ratingEdit('edit-3', 'REP', 'LOST_TDH', FREEZE + 60_000),
        ratingEdit(
          'edit-4',
          'REP',
          'HELP_BOT_AUTOMATIC_GRANT',
          FREEZE + 60_000
        ),
        ratingEdit('edit-5', 'WAVE_REP', 'USER_EDIT', FREEZE + 60_000),
        ratingEdit('edit-6', 'REP', 'USER_EDIT', FREEZE - 60_000),
        // Written in the freeze's own second: after it.
        ratingEdit('edit-7', 'CIC', 'USER_EDIT', FREEZE),
        { ...ratingEdit('edit-8', 'REP', '', FREEZE), type: 'HANDLE_EDIT' },
        {
          ...ratingEdit('edit-9', 'REP', '', FREEZE + 1_000),
          type: 'GENERAL_CIC_STATEMENT_EDIT'
        },
        {
          ...ratingEdit('edit-10', 'REP', '', FREEZE - 1_000),
          type: 'PFP_EDIT'
        }
      ]
    },
    {
      table: IDENTITY_TDH_SYNC_STATE_TABLE,
      rows: [
        { id: 'pending', generation: 3, block: 24_000_000 },
        { id: 'synced', generation: 3, block: 24_000_000 },
        { id: 'full_announce', generation: 0, block: 24_000_000 }
      ]
    },
    {
      table: DELEGATIONS_TABLE,
      // Out of order: the export reads them by block, then lower-cased
      // addresses bytewise.
      rows: [
        delegation(20_000_001, W(1), 1, 0),
        delegation(20_000_000, W(1), 2, 61),
        delegation(21_000_000, MIXED, 1, 0),
        delegation(21_000_000, LOWER_E, 1, 0),
        // After the TDH block (24,000,000): left out of the file, counted;
        // the primary-address one (use case 997) is gated too.
        delegation(24_000_002, W(2), 1, 0),
        delegation(24_000_003, W(3), 997, 0)
      ]
    },
    {
      table: CONSOLIDATIONS_TABLE,
      rows: [
        { block: 23_999_999, wallet1: W(20), wallet2: W(21), confirmed: true },
        { block: 24_000_001, wallet1: W(22), wallet2: W(23), confirmed: true },
        // In the TDH block itself: before the TDH was taken.
        { block: 24_000_000, wallet1: W(24), wallet2: W(25), confirmed: true }
      ]
    },
    {
      table: PROFILES_ARCHIVE_TABLE,
      // A save after the freeze with no activity log (a pfp update), and
      // one before it.
      rows: [archiveRow(FREEZE + 5_000), archiveRow(FREEZE - 5_000)]
    }
  ],
  () => {
    const query = <T>(sql: string, params?: Record<string, unknown>) =>
      sqlExecutor.execute<T>(sql, params);

    it('reads the core and the multi-wallet consolidations', async () => {
      const source = new SqlIdentityExportSource(query);
      expect((await source.realHandleProfileIds()).sort()).toEqual(
        [ALICE, BOB].sort()
      );
      expect(await source.multiWalletConsolidationKeys()).toEqual([PAIR_KEY]);
      const pair = await source.identitiesByConsolidationKeys([PAIR_KEY]);
      expect(pair).toHaveLength(1);
      expect(pair[0].p_external_id).toBeNull();
      const wallets = await source.walletsByConsolidationKeys([PAIR_KEY, W(1)]);
      expect(wallets.get(PAIR_KEY)?.sort()).toEqual([W(6), W(7)]);
      expect(wallets.get(W(1))).toEqual([W(1)]);
    });

    it('pages every non-zero REP and CIC rating in key order', async () => {
      const source = new SqlIdentityExportSource(query, 1);
      const edges = await source.ratingEdges();
      expect(
        edges.map((it) => [
          it.rater_profile_id,
          it.target_profile_id,
          it.matter,
          it.category,
          it.rating
        ])
      ).toEqual([
        // Primary key order, bytewise: the help bot's id sorts before BOB's,
        // BOB's before ALICE's.
        [HELP_BOT, ALICE, 'REP', 'Help6529 Credits', 4],
        [BOB, ALICE, 'CIC', '', 9],
        [ALICE, PLACE, 'REP', 'Good', -3],
        [ALICE, BOB, 'REP', 'Good', 5]
      ]);
      expect(typeof edges[0].last_modified_ms).toBe('number');
    });

    it('reads statements, the TDH block and delegations', async () => {
      const source = new SqlIdentityExportSource(query);
      const statements = await source.statementsByProfileIds([ALICE, BOB]);
      expect(statements.map((it) => it.id)).toEqual(['statement-1']);
      expect(await source.latestTdhBlock()).toEqual({
        block: 24_000_000,
        timestampMs: Date.UTC(2026, 10, 23)
      });
      // BOB's CIC 9 is over his TDH 0; the help bot's credit counts too here,
      // as the over-rates loop would count it, because its profile has no
      // identity row in this seed.
      expect(await source.overCreditRaters()).toEqual({
        withXtdh: 2,
        tdhOnly: 2
      });
      // Every REP and CIC rating but the credit was last changed in 2024,
      // the zero rating included; none after the freeze.
      const changed = await source.ratingsChangedSince(Date.UTC(2023, 0, 1));
      expect(changed).toHaveLength(4);
      expect(changed[0]).toEqual({
        rater_profile_id: BOB,
        target_profile_id: ALICE,
        matter: 'CIC',
        category: '',
        rating: 9,
        last_modified_ms: Date.UTC(2024, 0, 1)
      });
      expect(await source.ratingsChangedSince(FREEZE)).toEqual([]);
      // A REP and a CIC edit after the freeze; not the over-rate cut, the
      // help bot's grant, the wave REP edit or the edit before.
      expect(await source.ratingEditsSince(FREEZE)).toBe(3);
      // The handle and statement edits at and after the freeze; the pfp
      // edit before it. No profile was created after it.
      expect(await source.profileWritesSince(FREEZE)).toEqual({
        handle: 1,
        classification: 0,
        pfp: 0,
        banner: 0,
        statements: 1,
        archived: 0,
        saves: 1,
        created: 0
      });
      expect(await source.rowsAfterBlock(24_000_000)).toEqual({
        consolidations: 1,
        delegations: 2,
        primaryAddressDelegations: 1
      });
      expect(await source.identitySyncProgress()).toEqual({
        pendingGeneration: 3,
        pendingBlock: 24_000_000,
        syncedGeneration: 3,
        fullWriteBlock: 24_000_000
      });
      expect(await source.helpBotProfileId()).toBe(HELP_BOT);
      const delegations = await source.delegations(null);
      expect(delegations.slice(0, 2)).toEqual([
        {
          from_address: W(1),
          to_address: W(9),
          collection: W(10),
          use_case: 2,
          expiry: 64_060_588_800,
          all_tokens: false,
          token_id: '61',
          block: 20_000_000
        },
        {
          from_address: W(1),
          to_address: W(9),
          collection: W(10),
          use_case: 1,
          expiry: 64_060_588_800,
          all_tokens: true,
          token_id: null,
          block: 20_000_001
        }
      ]);
      expect(delegations.map((it) => [it.block, it.from_address])).toEqual([
        [20_000_000, W(1)],
        [20_000_001, W(1)],
        [21_000_000, LOWER_E],
        [21_000_000, MIXED.toLowerCase()],
        [24_000_002, W(2)],
        [24_000_003, W(3)]
      ]);
      // Held to the TDH block: the rows at or before it.
      expect(
        (await source.delegations(24_000_000)).map((it) => it.block)
      ).toEqual([20_000_000, 20_000_001, 21_000_000, 21_000_000]);
    });

    it('builds the export from the database', async () => {
      const doc = await buildIdentityExport(
        new SqlIdentityExportSource(query, 2),
        {
          bulkThreshold: 2000,
          extraProfileIds: [],
          includeDelegations: true,
          freezeMs: null,
          exporterRevision: 'c'.repeat(40)
        }
      );
      expect(doc.identities.map((it) => [it.profile_id, it.scope])).toEqual([
        [PLACE, ['rating']],
        [BOB, ['handle', 'rating']],
        [ALICE, ['handle', 'rating']],
        [null, ['wallets']]
      ]);
      const alice = doc.identities.find((it) => it.profile_id === ALICE)!;
      expect(alice.website).toBe('https://example.org');
      expect(alice.statements).toHaveLength(1);
      // Without the help bot's credit: rep 4 - 4, level_raw 0 + 98.
      expect([alice.rep, alice.level_raw, alice.level]).toEqual([0, 98, 2]);
      // 6529.io's own, as stored.
      expect([alice.io_rep, alice.io_level_raw, alice.io_level]).toEqual([
        4, 102, 3
      ]);
      expect(doc.ratings).toHaveLength(3);
      expect(doc.ratings.some((it) => it.category === 'Help6529 Credits')).toBe(
        false
      );
      expect(doc.stats.help_bot_credits_left_out).toBe(1);
      expect(doc.stats.help_bot_credits_from_others).toBe(0);
      expect(doc.tdh_block).toBe(24_000_000);
      expect(doc.tdh_block_timestamp_ms).toBe(Date.UTC(2026, 10, 23));
      expect(doc.stats).toEqual(
        expect.objectContaining({
          identity_sync_pending_generation: 3,
          identity_sync_synced_generation: 3,
          identity_sync_pending_block: 24_000_000
        })
      );
    });
  }
);
