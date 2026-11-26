import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { addressIdentityId } from '@/identities/address-identity-id';
import { identitiesDb } from '@/identities/identities.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { consolidationKeyOf, planIdentity } from './identity-plan';
import { EMPTY_PROFILE_DOC_FIELDS } from './profile-doc';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** A wallet a group listed: 6529.io gave it a handle-less row. */
const D = W(0xd1);
/** Two wallets of a handle-less row step B made. */
const E = W(0xe1);
const F = W(0xf1);
const EF = consolidationKeyOf([E, F]);
/** A placeholder's wallet: its row has a handle. */
const G = W(0x61);
/** A handle-less row whose id a principal already holds. */
const H = W(0x71);
/** A handle-less row with a profiles row. */
const J = W(0x81);

const ROW_D = '00000000-0000-4000-8000-0000000000d1';
const ROW_EF = '00000000-0000-4000-8000-0000000000ef';
const PLACE_G = '00000000-0000-4000-8000-000000000061';
const ROW_H = '00000000-0000-4000-8000-000000000071';
const ROW_J = '00000000-0000-4000-8000-000000000081';
const RATER = '00000000-0000-4000-8000-00000000a7e1';
const GROUP = 'group-listing-d';
const P = '0x' + 'ab'.repeat(32);
/** An identity of two wallets; L leaves it. */
const K = W(0x4b);
const L = W(0x4c);
const KL = consolidationKeyOf([K, L]);
const ROW_KL = '00000000-0000-4000-8000-00000000004b';
/** A second pair, whose leaver's first derived id a profile holds. */
const M = W(0x4d);
const N = W(0x4e);
const MN = consolidationKeyOf([M, N]);
const ROW_MN = '00000000-0000-4000-8000-00000000004d';

const SWITCH_ON = '2026-11-28T00:00:00Z';
const AFTER_SWITCH_ON = Date.parse('2026-11-28T00:01:00Z');
const BEFORE_SWITCH_ON = Date.parse('2026-11-27T23:59:00Z');

const db = new IdentityChainMirrorDb(() => sqlExecutor);
const inTx = <T>(fn: (conn: any) => Promise<T>) =>
  sqlExecutor.executeNativeQueriesInTransaction(fn);

/** An identities row without a handle, as 6529.io makes them. */
function handleless(key: string, profileId: string, primary: string) {
  return {
    ...anIdentity(
      {},
      {
        consolidation_key: key,
        profile_id: profileId,
        primary_address: primary,
        handle: 'unused'
      }
    ),
    handle: null,
    normalised_handle: null
  } as never;
}

