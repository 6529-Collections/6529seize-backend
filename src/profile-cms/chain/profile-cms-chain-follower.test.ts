import { Logger } from '@/logging';
import {
  PROFILE_CMS_MAX_CHANGE_ATTEMPTS,
  PROFILE_CMS_PARKED_ALERT_MS,
  ProfileCmsChainFollower
} from '@/profile-cms/chain/profile-cms-chain-follower';
import { ProfileCmsChainDb } from '@/profile-cms/chain/profile-cms-chain.db';
import {
  ProfileCmsProfileChange,
  ProfileCmsProfileChangesPage
} from '@/profile-cms/chain/profile-cms-chain.port';
import { RequestContext } from '@/request.context';
import {
  aChainIdentity,
  aProfileDoc,
  CHAIN_FIXTURE_PRINCIPAL,
  InMemoryProfileCmsChain
} from '@/tests/fixtures/profile-cms-chain.fixture';

const ctx: RequestContext = { timer: undefined };
const OTHER = `0x${'0'.repeat(63)}2`;

interface Head {
  principal: string;
  doc_version: number;
  height: number;
}

interface Parked {
  principal: string;
  version: number;
  height: number;
  time_ms: number;
  doc_cid: string | null;
  source: string | null;
  attempts: number;
  reason: string | null;
  parked_at: number;
  alerted_at: number | null;
}

/** The chain index's heads and retry list in memory; other rows aren't needed here. */
function fakeDb() {
  const heads = new Map<string, Head>();
  const parked = new Map<string, Parked>();
  const key = (principal: string, version: number) => `${principal}:${version}`;
  const unpark = async (principal: string, version: number) => {
    parked.forEach((row, k) => {
      if (row.principal === principal && row.version <= version) {
        parked.delete(k);
      }
    });
  };
  const db = {
    heads,
    parked,
    findHead: async (principal: string) => heads.get(principal) ?? null,
    advanceHead: async (head: Head) => {
      heads.set(head.principal, head);
      await unpark(head.principal, head.doc_version);
    },
    listParked: async () =>
      Array.from(parked.values()).sort(
        (a, b) =>
          a.principal.localeCompare(b.principal) || a.version - b.version
      ),
    findParked: async (principal: string, version: number) =>
      parked.get(key(principal, version)) ?? null,
    park: async (
      change: ProfileCmsProfileChange,
      wait: { attempts: number; reason: string; now: number }
    ) => {
      const row = parked.get(key(change.principal, change.version));
      parked.set(key(change.principal, change.version), {
        principal: change.principal,
        version: change.version,
        height: change.height,
        time_ms: change.time_ms,
        doc_cid: change.doc_cid,
        source: change.source ?? null,
        attempts: wait.attempts,
        reason: wait.reason,
        parked_at: row?.parked_at ?? wait.now,
        alerted_at: row?.alerted_at ?? null
      });
    },
    parkBehind: async (change: ProfileCmsProfileChange, now: number) => {
      if (!parked.has(key(change.principal, change.version))) {
        parked.set(key(change.principal, change.version), {
          principal: change.principal,
          version: change.version,
          height: change.height,
          time_ms: change.time_ms,
          doc_cid: change.doc_cid,
          source: change.source ?? null,
          attempts: 0,
          reason: null,
          parked_at: now,
          alerted_at: null
        });
      }
    },
    unpark,
    markParkedAlerted: async (
      principal: string,
      version: number,
      now: number
    ) => {
      const row = parked.get(key(principal, version));
      if (row) {
        row.alerted_at = now;
      }
    },
    executeNativeQueriesInTransaction: async <T>(
      fn: (connection: unknown) => Promise<T>
    ) => fn({}),
    lockProfile: async () => undefined,
    findPrimary: async () => null,
    findPackageById: async () => null,
    upsertPackage: async () => undefined,
    insertEventIfMissing: async () => undefined,
    insertSignatureIfMissing: async () => undefined,
    isPublishedPublication: async () => false
  };
  return db;
}

