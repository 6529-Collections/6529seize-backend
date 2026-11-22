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
  IDENTITY_CHAIN_RATING_EVENTS_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { HELP_BOT_CREDIT_CATEGORY } from '@/help-bot/help-bot.config';
import { IdentityChainMirrorDb, NO_RETRY } from './identity-chain-mirror.db';
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
const Q = '0x' + 'cd'.repeat(32);

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
          last_full_sync_at: 5,
          bindings_next_height: null,
          chain_id: null,
          placeholders_at: null,
          bindings_exact: false,
          retry: NO_RETRY
        },
        9
      );
      expect(await db.getState()).toEqual(
        expect.objectContaining({ next_height: 101, last_full_sync_at: 5 })
      );
      await inTx((conn) => db.insertMapping(P, ALICE, 'LEGACY', 1, conn));
      expect(await db.profileIdOfPrincipal(P)).toBe(ALICE);
      expect(await db.principalOfProfile(ALICE)).toBe(P);
      expect(await db.principalsOfWallets([B])).toEqual([P]);
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
      // The chain's level only: the help bot's credit to Alice isn't added.
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

    it("finds a wallet's placeholder profile that no principal holds", async () => {
      // Listed in chunks of one; a later rename doesn't change the list.
      let after: string | null = '';
      let chunks = 0;
      while (after !== null) {
        after = await db.listPlaceholderProfiles(after, 1);
        chunks++;
      }
      expect(chunks).toBe(4);
      await sqlExecutor.execute(
        `update ${PROFILES_TABLE} set handle = 'carol', normalised_handle = 'carol' where external_id = :id`,
        { id: PLACE }
      );
      expect(await db.listPlaceholderProfiles('', 10)).toBeNull();
      expect(await db.unmappedPlaceholderProfile(C.toUpperCase())).toBe(PLACE);
      await inTx((conn) => db.insertMapping(P, PLACE, 'FOUNDER', 1, conn));
      expect(await db.unmappedPlaceholderProfile(C)).toBeNull();
      expect(await db.unmappedPlaceholderProfile(A)).toBeNull();
    });

    it('keeps the wallet bindings', async () => {
      const row = (wallet: string, height: number) => ({
        wallet,
        principal_id: P,
        bound_from_height: height
      });
      await inTx((conn) =>
        db.writeWalletBindings([row(A, 3), row(B, 4)], [], 9, conn)
      );
      await inTx((conn) =>
        db.writeWalletBindings([row(B, 7)], [A, C], 10, conn)
      );
      expect(await db.boundWallets()).toEqual([B]);
      await inTx((conn) => db.clearWalletBindings(conn));
      expect(await db.boundWallets()).toEqual([]);
      await inTx((conn) => db.writeWalletBindings([row(B, 7)], [], 11, conn));
      expect(await db.walletBindings([A, B])).toEqual(
        new Map([[B, row(B, 7)]])
      );
      // One read: no state row yet, then the binding with the followed height.
      expect(await db.walletBindingAt(B)).toEqual({
        binding: null,
        nextHeight: null,
        chainId: null
      });
      await db.saveState(
        {
          next_height: 1,
          sync_from_height: null,
          sync_phase: null,
          sync_after: null,
          last_full_sync_at: 1,
          bindings_next_height: 12,
          chain_id: '0xabc',
          placeholders_at: 5,
          bindings_exact: true,
          retry: { principals: [P], targets: [], wallets: [B] }
        },
        1
      );
      expect(await db.getState()).toEqual(
        expect.objectContaining({
          bindings_next_height: 12,
          chain_id: '0xabc',
          placeholders_at: 5,
          bindings_exact: true,
          retry: { principals: [P], targets: [], wallets: [B] }
        })
      );
      // The retry list holds the 10,000 keys past which a full sync starts.
      const many = Array.from(
        { length: 10_001 },
        (_, i) => '0x' + i.toString(16).padStart(64, '0')
      );
      const before = (await db.getState())!;
      await db.saveState(
        { ...before, retry: { principals: many, targets: many, wallets: [] } },
        2
      );
      expect((await db.getState())?.retry.targets).toEqual(many);
      expect(await db.walletBindingAt(B)).toEqual({
        binding: row(B, 7),
        nextHeight: 12,
        chainId: '0xabc'
      });
      expect(await db.walletBindingAt(A)).toEqual({
        binding: null,
        nextHeight: 12,
        chainId: '0xabc'
      });
    });

    it('never updates tdh, basetdh_rate or xTDH in a row that exists', async () => {
      expect(await db.consolidationKeyWidth()).toBeGreaterThanOrEqual(200);
      await inTx(async (conn) => {
        const state = await db.readIdentityState([A, B], ALICE, null, A, conn);
        const plan = planIdentity(
          {
            principalId: P,
            profileId: ALICE,
            handle: 'alice',
            wallets: [A, B],
            primary: A,
            doc: undefined,
            rep: 7,
            cic: 2,
            levelRaw: 507
          },
          state
        );
        expect(plan.identity.consolidation_key).toBe(AB);
        // Another loop's values in the plan: the existing row keeps its own.
        await db.applyIdentityPlan(
          {
            ...plan,
            identity: {
              ...plan.identity,
              tdh: 1,
              basetdh_rate: 9,
              xtdh: 7,
              xtdh_rate: 3
            }
          },
          1_000_000_050,
          77,
          conn
        );
      });
      const row = await sqlExecutor.oneOrNull<any>(
        `select tdh, basetdh_rate, xtdh, xtdh_rate, rep, cic, level_raw
         from ${IDENTITIES_TABLE} where consolidation_key = :key`,
        { key: AB }
      );
      expect(
        Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]))
      ).toEqual({
        tdh: 500,
        basetdh_rate: 0,
        xtdh: 0,
        xtdh_rate: 0,
        rep: 7,
        cic: 2,
        level_raw: 507
      });
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
              rating: 4,
              rater_principal: P,
              height: 88
            },
            {
              rater_profile_id: BOB,
              matter: 'CIC',
              matter_category: 'CIC',
              rating: 2,
              rater_principal: P,
              height: 89
            }
          ],
          1_700_000_000_000,
          { targetPrincipal: Q, height: 90, source: 'FEED' },
          conn
        )
      );
      expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });
      // One event per change, in the same transaction.
      const events = await sqlExecutor.execute<any>(
        `select height, rater_principal, rater_profile_id, target_principal, target_profile_id,
                matter, matter_category, old_rating, new_rating, total_after, source
         from ${IDENTITY_CHAIN_RATING_EVENTS_TABLE} order by matter, matter_category`
      );
      expect(
        events.map((it: any) => ({
          ...it,
          height: Number(it.height),
          total_after: Number(it.total_after)
        }))
      ).toEqual([
        {
          height: 89,
          rater_principal: P,
          rater_profile_id: BOB,
          target_principal: Q,
          target_profile_id: ALICE,
          matter: 'CIC',
          matter_category: 'CIC',
          old_rating: 0,
          new_rating: 2,
          total_after: 2,
          source: 'FEED'
        },
        {
          height: 88,
          rater_principal: P,
          rater_profile_id: BOB,
          target_principal: Q,
          target_profile_id: ALICE,
          matter: 'REP',
          matter_category: 'Kind',
          old_rating: 3,
          new_rating: 4,
          total_after: 4,
          source: 'FEED'
        },
        {
          height: 90,
          rater_principal: null,
          rater_profile_id: PLACE,
          target_principal: Q,
          target_profile_id: ALICE,
          matter: 'REP',
          matter_category: 'Old',
          old_rating: 1,
          new_rating: 0,
          total_after: 0,
          source: 'FEED'
        }
      ]);
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

    it("keeps the given raters' rows it is not given, counting them in totals", async () => {
      const result = await inTx((conn) =>
        db.replaceTargetRatings(
          ALICE,
          [
            {
              rater_profile_id: BOB,
              matter: 'REP',
              matter_category: 'Old',
              rating: 2,
              rater_principal: P,
              height: 91
            }
          ],
          1_700_000_000_000,
          { targetPrincipal: Q, height: 92, source: 'FEED' },
          conn,
          { keepRaters: [PLACE] }
        )
      );
      // BOB's Kind row goes (not given, not kept); PLACE's Old row stays.
      expect(result).toEqual({ inserted: 1, updated: 0, deleted: 1 });
      const rows = await sqlExecutor.execute<any>(
        `select rater_profile_id, matter_category, rating from ${RATINGS_TABLE}
         where matter_target_id = :id and matter = 'REP' order by matter_category, rater_profile_id`,
        { id: ALICE }
      );
      expect(rows.map((it: any) => [it.matter_category, it.rating])).toEqual(
        expect.arrayContaining([
          [HELP_BOT_CREDIT_CATEGORY, 10],
          ['Old', 1],
          ['Old', 2]
        ])
      );
      expect(rows).toHaveLength(3);
      const events = await sqlExecutor.execute<any>(
        `select matter_category, new_rating, total_after
         from ${IDENTITY_CHAIN_RATING_EVENTS_TABLE} order by matter_category`
      );
      expect(
        events.map((it: any) => [
          it.matter_category,
          Number(it.new_rating),
          Number(it.total_after)
        ])
      ).toEqual([
        ['Kind', 0, 0],
        ['Old', 2, 3]
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
      // The pairs of a wallet to keep stay; the others are replaced.
      await inTx((conn) =>
        db.replaceAllPairs([], 1_000_000_200, 2, conn, [B.toUpperCase()])
      );
      expect(
        await sqlExecutor.execute<any>(
          `select wallet1, wallet2 from ${CONSOLIDATIONS_TABLE}`
        )
      ).toEqual([{ wallet1: A, wallet2: B }]);
    });

    it('keeps first bindings, regroups to re-key and mapped profile ids', async () => {
      await inTx((conn) =>
        db.recordFirstBindings(
          [
            { wallet: A, principal_id: P, height: 3 },
            { wallet: B, principal_id: Q, height: 4 }
          ],
          conn
        )
      );
      // A wallet keeps its first.
      await inTx((conn) =>
        db.recordFirstBindings(
          [{ wallet: A, principal_id: Q, height: 9 }],
          conn
        )
      );
      expect(await db.firstBindingOf(A)).toEqual({
        first: { wallet: A, principal_id: P, height: 3 },
        exact: false,
        nextHeight: null
      });
      expect((await db.firstBindingOf(C)).first).toBeNull();
      await inTx((conn) => db.clearWalletBindings(conn));
      expect((await db.firstBindingOf(A)).first).toBeNull();

      await inTx((conn) => db.queueRegroups([A, B], 10, conn));
      await inTx((conn) => db.queueRegroups([B], 20, conn));
      expect(await db.pendingRegroups(10)).toEqual([A, B]);
      expect(await db.pendingRegroups(1)).toEqual([A]);
      // B was queued again after the re-keying began: it stays.
      await db.regroupsDone([A, B], 15);
      expect(await db.pendingRegroups(10)).toEqual([B]);

      await inTx((conn) => db.insertMapping(P, ALICE, 'LEGACY', 1, conn));
      expect(await db.profileIdsOfPrincipals([P.toUpperCase(), Q])).toEqual(
        new Map([[P, ALICE]])
      );
    });
  }
);
