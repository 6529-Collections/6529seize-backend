import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CIC_STATEMENTS_TABLE,
  CONSOLIDATIONS_TABLE,
  DELEGATIONS_TABLE,
  IDENTITIES_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { consolidationKeyOf, planIdentity } from './identity-plan';
import { EMPTY_PROFILE_DOC_FIELDS } from './profile-doc';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const A = W(1);
const B = W(2);
const C = W(3);
const ALICE = '00000000-0000-4000-8000-0000000a11ce';
const PLACE = '00000000-0000-4000-8000-000000000003';
const BOB = '00000000-0000-4000-8000-000000000b0b';
const AB = consolidationKeyOf([A, B]);
const P = '0x' + 'ab'.repeat(32);

const db = new IdentityChainMirrorDb(() => sqlExecutor);
const inTx = <T>(fn: (conn: any) => Promise<T>) =>
  sqlExecutor.executeNativeQueriesInTransaction(fn);

describeWithSeed(
  'IdentityChainMirrorDb',
  [
    withIdentities([
      anIdentity(
        { tdh: 500 },
        {
          consolidation_key: AB,
          profile_id: ALICE,
          primary_address: A,
          handle: 'alice'
        }
      ),
      anIdentity(
        {},
        {
          consolidation_key: C,
          profile_id: PLACE,
          primary_address: C,
          handle: `id-${C}`
        }
      )
    ]),
    withProfiles([
      aProfile({ external_id: ALICE, handle: 'alice', primary_wallet: A }),
      aProfile({ external_id: PLACE, handle: `id-${C}`, primary_wallet: C }),
      aProfile({ external_id: BOB, handle: 'bob', primary_wallet: W(4) })
    ]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: A, consolidation_key: AB },
        { address: B, consolidation_key: AB },
        { address: C, consolidation_key: C }
      ]
    },
    withRatings([
      aRepRating({
        rater_profile_id: BOB,
        matter_target_id: ALICE,
        matter_category: 'Kind',
        rating: 3
      }),
      aRepRating({
        rater_profile_id: PLACE,
        matter_target_id: ALICE,
        matter_category: 'Old',
        rating: 1
      }),
      aRepRating({
        rater_profile_id: BOB,
        matter_target_id: ALICE,
        matter_category: HELP_BOT_CREDIT_CATEGORY,
        rating: 10
      })
    ]),
    {
      table: CONSOLIDATIONS_TABLE,
      rows: [
        { block: 1, wallet1: A, wallet2: B, confirmed: true },
        { block: 2, wallet1: C, wallet2: W(7), confirmed: false }
      ]
    },
    {
      table: DELEGATIONS_TABLE,
      rows: [
        {
          block: 10,
          from_address: A,
          to_address: W(9),
          collection: W(8),
          use_case: 2,
          expiry: 64_060_588_800,
          all_tokens: true,
          token_id: 0
        },
        {
          block: 11,
          from_address: A,
          to_address: W(9),
          collection: W(8),
          use_case: 3,
          expiry: 64_060_588_800,
          all_tokens: true,
          token_id: 0
        }
      ]
    }
  ],
  () => {
    it('keeps the mirror state and the principal mapping', async () => {
      expect(await db.getState()).toBeNull();
      await db.saveState(
        {
          next_height: 101,
          sync_from_height: null,
          sync_phase: null,
          sync_after: null,
          last_full_sync_at: 5
        },
        9
      );
      expect(await db.getState()).toEqual(
        expect.objectContaining({ next_height: 101, last_full_sync_at: 5 })
      );
      expect(
        (await db.unmappedProfilesOfWallets([A, C]))
          .map((it) => it.profile_id)
          .sort()
      ).toEqual([ALICE, PLACE].sort());
      await inTx((conn) => db.insertMapping(P, ALICE, 'WALLET', 1, conn));
      expect(await db.profileIdOfPrincipal(P)).toBe(ALICE);
      expect(await db.principalOfProfile(ALICE)).toBe(P);
      expect(await db.principalsOfWallets([B])).toEqual([P]);
      expect(
        (await db.unmappedProfilesOfWallets([A, C])).map((it) => it.profile_id)
      ).toEqual([PLACE]);
    });

    it('applies a join: one row for the three wallets, pairs, the handle', async () => {
      await inTx(async (conn) => {
        const state = await db.readIdentityState(
          [A, B, C],
          ALICE,
          'Alice',
          A,
          conn
        );
        expect(state.handleHolder).toBeNull();
        expect(state.placeholderTaken).toBe(false);
        expect(state.rows.map((it) => it.consolidation_key).sort()).toEqual(
          [AB, C].sort()
        );
        expect(state.walletsByKey[AB].sort()).toEqual([A, B]);
        const plan = planIdentity(
          {
            principalId: P,
            profileId: ALICE,
            handle: 'alice',
            wallets: [A, B, C],
            primary: A,
            doc: {
              ...EMPTY_PROFILE_DOC_FIELDS,
              displayName: 'Alice',
              website: 'https://example.org',
              statements: [
                { group: 'GENERAL', type: 'BIO', value: 'hi', comment: null }
              ]
            },
            rep: 3,
            cic: 0,
            levelRaw: 503
          },
          state
        );
        await db.applyIdentityPlan(plan, 1_000_000_050, 77, conn);
      });
      const key = consolidationKeyOf([A, B, C]);
      const rows = await sqlExecutor.execute<any>(
        `select consolidation_key, profile_id, handle, tdh, level_raw from ${IDENTITIES_TABLE}`
      );
      expect(rows).toEqual([
        expect.objectContaining({
          consolidation_key: key,
          profile_id: ALICE,
          handle: 'Alice'
        })
      ]);
      expect(Number(rows[0].level_raw)).toBe(503);
      expect(Number(rows[0].tdh)).toBe(500);
      const keys = await sqlExecutor.execute<any>(
        `select address, consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} order by address`
      );
      expect(keys.map((it: any) => it.consolidation_key)).toEqual([
        key,
        key,
        key
      ]);
      const pairs = await sqlExecutor.execute<any>(
        `select wallet1, wallet2, confirmed from ${CONSOLIDATIONS_TABLE} order by wallet1, wallet2`
      );
      expect(pairs.map((it: any) => [it.wallet1, it.wallet2])).toEqual([
        [A, B],
        [A, C],
        [B, C]
      ]);
      const profile = await sqlExecutor.oneOrNull<any>(
        `select handle, normalised_handle, website from ${PROFILES_TABLE} where external_id = :id`,
        { id: ALICE }
      );
      expect(profile).toEqual({
        handle: 'Alice',
        normalised_handle: 'alice',
        website: 'https://example.org'
      });
      const statements = await sqlExecutor.execute<any>(
        `select statement_group, statement_type, statement_value from ${CIC_STATEMENTS_TABLE} where profile_id = :id`,
        { id: ALICE }
      );
      expect(statements).toEqual([
        {
          statement_group: 'GENERAL',
          statement_type: 'BIO',
          statement_value: 'hi'
        }
      ]);
    });

    it('replaces a target ratings but keeps help-bot credits', async () => {
      const result = await inTx((conn) =>
        db.replaceTargetRatings(
          ALICE,
          [
            {
              rater_profile_id: BOB,
              matter: 'REP',
              matter_category: 'Kind',
              rating: 4
            },
            {
              rater_profile_id: BOB,
              matter: 'CIC',
              matter_category: 'CIC',
              rating: 2
            }
          ],
          1_700_000_000_000,
          conn
        )
      );
      expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });
      const rows = await sqlExecutor.execute<any>(
        `select rater_profile_id, matter, matter_category, rating from ${RATINGS_TABLE}
         where matter_target_id = :id order by matter, matter_category`,
        { id: ALICE }
      );
      expect(rows).toEqual([
        {
          rater_profile_id: BOB,
          matter: 'CIC',
          matter_category: 'CIC',
          rating: 2
        },
        {
          rater_profile_id: BOB,
          matter: 'REP',
          matter_category: HELP_BOT_CREDIT_CATEGORY,
          rating: 10
        },
        {
          rater_profile_id: BOB,
          matter: 'REP',
          matter_category: 'Kind',
          rating: 4
        }
      ]);
    });

    it('replaces a wallet delegations and all pairs', async () => {
      const result = await inTx((conn) =>
        db.replaceWalletDelegations(
          A,
          [
            {
              block: 10,
              from_address: A,
              to_address: W(9),
              collection: W(8),
              use_case: 2,
              expiry: 64_060_588_800,
              all_tokens: true,
              token_id: 0
            },
            {
              block: 1_000_000_040,
              from_address: A,
              to_address: W(10),
              collection: W(8),
              use_case: 3,
              expiry: 1_900_000_000,
              all_tokens: false,
              token_id: 61
            }
          ],
          conn
        )
      );
      expect(result).toEqual({ written: 1, deleted: 1 });
      expect(await db.walletsWithDelegations()).toEqual([A]);
      await inTx((conn) =>
        db.replaceAllPairs([{ wallet1: A, wallet2: B }], 1_000_000_100, 1, conn)
      );
      const pairs = await sqlExecutor.execute<any>(
        `select wallet1, wallet2, confirmed, block from ${CONSOLIDATIONS_TABLE}`
      );
      expect(pairs).toEqual([
        expect.objectContaining({
          wallet1: A,
          wallet2: B,
          block: 1_000_000_100
        })
      ]);
    });
  }
);
