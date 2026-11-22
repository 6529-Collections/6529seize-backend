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
  DELEGATIONS_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
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
        ratingEdit('edit-6', 'REP', 'USER_EDIT', FREEZE - 60_000)
      ]
    },
    {
      table: IDENTITY_TDH_SYNC_STATE_TABLE,
      rows: [
        { id: 'pending', generation: 3, block: 24_000_000 },
        { id: 'synced', generation: 3, block: 24_000_000 }
      ]
    },
    {
      table: DELEGATIONS_TABLE,
      rows: [
        {
          block: 20_000_000,
          from_address: W(1),
          to_address: W(9),
          collection: W(10),
          use_case: 2,
          expiry: 64_060_588_800,
          all_tokens: false,
          token_id: 61
        }
      ]
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
      expect(await source.overCreditRaters()).toBe(2);
      // A REP and a CIC edit after the freeze; not the over-rate cut, the
      // help bot's grant, the wave REP edit or the edit before.
      expect(await source.ratingEditsSince(FREEZE)).toBe(2);
      expect(await source.identitySyncProgress()).toEqual({
        pendingGeneration: 3,
        pendingBlock: 24_000_000,
        syncedGeneration: 3
      });
      expect(await source.helpBotProfileId()).toBe(HELP_BOT);
      expect(await source.delegations()).toEqual([
        {
          from_address: W(1),
          to_address: W(9),
          collection: W(10),
          use_case: 2,
          expiry: 64_060_588_800,
          all_tokens: false,
          token_id: '61',
          block: 20_000_000
        }
      ]);
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
