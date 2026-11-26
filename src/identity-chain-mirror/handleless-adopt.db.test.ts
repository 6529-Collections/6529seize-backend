import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE
} from '@/constants';
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
      aProfile({ external_id: RATER, handle: 'rater', primary_wallet: W(0x99) })
    ]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: D, consolidation_key: D },
        { address: E, consolidation_key: EF },
        { address: F, consolidation_key: EF },
        { address: G, consolidation_key: G },
        { address: H, consolidation_key: H },
        { address: J, consolidation_key: J }
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
        await db.applyIdentityPlan(planned, 1_000_000_100, 99, conn);
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
