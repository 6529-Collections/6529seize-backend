import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE
} from '@/constants';
import { addressIdentityId } from '@/identities/address-identity-id';
import { identitiesDb } from '@/identities/identities.db';
import { IdentityChainMirrorDb } from '@/identity-chain-mirror/identity-chain-mirror.db';
import { planIdentity } from '@/identity-chain-mirror/identity-plan';
import { EMPTY_PROFILE_DOC_FIELDS } from '@/identity-chain-mirror/profile-doc';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { Time } from '@/time';
import { UserGroupsDb } from '@/user-groups/user-groups.db';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** Addresses no identities row holds. */
const A = W(0xa1);
const A2 = W(0xa2);
/** An address whose first two derived ids a row and a profile hold. */
const T = W(0x7a);
/** An address with its own row but no profile id. */
const N = W(0x0e);
/** An address another writer gave a row first. */
const R = W(0x0f);
/** An address with its own row and id, but no mapping. */
const U = W(0x1f);
/** Two wallets of one row without a profile id. */
const X = W(0x51);
const Y = W(0x52);
const XY = `${X}-${Y}`;
/** An identity of two wallets with a profile id; only V2 is mapped to it. */
const V1 = W(0x61);
const V2 = W(0x62);
const VV = `${V1}-${V2}`;
const ROW_VV = '00000000-0000-4000-8000-000000000061';
/** An identity's wallet; A joins the identity, then leaves it. */
const B = W(0xb1);

const ROW_R = '00000000-0000-4000-8000-0000000000f0';
const ROW_U = '00000000-0000-4000-8000-0000000001f0';
const PROF_B = '00000000-0000-4000-8000-0000000000b1';

const SWITCH_ON = '2026-11-28T00:00:00Z';
const switchOn = Date.parse(SWITCH_ON);
const AFTER = switchOn + 60_000;
const BEFORE = switchOn - 60_000;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const mirrorDb = new IdentityChainMirrorDb(() => sqlExecutor);
const inTx = <T>(fn: (conn: any) => Promise<T>) =>
  sqlExecutor.executeNativeQueriesInTransaction(fn);

/** An identities row without a handle, as 6529.io makes them. */
function handleless(key: string, profileId: string | null, primary: string) {
  return {
    ...anIdentity(
      {},
      {
        consolidation_key: key,
        profile_id: profileId ?? 'unused',
        primary_address: primary,
        handle: 'unused'
      }
    ),
    profile_id: profileId,
    handle: null,
    normalised_handle: null
  } as never;
}