function setup(mode: 'live' | 'rebuild' = 'live', now: () => number = () => 0) {
  const chain = new InMemoryProfileCmsChain();
  chain.setIdentity(aChainIdentity({ imported: false }));
  chain.setIdentity(
    aChainIdentity({
      principal: OTHER,
      profile_id: 'test-profile-2',
      imported: false
    })
  );
  const db = fakeDb();
  const follower = new ProfileCmsChainFollower(
    chain,
    db as unknown as ProfileCmsChainDb,
    () => ({
      hasContractCode: async () => false,
      isValidSignature: async () => false
    }),
    mode,
    now
  );
  return { chain, db, follower };
}

function change(
  principal: string,
  height: number,
  docCid: string | null = null,
  version = 1
): ProfileCmsProfileChange {
  return {
    height,
    time_ms: height * 1_000,
    principal,
    version,
    doc_cid: docCid
  };
}

class WalletPrincipalUnknownError extends Error {}

describe('ProfileCmsChainFollower', () => {
  describe('a port read that throws', () => {
    it('is one try at that change; the pass goes on with the others', async () => {
      const { chain, db, follower } = setup();
      chain.replaceProfile({ version: 1, height: 10, timeMs: 1, doc: null });
      chain.replaceProfile({
        principal: OTHER,
        version: 1,
        height: 11,
        timeMs: 2,
        doc: null
      });
      const read = chain.getIdentityByPrincipal.bind(chain);
      jest
        .spyOn(chain, 'getIdentityByPrincipal')
        .mockImplementation(async (principal) => {
          if (principal === CHAIN_FIXTURE_PRINCIPAL) {
            throw new WalletPrincipalUnknownError(
              'wallet principal unknown at height 10'
            );
          }
          return read(principal);
        });

      expect(await follower.syncFrom(0, ctx)).toEqual({
        applied: 1,
        nextHeight: 12,
        waiting: 1
      });
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toBeUndefined();
      expect(Array.from(db.parked.values())).toMatchObject([
        {
          principal: CHAIN_FIXTURE_PRINCIPAL,
          version: 1,
          attempts: 1,
          reason: 'identity_read_failed: wallet principal unknown at height 10'
        }
      ]);
      expect(db.heads.get(OTHER)).toMatchObject({ doc_version: 1 });
    });

    it('waits on a read to try later without using up tries or skipping', async () => {
      const { chain, db, follower } = setup();
      const notYet = Object.assign(
        new Error('wallet principal unknown at height 10'),
        { retryLater: true }
      );
      jest.spyOn(chain, 'getIdentityByPrincipal').mockRejectedValue(notYet);
      const at = change(CHAIN_FIXTURE_PRINCIPAL, 10);
      for (let pass = 1; pass <= PROFILE_CMS_MAX_CHANGE_ATTEMPTS + 2; pass++) {
        expect(await follower.applyChange(at, ctx)).toEqual({
          status: 'retry',
          reason: 'identity_retry_later: wallet principal unknown at height 10',
          attempt: 0
        });
      }
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toBeUndefined();
      expect(db.parked.get(`${CHAIN_FIXTURE_PRINCIPAL}:1`)).toMatchObject({
        attempts: 0
      });
    });

    it('gives up on the last try as for a missing identity', async () => {
      const { chain, db, follower } = setup();
      jest
        .spyOn(chain, 'getIdentityByPrincipal')
        .mockRejectedValue(new Error('gateway answered 503'));
      const at = change(CHAIN_FIXTURE_PRINCIPAL, 10);
      for (
        let attempt = 1;
        attempt < PROFILE_CMS_MAX_CHANGE_ATTEMPTS;
        attempt++
      ) {
        expect(await follower.applyChange(at, ctx)).toMatchObject({
          status: 'retry',
          attempt
        });
      }
      expect(await follower.applyChange(at, ctx)).toEqual({
        status: 'skipped',
        reason: 'identity_not_found'
      });
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toMatchObject({
        doc_version: 1
      });
      expect(db.parked.size).toBe(0);
    });

    it('fails a rebuild once its tries are used up', async () => {
      const { chain, follower } = setup('rebuild');
      jest
        .spyOn(chain, 'getIdentityByPrincipal')
        .mockRejectedValue(new Error('gateway answered 503'));
      const at = change(CHAIN_FIXTURE_PRINCIPAL, 10);
      for (
        let attempt = 1;
        attempt < PROFILE_CMS_MAX_CHANGE_ATTEMPTS;
        attempt++
      ) {
        await follower.applyChange(at, ctx);
      }
      await expect(follower.applyChange(at, ctx)).rejects.toThrow(
        'Profile site rebuild stopped'
      );
    });

    it('retries a document read and serves no site on the last try', async () => {
      const { chain, follower } = setup();
      const docCid = chain.replaceProfile({
        version: 1,
        height: 10,
        timeMs: 1,
        doc: aProfileDoc()
      });
      jest
        .spyOn(chain, 'getProfileDoc')
        .mockRejectedValue(new Error('document store timed out'));
      const at = change(CHAIN_FIXTURE_PRINCIPAL, 10, docCid);
      for (
        let attempt = 1;
        attempt < PROFILE_CMS_MAX_CHANGE_ATTEMPTS;
        attempt++
      ) {
        expect(await follower.applyChange(at, ctx)).toMatchObject({
          status: 'retry',
          reason: 'profile_doc_read_failed: document store timed out'
        });
      }
      expect(await follower.applyChange(at, ctx)).toMatchObject({
        status: 'applied'
      });
    });
  });

  describe('the retry list', () => {
    function waitOn(chain: InMemoryProfileCmsChain, principal: string) {
      const read = chain.getIdentityByPrincipal.bind(chain);
      const notYet = Object.assign(
        new Error('wallet principal unknown at height 10'),
        { retryLater: true }
      );
      let known = false;
      jest
        .spyOn(chain, 'getIdentityByPrincipal')
        .mockImplementation(async (asked) => {
          if (asked === principal && !known) {
            throw notYet;
          }
          return read(asked);
        });
      return () => {
        known = true;
      };
    }

    it("parks a change that waits, reads on past it, and applies everyone else's changes once", async () => {
      const { chain, db, follower } = setup();
      chain.replaceProfile({ version: 1, height: 10, timeMs: 1, doc: null });
      chain.replaceProfile({
        principal: OTHER,
        version: 1,
        height: 11,
        timeMs: 2,
        doc: null
      });
      chain.replaceProfile({ version: 2, height: 12, timeMs: 3, doc: null });
      const becomeKnown = waitOn(chain, CHAIN_FIXTURE_PRINCIPAL);
      const applyChange = jest.spyOn(follower, 'applyChange');

      expect(await follower.syncFrom(0, ctx)).toEqual({
        applied: 1,
        nextHeight: 13,
        waiting: 1
      });
      // The later change is queued behind the one that waits, untried.
      expect(Array.from(db.parked.values())).toMatchObject([
        { version: 1, height: 10, reason: expect.any(String) },
        { version: 2, height: 12, attempts: 0, reason: null }
      ]);

      // Later passes read the feed from past the last change and retry only
      // the first parked change; the other person's change isn't read again.
      applyChange.mockClear();
      expect(await follower.syncFrom(13, ctx)).toEqual({
        applied: 0,
        nextHeight: 13,
        waiting: 1
      });
      expect(applyChange.mock.calls.map(([at]) => at.version)).toEqual([1]);

      becomeKnown();
      expect(await follower.syncFrom(13, ctx)).toEqual({
        applied: 2,
        nextHeight: 13,
        waiting: 0
      });
      expect(db.parked.size).toBe(0);
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toMatchObject({
        doc_version: 2,
        height: 12
      });
    });

    it('raises an operational error once a change has waited longer than the alert time', async () => {
      let now = 1_000;
      const { chain, db, follower } = setup('live', () => now);
      chain.replaceProfile({ version: 1, height: 10, timeMs: 1, doc: null });
      waitOn(chain, CHAIN_FIXTURE_PRINCIPAL);
      const alert = jest
        .spyOn(Logger.prototype, 'errorWithCode')
        .mockImplementation(() => undefined);

      await follower.syncFrom(0, ctx);
      now += PROFILE_CMS_PARKED_ALERT_MS - 1;
      await follower.syncFrom(11, ctx);
      expect(alert).not.toHaveBeenCalled();

      now += 1;
      await follower.syncFrom(11, ctx);
      now += PROFILE_CMS_PARKED_ALERT_MS;
      await follower.syncFrom(11, ctx);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(
        'PROFILE_SITE_CHANGE_STALLED',
        `Profile site change for ${CHAIN_FIXTURE_PRINCIPAL} at 10 has waited 30 minutes: identity_retry_later: wallet principal unknown at height 10`
      );
      expect(db.parked.get(`${CHAIN_FIXTURE_PRINCIPAL}:1`)).toMatchObject({
        attempts: 0,
        parked_at: 1_000,
        alerted_at: 1_000 + PROFILE_CMS_PARKED_ALERT_MS
      });
      alert.mockRestore();
    });

    it('drops a parked change applied meanwhile', async () => {
      const { db, follower } = setup();
      await db.parkBehind(change(CHAIN_FIXTURE_PRINCIPAL, 10), 0);
      db.heads.set(CHAIN_FIXTURE_PRINCIPAL, {
        principal: CHAIN_FIXTURE_PRINCIPAL,
        doc_version: 1,
        height: 10
      });
      expect(await follower.syncFrom(11, ctx)).toEqual({
        applied: 0,
        nextHeight: 11,
        waiting: 0
      });
      expect(db.parked.size).toBe(0);
    });
  });

  describe('pages of changes', () => {
    function paged(
      chain: InMemoryProfileCmsChain,
      pages: Record<number, ProfileCmsProfileChangesPage>
    ) {
      const asked: number[] = [];
      jest.spyOn(chain, 'getChanges').mockImplementation(async (from) => {
        asked.push(from);
        return pages[from] ?? { changes: [], next_height: null };
      });
      return asked;
    }

    it('reads on past a page with no changes while more remain', async () => {
      const { chain, db, follower } = setup();
      const asked = paged(chain, {
        0: { changes: [change(CHAIN_FIXTURE_PRINCIPAL, 10)], next_height: 20 },
        20: { changes: [], next_height: 30 },
        30: { changes: [change(OTHER, 30)], next_height: null }
      });
      expect(await follower.syncFrom(0, ctx)).toEqual({
        applied: 2,
        nextHeight: 31,
        waiting: 0
      });
      expect(asked).toEqual([0, 20, 30]);
      expect(db.heads.get(OTHER)).toMatchObject({ doc_version: 1 });
    });

    it('stops loudly at a page that ends inside a block, keeping what it applied', async () => {
      const { chain, db, follower } = setup();
      // A block at height 10 holding two people's changes, cut after the
      // first: a height cursor can't resume inside it.
      paged(chain, {
        0: { changes: [change(CHAIN_FIXTURE_PRINCIPAL, 10)], next_height: 0 }
      });
      await expect(follower.syncFrom(0, ctx)).rejects.toThrow(
        'must give whole blocks'
      );
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toMatchObject({
        doc_version: 1
      });
    });

    it('applies a block the adapter put together from cut feed pages', async () => {
      const { chain, db, follower } = setup();
      // The gateway cut block 10 across two feed pages; the adapter gives it
      // whole, then moves past it.
      paged(chain, {
        0: {
          changes: [change(CHAIN_FIXTURE_PRINCIPAL, 10), change(OTHER, 10)],
          next_height: 11
        }
      });
      expect(await follower.syncFrom(0, ctx)).toEqual({
        applied: 2,
        nextHeight: 11,
        waiting: 0
      });
      expect(db.heads.get(OTHER)).toMatchObject({ doc_version: 1 });
    });
  });
});
