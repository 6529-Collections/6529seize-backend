import { identitiesDb } from '@/identities/identities.db';
import {
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IdentityFrozenException
} from '@/identity-freeze/identity-freeze';
import { apiCompliantErrorBody } from '@/exceptions';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { profilesDb } from '@/profiles/profiles.db';
import { profilesService } from '@/profiles/profiles.service';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock,
  settle
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { IdentitiesService, identitiesService } from './identities.service';

const WALLET = '0x1111111111111111111111111111111111111111';

describe('a profile picture change admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  function setup(onWrite: () => void) {
    const tx = fakeTransactionalDb();
    const db = {
      executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
      getMemeThumbnailUriById: jest
        .fn()
        .mockResolvedValue('https://example.com/thumbnail.png'),
      updateProfilePfpUri: jest.fn(async () => onWrite())
    };
    const fetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn().mockResolvedValue({
        id: 'profile-id',
        handle: 'someone',
        pfp: null,
        wallets: [{ wallet: WALLET }]
      })
    };
    jest
      .spyOn(profileActivityLogsDb, 'insert')
      .mockResolvedValue(undefined as any);
    const service = new IdentitiesService(
      db as any,
      {} as any,
      {} as any,
      fetcher as any,
      {} as any
    );
    const run = () =>
      service.updateProfilePfp({
        authenticatedWallet: WALLET,
        identity: 'someone',
        memeOrFile: { meme: 1 }
      });
    return { tx, db, run };
  }

  it('updateProfilePfp refuses at COMMIT and rolls back', async () => {
    const { tx, db, run } = setup(() => clock.pass());
    await expectRefusedAtCommit(run(), tx.statements);
    expect(db.updateProfilePfpUri).toHaveBeenCalledWith(
      'https://example.com/thumbnail.png',
      'profile-id',
      expect.objectContaining({ connection: tx.connection })
    );
  });

  it('updateProfilePfp commits a change that ends before T', async () => {
    const { tx, run } = setup(() => undefined);
    await expect(run()).resolves.toEqual({
      pfp_url: 'https://example.com/thumbnail.png'
    });
    expectCommitted(tx.statements);
  });
});

describe('a drop that nominates a wallet with no identity, straddling the freeze', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  /**
   * The wallet has no identity until bulkCreateIdentities inserts one, and no
   * profile until it inserts that. `onProfileWrite` runs at the profile
   * insert, after the first freeze check.
   */
  function stubNomination(
    onProfileWrite: () => void,
    hasProfile: boolean = false
  ) {
    let identityMade = hasProfile;
    let profileMade = hasProfile;
    jest
      .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
      .mockImplementation(
        async () =>
          (identityMade
            ? {
                [WALLET]: {
                  identity: {
                    profile_id: 'nominee',
                    primary_address: WALLET,
                    consolidation_key: WALLET
                  },
                  profile: profileMade ? { external_id: 'nominee' } : null,
                  consolidations: []
                }
              }
            : {}) as any
      );
    const insertIdentities = jest
      .spyOn(identitiesDb, 'bulkInsertIdentities')
      .mockImplementation(async () => {
        identityMade = true;
      });
    const insertProfiles = jest
      .spyOn(profilesDb, 'bulkInsertProfiles')
      .mockImplementation(async () => {
        profileMade = true;
        onProfileWrite();
      });
    jest
      .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(identitiesDb, 'updateIdentityProfilesOfIds')
      .mockResolvedValue(undefined as any);
    return { insertIdentities, insertProfiles };
  }

  /** The drop's own transaction: its write, then the nomination. */
  function dropTransaction(tx: ReturnType<typeof fakeTransactionalDb>) {
    const bulkCreate = jest.spyOn(identitiesService, 'bulkCreateIdentities');
    const run = tx.executeNativeQueriesInTransaction(async (connection) => {
      tx.statements.push('DROP WRITE');
      const ids =
        await profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
          [WALLET],
          { connection }
        );
      tx.statements.push('NOMINATION WRITE');
      return ids;
    });
    return { run, bulkCreate };
  }

  it('is refused at COMMIT with the same 423 and nomination message as the check before T', async () => {
    const tx = fakeTransactionalDb();
    const { insertIdentities, insertProfiles } = stubNomination(() =>
      clock.pass()
    );
    const { run, bulkCreate } = dropTransaction(tx);

    await expectRefusedAtCommit(
      run,
      tx.statements,
      IDENTITY_FROZEN_NOMINATION_MESSAGE
    );
    expect(tx.statements).toEqual([
      'BEGIN',
      'DROP WRITE',
      'NOMINATION WRITE',
      'ROLLBACK',
      'RELEASE'
    ]);
    expect(insertIdentities).toHaveBeenCalledTimes(1);
    expect(insertProfiles).toHaveBeenCalledTimes(1);
    // bulkCreateIdentities itself returned: the check waited for the drop's
    // COMMIT.
    await expect(bulkCreate.mock.results[0].value).resolves.toBeUndefined();

    // The same drop arriving after T is refused by the first check, before
    // anything is written, with the same answer.
    const atCommit = (await settle(run)).error as IdentityFrozenException;
    insertIdentities.mockClear();
    insertProfiles.mockClear();
    const late = fakeTransactionalDb();
    stubNomination(() => undefined);
    const beforeWrite = (await settle(dropTransaction(late).run))
      .error as IdentityFrozenException;
    expect(beforeWrite).toBeInstanceOf(IdentityFrozenException);
    expect(beforeWrite.getStatusCode()).toBe(atCommit.getStatusCode());
    expect(apiCompliantErrorBody(beforeWrite)).toEqual(
      apiCompliantErrorBody(atCommit)
    );
    expect(insertIdentities).not.toHaveBeenCalled();
    expect(insertProfiles).not.toHaveBeenCalled();
    expect(late.statements).toEqual([
      'BEGIN',
      'DROP WRITE',
      'ROLLBACK',
      'RELEASE'
    ]);
  });

  it('lets the drop commit when it ends before T', async () => {
    const tx = fakeTransactionalDb();
    stubNomination(() => undefined);
    await expect(dropTransaction(tx).run).resolves.toEqual({
      [WALLET]: 'nominee'
    });
    expectCommitted(tx.statements);
  });

  it('does not check a drop that nominates a wallet which already has a profile', async () => {
    const tx = fakeTransactionalDb();
    const { insertIdentities } = stubNomination(() => undefined, true);
    const { run } = dropTransaction(tx);
    clock.pass();
    // Past T, yet nothing identity-related is written, so nothing refuses.
    await expect(run).resolves.toEqual({ [WALLET]: 'nominee' });
    expectCommitted(tx.statements);
    expect(insertIdentities).not.toHaveBeenCalled();
  });
});