describeWithSeed(
  'address-only identities, as a group listing addresses gives them',
  [
    withIdentities([
      // Another row holds T's first derived id.
      handleless(W(0x99), addressIdentityId(T), W(0x99)),
      handleless(N, null, N),
      handleless(R, ROW_R, R),
      handleless(U, ROW_U, U),
      handleless(XY, null, X),
      handleless(VV, ROW_VV, V2),
      anIdentity(
        {},
        {
          consolidation_key: B,
          profile_id: PROF_B,
          primary_address: B,
          handle: 'bee'
        }
      )
    ]),
    withProfiles([
      // A profile holds T's second derived id.
      aProfile({
        external_id: addressIdentityId(T, 1),
        handle: 'holds-t1',
        primary_wallet: W(0x98)
      }),
      aProfile({ external_id: PROF_B, handle: 'bee', primary_wallet: B })
    ]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: W(0x99), consolidation_key: W(0x99) },
        { address: N, consolidation_key: N },
        { address: R, consolidation_key: R },
        { address: X, consolidation_key: XY },
        { address: Y, consolidation_key: XY },
        { address: V2, consolidation_key: VV },
        { address: B, consolidation_key: B }
      ]
    }
  ],
  () => {
    const saved = {
      at: process.env.IDENTITY_SWITCH_ON_AT,
      flag: process.env.FEATURE_IDENTITY_ON_CHAIN
    };
    beforeEach(() => {
      process.env.IDENTITY_SWITCH_ON_AT = SWITCH_ON;
      delete process.env.FEATURE_IDENTITY_ON_CHAIN;
    });
    afterEach(() => {
      for (const [name, value] of [
        ['IDENTITY_SWITCH_ON_AT', saved.at],
        ['FEATURE_IDENTITY_ON_CHAIN', saved.flag]
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const give = (addresses: string[], at: number) =>
      inTx((conn) =>
        identitiesDb.insertIdentitiesOnAddressesOnly(addresses, conn, at)
      );

    /** Each row under an address's own key: its profile id. */
    async function rowsOf(address: string) {
      return sqlExecutor.execute<{
        consolidation_key: string;
        profile_id: string | null;
        primary_address: string;
      }>(
        `select consolidation_key, profile_id, primary_address
           from ${IDENTITIES_TABLE} where primary_address = :address`,
        { address }
      );
    }

    async function mappingOf(address: string) {
      return (
        await sqlExecutor.execute<{ consolidation_key: string }>(
          `select consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} where address = :address`,
          { address }
        )
      ).map((it) => it.consolidation_key);
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

    it('gives an address its derived id from switch-on, lowercased, with its row and mapping', async () => {
      const given = await give([A.toUpperCase().replace('0X', '0x')], AFTER);
      expect(given).toEqual(new Map([[A, addressIdentityId(A)]]));
      expect(await rowsOf(A)).toEqual([
        {
          consolidation_key: A,
          profile_id: addressIdentityId(A),
          primary_address: A
        }
      ]);
      expect(await mappingOf(A)).toEqual([A]);
      await oneIdPerRow();
    });

    it('counts the switch-on time itself as switched on', async () => {
      const given = await give([A], switchOn);
      expect(given.get(A)).toBe(addressIdentityId(A));
    });

    it('gives a random id before switch-on, never none', async () => {
      const given = await give([A, A2], BEFORE);
      expect(given.get(A)).toMatch(UUID_V4);
      expect(given.get(A2)).toMatch(UUID_V4);
      expect(given.get(A)).not.toBe(addressIdentityId(A));
      expect((await rowsOf(A))[0].profile_id).toBe(given.get(A));
    });

    it('takes the next derived id when a row or a profile holds the earlier ones', async () => {
      const given = await give([T, A], AFTER);
      expect(given.get(T)).toBe(addressIdentityId(T, 2));
      expect(given.get(A)).toBe(addressIdentityId(A));
      await oneIdPerRow();
    });

    it("turns an address's own row without a profile id into its derived one, never a second row", async () => {
      const given = await give([N], AFTER);
      expect(given.get(N)).toBe(addressIdentityId(N));
      expect(await rowsOf(N)).toEqual([
        {
          consolidation_key: N,
          profile_id: addressIdentityId(N),
          primary_address: N
        }
      ]);
      await oneIdPerRow();
    });

    it('leaves a row another writer made first as it is, and reads its id back', async () => {
      const given = await give([R], AFTER);
      expect(given.get(R)).toBe(ROW_R);
      expect(await rowsOf(R)).toEqual([
        { consolidation_key: R, profile_id: ROW_R, primary_address: R }
      ]);
    });

    it("maps an address to its own row when the mapping is missing, keeping the row's id", async () => {
      const given = await give([U], AFTER);
      expect(given.get(U)).toBe(ROW_U);
      expect(await mappingOf(U)).toEqual([U]);
    });

    it('leaves an address mapped to a row of several wallets without an id as it is', async () => {
      const given = await give([X], AFTER);
      expect(given.has(X)).toBe(false);
      expect(await rowsOf(X)).toEqual([
        { consolidation_key: XY, profile_id: null, primary_address: X }
      ]);
      expect(await mappingOf(X)).toEqual([XY]);
    });

    type Isolation = 'REPEATABLE READ' | 'READ COMMITTED';
    const inTxAt = <T>(isolation: Isolation, fn: (conn: any) => Promise<T>) =>
      sqlExecutor.executeNativeQueriesInTransaction(
        fn,
        isolation === 'READ COMMITTED'
          ? { isolationLevel: 'READ COMMITTED' }
          : { isolationLevel: 'REPEATABLE READ' }
      );

    /** A promise and the function that resolves it. */
    function gate<T = void>() {
      let open!: (value: T) => void;
      const opened = new Promise<T>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    }

    /**
     * Waits until the transaction on this connection waits for a lock: polls
     * innodb_trx every 200 ms (MySQL refreshes it after 100 ms without a
     * read, and other readers restart that clock) up to a 15 s deadline.
     */
    async function waitsForLock(threadId: number) {
      const deadline = Date.now() + 15_000;
      let state = 'no transaction';
      while (Date.now() < deadline) {
        const [row] = await sqlExecutor.execute<{ trx_state: string }>(
          `select trx_state from information_schema.innodb_trx
            where trx_mysql_thread_id = :id`,
          { id: threadId }
        );
        state = row?.trx_state ?? 'no transaction';
        if (state === 'LOCK WAIT') return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(
        `connection ${threadId} never waited for a lock (last state: ${state})`
      );
    }

    /**
     * `held` runs in a transaction whose commit is held until the writer,
     * started after it, waits for one of its locks; the writer gives
     * `address` its identity in its own transaction. Returns the writer's
     * ids, the held transaction's result and the order things ended in.
     */
    async function whileHeld<T>(
      isolation: Isolation,
      address: string,
      at: number,
      held: (conn: any) => Promise<T>
    ) {
      const done = gate();
      const release = gate();
      const thread = gate<number | null>();
      const order: string[] = [];
      const first = inTxAt(isolation, async (conn) => {
        const result = await held(conn);
        done.open();
        await release.opened;
        order.push('held commits');
        return result;
      });
      let writer: Promise<Map<string, string>> | null = null;
      try {
        await Promise.race([done.opened, first]);
        writer = inTxAt(isolation, async (conn) => {
          const [{ id }] = await sqlExecutor.execute<{ id: number }>(
            'select connection_id() as id',
            undefined,
            { wrappedConnection: conn }
          );
          thread.open(Number(id));
          const ids = await identitiesDb.insertIdentitiesOnAddressesOnly(
            [address],
            conn,
            at
          );
          order.push('writer done');
          return ids;
        });
        const threadId = await Promise.race([
          thread.opened,
          writer.then(() => null)
        ]);
        if (threadId === null) {
          throw new Error('the writer finished without waiting for a lock');
        }
        await waitsForLock(threadId);
      } catch (error) {
        // Let the held transaction go, so its locks don't hold up the next
        // test's reset, and report this one failure.
        release.open();
        await Promise.allSettled([first, writer]);
        throw error;
      }
      order.push('released');
      release.open();
      const [heldResult, ids] = await Promise.all([first, writer!]);
      return { heldResult, ids, order };
    }

    describe.each(['REPEATABLE READ', 'READ COMMITTED'] as const)(
      'in %s',
      (isolation) => {
        it.each([
          ['from switch-on', AFTER],
          ['before switch-on', BEFORE]
        ])(
          "gives two writers racing on one address the same id, %s: one row, the loser reads the winner's",
          async (_, at) => {
            // The first writer gives A its row and holds its commit; the
            // second reads no row and waits on the first's row lock.
            const {
              heldResult: one,
              ids: two,
              order
            } = await whileHeld(isolation, A, at, (conn) =>
              identitiesDb.insertIdentitiesOnAddressesOnly([A], conn, at)
            );
            expect(order).toEqual(['released', 'held commits', 'writer done']);
            expect(one.get(A)).toBeDefined();
            expect(two).toEqual(one);
            if (at === AFTER) expect(one.get(A)).toBe(addressIdentityId(A));
            else expect(one.get(A)).toMatch(UUID_V4);
            expect(await rowsOf(A)).toEqual([
              {
                consolidation_key: A,
                profile_id: one.get(A),
                primary_address: A
              }
            ]);
            expect(await mappingOf(A)).toEqual([A]);
            await oneIdPerRow();
          }
        );

        it('takes back the row it made when another writer maps the address to an identity meanwhile', async () => {
          // Another writer maps V1 to the identity V1-V2 and holds its commit:
          // this call's reads miss that mapping, so it makes V1 a row, then
          // waits on the mapping.
          const { ids, order } = await whileHeld(isolation, V1, AFTER, (conn) =>
            sqlExecutor.execute(
              `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
               values (:a, :key)`,
              { a: V1, key: VV },
              { wrappedConnection: conn }
            )
          );
          expect(order).toEqual(['released', 'held commits', 'writer done']);
          expect(
            await sqlExecutor.execute(
              `select 1 from ${IDENTITIES_TABLE} where consolidation_key = :a`,
              { a: V1 }
            )
          ).toEqual([]);
          expect(await mappingOf(V1)).toEqual([VV]);
          expect(ids).toEqual(new Map([[V1, ROW_VV]]));
          await oneIdPerRow();
        });
      }
    );

    it('refuses, naming them, to list addresses an identity of several wallets without a profile id holds, writing nothing', async () => {
      process.env.IDENTITY_SWITCH_ON_AT = '2026-11-24T00:00:00Z';
      const groups = new UserGroupsDb(() => sqlExecutor);
      await expect(
        inTx((conn) => groups.insertGroupEntriesAndGetGroupIds([A, X], conn))
      ).rejects.toThrow(
        `These addresses have no profile to list in a group: ${X}`
      );
      // The transaction rolled back: A was given no row.
      expect(await rowsOf(A)).toEqual([]);
      expect(
        await sqlExecutor.execute(`select 1 from ${PROFILE_GROUPS_TABLE}`)
      ).toEqual([]);
    });

    it('rolls back the change records of the addresses it listed when a later chunk is refused', async () => {
      // A wallet of an identity of several wallets without a profile id,
      // listed after a first chunk of 100 addresses that get theirs.
      const Z1 = W(0xfff1);
      const ZZ = `${Z1}-${W(0xfff2)}`;
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE}
           (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
         values (null, :key, :z, 0, 0, 0, 0)`,
        { key: ZZ, z: Z1 }
      );
      await sqlExecutor.execute(
        `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values (:z, :key)`,
        { key: ZZ, z: Z1 }
      );
      const first = Array.from({ length: 100 }, (_, i) => W(0x1000 + i));
      const groups = new UserGroupsDb(() => sqlExecutor);
      await expect(
        inTx((conn) =>
          groups.insertGroupEntriesAndGetGroupIds([...first, Z1], conn)
        )
      ).rejects.toThrow(
        `These addresses have no profile to list in a group: ${Z1}`
      );
      expect(await rowsOf(first[0])).toEqual([]);
      expect(
        await sqlExecutor.execute(`select 1 from ${PROFILE_GROUP_CHANGES}`)
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(`select 1 from ${PROFILE_GROUPS_TABLE}`)
      ).toEqual([]);
    });

    /** Runs `fn` with the wall clock (Time.currentMillis) at `at`. */
    async function atWallTime<T>(at: number, fn: () => Promise<T>) {
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(at);
      try {
        return await fn();
      } finally {
        now.mockRestore();
      }
    }

    it("gives the API group writer's listed addresses random ids before switch-on", async () => {
      const groups = new UserGroupsDb(() => sqlExecutor);
      await atWallTime(BEFORE, () =>
        inTx((conn) => groups.insertGroupEntriesAndGetGroupIds([A], conn))
      );
      const [row] = await rowsOf(A);
      expect(row.profile_id).toMatch(UUID_V4);
      expect(row.profile_id).not.toBe(addressIdentityId(A));
    });

    it("gives the API group writer's listed addresses ids from wall time, and never lists a null profile id", async () => {
      const groups = new UserGroupsDb(() => sqlExecutor);
      const { profile_group_id } = await atWallTime(AFTER, () =>
        inTx((conn) => groups.insertGroupEntriesAndGetGroupIds([A, N, R], conn))
      );
      const listed = (
        await sqlExecutor.execute<{ profile_id: string | null }>(
          `select profile_id from ${PROFILE_GROUPS_TABLE} where profile_group_id = :id`,
          { id: profile_group_id }
        )
      )
        .map((it) => it.profile_id)
        .sort();
      expect(listed).toEqual(
        [addressIdentityId(A), addressIdentityId(N), ROW_R].sort()
      );
      await oneIdPerRow();
    });

    describe('a wallet listed, joining an identity and leaving it', () => {
      const PRINCIPAL = '0x' + 'b1'.repeat(32);
      const view = (wallets: string[]) => ({
        principalId: PRINCIPAL,
        profileId: PROF_B,
        handle: null,
        wallets,
        primary: B,
        doc: { ...EMPTY_PROFILE_DOC_FIELDS },
        rep: 0,
        cic: 0,
        levelRaw: 0
      });
      /** The identity mirror's write for the identity holding `wallets`. */
      const identityIs = (wallets: string[]) =>
        inTx(async (conn) => {
          const state = await mirrorDb.readIdentityState(
            wallets,
            PROF_B,
            null,
            B,
            conn
          );
          const plan = planIdentity(view(wallets), state);
          await mirrorDb.applyIdentityPlan(
            plan,
            1_000_000_200,
            99,
            conn,
            () => AFTER
          );
        });

      it('gives the address its derived id when the group is mirrored first, as live interleaves them', async () => {
        await give([A], AFTER);
        await identityIs([A, B]);
        // Joining took A's own row, and with it the id.
        expect(await rowsOf(A)).toEqual([]);
        expect(
          await sqlExecutor.execute(
            `select 1 from ${IDENTITIES_TABLE} where profile_id = :id`,
            { id: addressIdentityId(A) }
          )
        ).toEqual([]);
        await identityIs([B]);
        expect((await rowsOf(A))[0]?.profile_id).toBe(addressIdentityId(A));
        await oneIdPerRow();
      });

      it('gives it the same id when the identity runs first, as a rebuild orders them', async () => {
        await identityIs([A, B]);
        await identityIs([B]);
        const given = await give([A], AFTER);
        expect(given.get(A)).toBe(addressIdentityId(A));
        expect((await rowsOf(A))[0]?.profile_id).toBe(addressIdentityId(A));
        await oneIdPerRow();
      });
    });
  }
);