describeWithSeed(
  "the mirror and 6529.io's handle-less rows",
  [
    withIdentities([
      handleless(D, ROW_D, D),
      handleless(EF, ROW_EF, E),
      anIdentity(
        {},
        {
          consolidation_key: G,
          profile_id: PLACE_G,
          primary_address: G,
          handle: `id-${G}`
        }
      ),
      handleless(H, ROW_H, H),
      handleless(J, ROW_J, J),
      anIdentity(
        {},
        {
          consolidation_key: KL,
          profile_id: ROW_KL,
          primary_address: K,
          handle: 'kay'
        }
      ),
      anIdentity(
        {},
        {
          consolidation_key: MN,
          profile_id: ROW_MN,
          primary_address: M,
          handle: 'em'
        }
      ),
      anIdentity(
        {},
        {
          consolidation_key: W(0x99),
          profile_id: RATER,
          primary_address: W(0x99),
          handle: 'rater'
        }
      )
    ]),
    withProfiles([
      aProfile({ external_id: PLACE_G, handle: `id-${G}`, primary_wallet: G }),
      aProfile({
        external_id: ROW_J,
        handle: 'has-a-profile',
        primary_wallet: J
      }),
      aProfile({
        external_id: RATER,
        handle: 'rater',
        primary_wallet: W(0x99)
      }),
      aProfile({ external_id: ROW_KL, handle: 'kay', primary_wallet: K }),
      aProfile({ external_id: ROW_MN, handle: 'em', primary_wallet: M }),
      // A profile already holds N's first derived id.
      aProfile({
        external_id: addressIdentityId(N),
        handle: 'holds-n0',
        primary_wallet: W(0x5e)
      })
    ]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: D, consolidation_key: D },
        { address: E, consolidation_key: EF },
        { address: F, consolidation_key: EF },
        { address: G, consolidation_key: G },
        { address: H, consolidation_key: H },
        { address: J, consolidation_key: J },
        { address: K, consolidation_key: KL },
        { address: L, consolidation_key: KL },
        { address: M, consolidation_key: MN },
        { address: N, consolidation_key: MN }
      ]
    },
    {
      table: IDENTITY_CHAIN_PRINCIPALS_TABLE,
      rows: [
        {
          principal_id: '0x' + '71'.repeat(32),
          profile_id: ROW_H,
          origin: 'NEW',
          created_at: 1
        }
      ]
    },
    // What 6529.io let name D's row before switch-on: a REP rating of it,
    // a follow of it, and a group listing D.
    withRatings([
      aRepRating({
        rater_profile_id: RATER,
        matter_target_id: ROW_D,
        matter_category: 'Kind',
        rating: 5
      })
    ]),
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: RATER,
          target_id: ROW_D,
          target_type: 'IDENTITY',
          target_action: 'DROP_CREATED'
        }
      ]
    },
    {
      table: PROFILE_GROUPS_TABLE,
      rows: [{ profile_group_id: GROUP, profile_id: ROW_D }]
    }
  ],
  () => {
    const saved = process.env.IDENTITY_SWITCH_ON_AT;
    beforeEach(() => {
      process.env.IDENTITY_SWITCH_ON_AT = SWITCH_ON;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.IDENTITY_SWITCH_ON_AT;
      else process.env.IDENTITY_SWITCH_ON_AT = saved;
    });

    /** The identity keeps its first wallet; the second leaves it. */
    async function leave(
      keep: string,
      key: string,
      profileId: string,
      eventTime: number
    ) {
      return await inTx(async (conn) => {
        const state = await db.readIdentityState(
          [keep],
          profileId,
          null,
          keep,
          conn
        );
        const plan = planIdentity(
          {
            principalId: '0x' + keep.slice(2, 66).padEnd(64, '0'),
            profileId,
            handle: null,
            wallets: [keep],
            primary: keep,
            doc: { ...EMPTY_PROFILE_DOC_FIELDS },
            rep: 0,
            cic: 0,
            levelRaw: 0
          },
          state
        );
        expect(state.rows.map((it) => it.consolidation_key)).toEqual([key]);
        await db.applyIdentityPlan(plan, 1_000_000_200, 99, conn, eventTime);
        return plan;
      });
    }

    async function idOf(key: string): Promise<string | null> {
      const [row] = await sqlExecutor.execute<{ profile_id: string | null }>(
        `select profile_id from ${IDENTITIES_TABLE} where consolidation_key = :key`,
        { key }
      );
      return row?.profile_id ?? null;
    }

    async function oneIdPerRow() {
      expect(
        await sqlExecutor.execute(
          `select profile_id from ${IDENTITIES_TABLE}
           where profile_id is not null
           group by profile_id having count(*) > 1`
        )
      ).toEqual([]);
    }

    it('finds the ids an identities row or a profile holds', async () => {
      const free = '00000000-0000-4000-8000-0000000f4ee0';
      expect(
        Array.from(
          await identitiesDb.takenProfileIds([
            ROW_D,
            PLACE_G.toUpperCase(),
            free
          ])
        ).sort()
      ).toEqual([ROW_D, PLACE_G].sort());
      expect(await identitiesDb.takenProfileIds([])).toEqual(new Set());
    });

    it("gives a wallet leaving an identity after switch-on its address's derived id", async () => {
      const plan = await leave(K, KL, ROW_KL, AFTER_SWITCH_ON);
      expect(plan.soloRows.map((it) => it.consolidation_key)).toEqual([L]);
      expect(await idOf(L)).toBe(addressIdentityId(L));
      expect(await idOf(K)).toBe(ROW_KL);
      await oneIdPerRow();
    });

    it('takes the next derived id when a profile holds the first', async () => {
      await leave(M, MN, ROW_MN, AFTER_SWITCH_ON);
      expect(await idOf(N)).toBe(addressIdentityId(N, 1));
      await oneIdPerRow();
    });

    it('gives a random id for an event before switch-on, never none', async () => {
      await leave(K, KL, ROW_KL, BEFORE_SWITCH_ON);
      const id = await idOf(L);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe(addressIdentityId(L));
      await oneIdPerRow();
    });

    it('reads the handle-less rows: no handle, no profiles row, no principal', async () => {
      expect(await db.handlelessRowsOf([D], D)).toEqual([
        { consolidation_key: D, profile_id: ROW_D }
      ]);
      // By a wallet the row holds under another key.
      expect(await db.handlelessRowsOf([E], E)).toEqual([
        { consolidation_key: EF, profile_id: ROW_EF }
      ]);
      // A placeholder (handle), a mapped row and a row with a profile: none.
      expect(await db.handlelessRowsOf([G], G)).toEqual([]);
      expect(await db.handlelessRowsOf([H], H)).toEqual([]);
      expect(await db.handlelessRowsOf([J], J)).toEqual([]);
    });

    it("keeps a single-wallet row's id, and what names it, when an identity with its key takes it", async () => {
      // The id ProfileIds gives an identity whose key equals the row's.
      const [adopted] = await db.handlelessRowsOf([D], D);
      expect(adopted.profile_id).toBe(ROW_D);
      const plan = await inTx(async (conn) => {
        const state = await db.readIdentityState(
          [D],
          adopted.profile_id,
          null,
          D,
          conn
        );
        const planned = planIdentity(
          {
            principalId: P,
            profileId: adopted.profile_id,
            handle: null,
            wallets: [D],
            primary: D,
            doc: { ...EMPTY_PROFILE_DOC_FIELDS },
            rep: 5,
            cic: 0,
            levelRaw: 5
          },
          state
        );
        await db.applyIdentityPlan(
          planned,
          1_000_000_100,
          99,
          conn,
          AFTER_SWITCH_ON
        );
        return planned;
      });
      expect(plan.orphanedProfiles).toEqual([]);
      const rows = await sqlExecutor.execute<{
        consolidation_key: string;
        profile_id: string;
      }>(
        `select consolidation_key, profile_id from ${IDENTITIES_TABLE}
         where consolidation_key = :key`,
        { key: D }
      );
      expect(rows).toEqual([{ consolidation_key: D, profile_id: ROW_D }]);
      // The rating, the follow and the group member still name a row that
      // exists, under the same id.
      const named = async (sql: string) =>
        (await sqlExecutor.execute<{ id: string }>(sql)).map((it) => it.id);
      expect(
        await named(
          `select matter_target_id as id from ${RATINGS_TABLE} where matter_category = 'Kind'`
        )
      ).toEqual([ROW_D]);
      expect(
        await named(
          `select target_id as id from ${IDENTITY_SUBSCRIPTIONS_TABLE} where subscriber_id = '${RATER}'`
        )
      ).toEqual([ROW_D]);
      expect(
        await named(
          `select profile_id as id from ${PROFILE_GROUPS_TABLE} where profile_group_id = '${GROUP}'`
        )
      ).toEqual([ROW_D]);
    });

    it('leaves a row whose key differs from the identity’s to the plan, under its own id', async () => {
      // An identity with E alone: the row E-F keeps F and its id.
      const plan = await inTx(async (conn) => {
        const state = await db.readIdentityState(
          [E],
          '00000000-0000-4000-8000-0000000000e0',
          null,
          E,
          conn
        );
        return planIdentity(
          {
            principalId: '0x' + 'e0'.repeat(32),
            profileId: '00000000-0000-4000-8000-0000000000e0',
            handle: null,
            wallets: [E],
            primary: E,
            doc: { ...EMPTY_PROFILE_DOC_FIELDS },
            rep: 0,
            cic: 0,
            levelRaw: 0
          },
          state
        );
      });
      expect(plan.orphanedProfiles).toEqual([]);
      expect(plan.rekeyedRows).toEqual([
        expect.objectContaining({ consolidation_key: F, profile_id: ROW_EF })
      ]);
    });
  }
);
