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
          levels_tdh_day: null,
          level_sweep_day: null,
          level_sweep_after: null,
          levels_day_height: null,
          sync_use_case: null,
          sync_wallet_after: null,
          pin_floor: null,
          off_chain_after: null,
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
          levels_tdh_day: 25,
          level_sweep_day: 25,
          level_sweep_after: 'ranked-after',
          levels_day_height: 700,
          sync_use_case: 997,
          sync_wallet_after: B,
          pin_floor: 812,
          off_chain_after: C,
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
          levels_tdh_day: 25,
          level_sweep_day: 25,
          level_sweep_after: 'ranked-after',
          levels_day_height: 700,
          sync_use_case: 997,
          sync_wallet_after: B,
          pin_floor: 812,
          off_chain_after: C,
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

    it('keeps help-bot credits however the category is written', async () => {
      await sqlExecutor.execute(
        `update ${RATINGS_TABLE} set matter_category = ' HELP6529 credits '
         where matter_category = :helpBot`,
        { helpBot: HELP_BOT_CREDIT_CATEGORY }
      );
      await inTx((conn) => db.replaceTargetRatings(ALICE, [], 1, conn));
      const rows = await sqlExecutor.execute<any>(
        `select matter_category from ${RATINGS_TABLE} where matter_target_id = :id`,
        { id: ALICE }
      );
      expect(rows.map((it: any) => it.matter_category)).toEqual([
        ' HELP6529 credits '
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
          conn
        )
      );
      expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });
      // The event log is the feed's: nothing is written to it here.
      const [events] = await sqlExecutor.execute<any>(
        `select count(*) as n from ${IDENTITY_CHAIN_RATING_EVENTS_TABLE}`
      );
      expect(Number(events.n)).toBe(0);
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

    it("keeps the given raters' rows it is not given", async () => {
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
    });

    it('writes a rating event once per key and height, and reads 6529.io values', async () => {
      const row = (height: number, newRating: number) => ({
        height,
        block_time_ms: 1_764_000_000_000 + height,
        rater_principal: P,
        rater_profile_id: BOB,
        target_principal: Q,
        target_profile_id: ALICE,
        matter: 'REP' as const,
        matter_category: 'Kind',
        old_rating: 3,
        new_rating: newRating,
        origin: 'OPERATION',
        by_import: false,
        writer: 'tx:RATING_SET'
      });
      expect(await db.insertRatingEvents([row(90, 4), row(91, 6)], 1)).toBe(2);
      // A page read again: the same key and height are left as they are.
      expect(await db.insertRatingEvents([row(90, 5), row(92, 7)], 2)).toBe(1);
      const events = await sqlExecutor.execute<any>(
        `select height, block_time_ms, new_rating, origin, by_import, writer, source
         from ${IDENTITY_CHAIN_RATING_EVENTS_TABLE} order by height`
      );
      expect(
        events.map((it: any) => [
          Number(it.height),
          Number(it.new_rating),
          it.origin,
          Number(it.by_import),
          it.writer,
          it.source
        ])
      ).toEqual([
        [90, 4, 'OPERATION', 0, 'tx:RATING_SET', 'FEED'],
        [91, 6, 'OPERATION', 0, 'tx:RATING_SET', 'FEED'],
        [92, 7, 'OPERATION', 0, 'tx:RATING_SET', 'FEED']
      ]);
      expect(Number(events[0].block_time_ms)).toBe(1_764_000_000_090);
      // A row without profiles is kept too.
      expect(
        await db.insertRatingEvents(
          [{ ...row(93, 1), rater_profile_id: null, target_profile_id: null }],
          3
        )
      ).toBe(1);
      // The seeded ratings of Alice, by key.
      const values = await db.ratingsOf([
        {
          rater_profile_id: BOB,
          target_profile_id: ALICE,
          matter: 'REP',
          matter_category: 'Kind'
        },
        {
          rater_profile_id: BOB,
          target_profile_id: ALICE,
          matter: 'REP',
          matter_category: 'Nothing'
        }
      ]);
      expect(Array.from(values.values())).toEqual([3]);
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

    it("writes only level_raw of mapped profiles' rows, never over a later level", async () => {
      await inTx((conn) => db.insertMapping(P, ALICE, 'LEGACY', 1, conn));
      // PLACE's row isn't mapped: left alone.
      const before = await sqlExecutor.execute<any>(
        `select profile_id, tdh, rep, level_raw from ${IDENTITIES_TABLE} order by profile_id`
      );
      const alice = before.find((it: any) => it.profile_id === ALICE);
      await db.writeLevels(
        [
          { profile_id: ALICE, level_raw: 4321 },
          { profile_id: PLACE, level_raw: 9 }
        ],
        100
      );
      const levels = async () =>
        await sqlExecutor.execute<any>(
          `select profile_id, tdh, rep, level_raw from ${IDENTITIES_TABLE} order by profile_id`
        );
      expect(await levels()).toEqual(
        before.map((it: any) =>
          it.profile_id === ALICE ? { ...alice, level_raw: 4321 } : it
        )
      );
      expect(await db.levelHeightOf(P)).toBe(100);
      // An older level isn't written; one as late is.
      await db.writeLevels([{ profile_id: ALICE, level_raw: 1 }], 99);
      expect(
        (await levels()).find((it: any) => it.profile_id === ALICE).level_raw
      ).toBe(4321);
      await db.writeLevels([{ profile_id: ALICE, level_raw: 5000 }], 100);
      expect(
        (await levels()).find((it: any) => it.profile_id === ALICE).level_raw
      ).toBe(5000);
      // The feed's writes move the height on, never back.
      await inTx((conn) => db.setLevelHeight(P, 50, conn));
      expect(await db.levelHeightOf(P)).toBe(100);
      await inTx((conn) => db.setLevelHeight(P, 120, conn));
      expect(await db.levelHeightOf(P)).toBe(120);
      await db.writeLevels([], 1);
      // A relaunch takes every level height away.
      await inTx((conn) => db.clearLevelHeights(conn));
      expect(await db.levelHeightOf(P)).toBeNull();
      // A decision for an identity filed without a mapping is kept.
      expect(await db.founderDecisionOf(Q)).toBeNull();
      await db.founderDecided(Q, 'derived-id', 5);
      expect(await db.founderDecisionOf(Q)).toBe('derived-id');
      // A founder wait starts once and ends.
      expect(await db.founderWaitSince(P, 10)).toBe(10);
      expect(await db.founderWaitSince(P, 20)).toBe(10);
      await db.founderWaitDone(P);
      expect(await db.founderWaitSince(P, 30)).toBe(30);
    });

    it('takes the credits and xTDH out of rows off the chain, in chunks, keeping CIC', async () => {
      // Alice is mapped; PLACE's row isn't. Seeded ratings of ALICE: BOB's
      // Kind 3, PLACE's Old 1, BOB's credits 10. PLACE gets credits too.
      await inTx((conn) => db.insertMapping(P, ALICE, 'LEGACY', 1, conn));
      await sqlExecutor.execute(
        `insert into ${RATINGS_TABLE}
           (rater_profile_id, matter_target_id, matter, matter_category, rating, last_modified)
         values (:bob, :place, 'REP', ' help6529 credits ', 6, now()),
                (:bob, :place, 'REP', 'Kind', 4, now())`,
        { bob: BOB, place: PLACE }
      );
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set rep = 10, cic = 3, tdh = 20, level_raw = 99
         where profile_id in (:ids)`,
        { ids: [ALICE, PLACE] }
      );
      const rowOf = async (profileId: string) =>
        (
          await sqlExecutor.execute<any>(
            `select rep, cic, tdh, level_raw from ${IDENTITIES_TABLE} where profile_id = :id`,
            { id: profileId }
          )
        ).map((it: any) => [
          Number(it.rep),
          Number(it.cic),
          Number(it.level_raw)
        ])[0];
      // A profile id left out (an identity waiting to be retried) is not
      // taken for one off the chain.
      expect(
        await db.fixRowsOffTheChain({ chunk: 1, leaveOut: [PLACE] })
      ).toEqual({ rep: 0, level: 0 });
      expect(await rowOf(PLACE)).toEqual([10, 3, 99]);
      // The levels alone: REP keeps its credits.
      expect(await db.fixRowsOffTheChain({ chunk: 1, repToo: false })).toEqual({
        rep: 0,
        level: 1
      });
      expect(await rowOf(PLACE)).toEqual([10, 3, 30]);
      expect(await db.fixRowsOffTheChain({ chunk: 1 })).toEqual({
        rep: 1,
        level: 1
      });
      // PLACE: REP 4 without the credits, CIC kept, level 4 + 20.
      expect(await rowOf(PLACE)).toEqual([4, 3, 24]);
      // Alice is a chain identity: the mirror's, left alone.
      expect(await rowOf(ALICE)).toEqual([10, 3, 99]);
      expect(await db.fixRowsOffTheChain({ chunk: 1 })).toEqual({
        rep: 0,
        level: 0
      });
      // A row without a profile gets its level too, a chunk at a time.
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE}
           (consolidation_key, profile_id, primary_address, handle, normalised_handle,
            tdh, rep, cic, level_raw, xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
         values (:key, null, :key, null, null, 7, 2, 0, 50, 41, 0, 0, 0, 0)`,
        { key: W(60) }
      );
      const first = await db.fixLevelsOffTheChain({
        after: '',
        chunks: 1,
        chunk: 1
      });
      expect(first.after).not.toBeNull();
      let level = first.level;
      let after = first.after;
      while (after !== null) {
        const step = await db.fixLevelsOffTheChain({
          after,
          chunks: 1,
          chunk: 1
        });
        level += step.level;
        after = step.after;
      }
      expect(level).toBe(1);
      const [nullRow] = await sqlExecutor.execute<any>(
        `select level_raw from ${IDENTITIES_TABLE} where consolidation_key = :key`,
        { key: W(60) }
      );
      expect(Number(nullRow.level_raw)).toBe(9);
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
      // A batch taken up and not finished is counted; the next one, half
      // of it, is all that is counted then; one finished clears it.
      await db.regroupsStarted([A, B], 12);
      expect(await db.unfinishedRegroups()).toBe(2);
      await db.regroupsStarted([A], 13);
      expect(await db.unfinishedRegroups()).toBe(1);
      await db.regroupsStarted([A, B], 14);
      // B was queued again after the re-keying began: it stays.
      await db.regroupsDone([A, B], 15);
      expect(await db.pendingRegroups(10)).toEqual([B]);
      expect(await db.unfinishedRegroups()).toBe(0);

      await inTx((conn) => db.insertMapping(P, ALICE, 'LEGACY', 1, conn));
      expect(await db.profileIdsOfPrincipals([P.toUpperCase(), Q])).toEqual(
        new Map([[P, ALICE]])
      );
    });
  }
);
