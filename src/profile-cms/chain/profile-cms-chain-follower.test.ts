import {
  PROFILE_CMS_MAX_CHANGE_ATTEMPTS,
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
  pending_version: number | null;
  pending_attempts: number | null;
  pending_reason: string | null;
}

/** The chain index's tables in memory: heads only; rows aren't needed here. */
function fakeDb() {
  const heads = new Map<string, Head>();
  const db = {
    heads,
    findHead: async (principal: string) => heads.get(principal) ?? null,
    advanceHead: async (head: {
      principal: string;
      doc_version: number;
      height: number;
    }) => {
      heads.set(head.principal, {
        ...head,
        pending_version: null,
        pending_attempts: 0,
        pending_reason: null
      });
    },
    recordPending: async (pending: {
      principal: string;
      version: number;
      attempts: number;
      reason: string;
    }) => {
      const head = heads.get(pending.principal);
      heads.set(pending.principal, {
        principal: pending.principal,
        doc_version: head?.doc_version ?? 0,
        height: head?.height ?? 0,
        pending_version: pending.version,
        pending_attempts: pending.attempts,
        pending_reason: pending.reason
      });
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

function setup(mode: 'live' | 'rebuild' = 'live') {
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
    mode
  );
  return { chain, db, follower };
}

function change(
  principal: string,
  height: number,
  docCid: string | null = null
): ProfileCmsProfileChange {
  return {
    height,
    time_ms: height * 1_000,
    principal,
    version: 1,
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
        nextHeight: 10,
        waiting: 1
      });
      expect(db.heads.get(CHAIN_FIXTURE_PRINCIPAL)).toMatchObject({
        doc_version: 0,
        pending_version: 1,
        pending_attempts: 1,
        pending_reason:
          'identity_read_failed: wallet principal unknown at height 10'
      });
      expect(db.heads.get(OTHER)).toMatchObject({ doc_version: 1 });
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
        doc_version: 1,
        pending_version: null
      });
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
