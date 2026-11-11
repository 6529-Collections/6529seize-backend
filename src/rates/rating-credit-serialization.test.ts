import 'reflect-metadata';
import * as fc from 'fast-check';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { RateMatter, Rating } from '@/entities/IRating';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { profilesService } from '@/profiles/profiles.service';
import { RatingsService } from '@/rates/ratings.service';
import { UpdateRatingRequest } from '@/rates/ratings.db';

jest.mock('@/notifications/user.notifier', () => ({
  userNotifier: {
    notifyOfIdentityRep: jest.fn(),
    notifyOfIdentityNic: jest.fn()
  }
}));

jest.mock('@/drops/participation-drops-over-vote-revocation', () => ({
  revokeRepBasedDropOverVotes: jest.fn(),
  revokeTdhBasedDropWavesOverVotes: jest.fn()
}));

const RATER = 'rater';
const CATEGORY = 'Art';

/** Lets every other pending request run before this one continues. */
function yieldToOthers(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function ratingKey(rating: UpdateRatingRequest): string {
  return JSON.stringify([
    rating.rater_profile_id,
    rating.matter_target_id,
    rating.matter,
    rating.matter_category
  ]);
}

interface FakeTransaction {
  readonly writes: Map<string, UpdateRatingRequest>;
  readonly held: Map<string, () => void>;
}

/**
 * Ratings with InnoDB-like transactions: a transaction reads committed rows
 * plus its own writes, its writes become visible at commit, and the rater
 * credit lock is held until commit or rollback.
 */
class FakeRatingsDb {
  readonly committed = new Map<string, UpdateRatingRequest>();
  readonly calls: string[] = [];
  private readonly lockHolders = new Map<string, Promise<void>>();

  constructor(private readonly locking = true) {}

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: FakeTransaction) => Promise<T>
  ): Promise<T> {
    const tx: FakeTransaction = { writes: new Map(), held: new Map() };
    try {
      const result = await executable(tx);
      await yieldToOthers();
      for (const [key, row] of Array.from(tx.writes)) {
        this.committed.set(key, row);
      }
      return result;
    } finally {
      for (const release of Array.from(tx.held.values())) {
        release();
      }
    }
  }

  async lockRaterCreditOnMatter(
    { rater_profile_id, matter }: { rater_profile_id: string; matter: string },
    tx: FakeTransaction
  ): Promise<void> {
    this.calls.push('lock');
    const key = JSON.stringify([rater_profile_id, matter]);
    if (!this.locking || tx.held.has(key)) {
      return;
    }
    while (this.lockHolders.has(key)) {
      await this.lockHolders.get(key);
    }
    let release!: () => void;
    this.lockHolders.set(
      key,
      new Promise<void>((resolve) => {
        release = () => {
          this.lockHolders.delete(key);
          resolve();
        };
      })
    );
    tx.held.set(key, release);
  }

  async getRating(request: UpdateRatingRequest, tx: FakeTransaction) {
    this.calls.push('getRating');
    await yieldToOthers();
    const rows = this.visible(tx);
    const spent = rows
      .filter(
        (row) =>
          row.rater_profile_id === request.rater_profile_id &&
          row.matter === request.matter
      )
      .reduce((acc, row) => acc + Math.abs(row.rating), 0);
    const current = rows.find((row) => ratingKey(row) === ratingKey(request));
    return {
      ...request,
      rating: current?.rating ?? 0,
      last_modified: new Date(),
      total_credit_spent_on_matter: spent
    };
  }

  async getRatingsOnMatter(
    { rater_profile_id, matter }: { rater_profile_id: string; matter: string },
    tx: FakeTransaction
  ) {
    this.calls.push('getRatingsOnMatter');
    return this.visible(tx).filter(
      (row) =>
        row.rater_profile_id === rater_profile_id && row.matter === matter
    );
  }

  async updateRating(
    request: UpdateRatingRequest,
    amountChanged: number,
    tx: FakeTransaction
  ) {
    this.calls.push('updateRating');
    await yieldToOthers();
    tx.writes.set(ratingKey(request), { ...request });
    return { profileId: request.matter_target_id, repChange: amountChanged };
  }

  async getTotalRatingForMatter() {
    return 0;
  }

  async applyBulkIdentityUpdates() {
    this.calls.push('identities');
  }

  spentBy(rater: string): number {
    return Array.from(this.committed.values())
      .filter((row) => row.rater_profile_id === rater)
      .reduce((acc, row) => acc + Math.abs(row.rating), 0);
  }

  private visible(tx: FakeTransaction): UpdateRatingRequest[] {
    return Array.from(
      new Map([
        ...Array.from(this.committed),
        ...Array.from(tx.writes)
      ]).values()
    );
  }
}

function createService(ratingsDb: FakeRatingsDb, credit: number) {
  const identitiesDb = {
    getTdhAndXTdhCombinedAndFloored: jest.fn(async () => {
      ratingsDb.calls.push('credit');
      return credit;
    }),
    getEverythingRelatedToIdentitiesByAddresses: jest.fn(
      async (addresses: string[]) => {
        ratingsDb.calls.push('targets');
        return Object.fromEntries(
          addresses.map((address) => [
            address,
            {
              identity: { primary_address: address },
              profile: { external_id: `profile-${address}` },
              consolidations: []
            }
          ])
        );
      }
    )
  };
  const eventScheduler = {
    scheduleRepRatingChangedEvent: jest.fn(),
    scheduleCicRatingChangedEvent: jest.fn()
  };
  const metricsRecorder = { recordActiveIdentity: jest.fn() };
  const service = new RatingsService(
    ratingsDb as any,
    {} as any,
    eventScheduler as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    identitiesDb as any,
    metricsRecorder as any
  );
  return { service, identitiesDb };
}

function rateRequest(target: string, rating: number) {
  return {
    rater_profile_id: RATER,
    matter_target_id: target,
    matter: RateMatter.REP,
    matter_category: CATEGORY,
    rating,
    authenticationContext: AuthenticationContext.fromProfileId(RATER)
  };
}

describe('rating writes serialise credit checks per rater', () => {
  beforeEach(() => {
    jest.spyOn(profileActivityLogsDb, 'insert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('takes the rater credit lock before reading the rating and the credit, and reads the credit in the transaction', async () => {
    const ratingsDb = new FakeRatingsDb();
    const { service, identitiesDb } = createService(ratingsDb, 100);

    await service.updateRating(rateRequest('target-1', 10), {});

    expect(ratingsDb.calls.slice(0, 4)).toEqual([
      'lock',
      'getRating',
      'credit',
      'updateRating'
    ]);
    expect(identitiesDb.getTdhAndXTdhCombinedAndFloored).toHaveBeenCalledWith(
      RATER,
      expect.objectContaining({ writes: expect.any(Map) })
    );
  });

  it('lets concurrent ratings of one rater pass only as if sent one by one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 300 }),
        fc.array(fc.integer({ min: -200, max: 200 }), {
          minLength: 2,
          maxLength: 4
        }),
        async (credit, ratings) => {
          const ratingsDb = new FakeRatingsDb();
          const { service } = createService(ratingsDb, credit);

          const results = await Promise.allSettled(
            ratings.map((rating, i) =>
              service.updateRating(rateRequest(`target-${i}`, rating), {})
            )
          );

          // Each waits for the previous one, in the order they were sent.
          let spent = 0;
          const expected = ratings.map((rating) => {
            if (spent + Math.abs(rating) > credit) return 'rejected';
            spent += Math.abs(rating);
            return 'fulfilled';
          });
          expect(results.map((result) => result.status)).toEqual(expected);
          expect(ratingsDb.spentBy(RATER)).toBe(spent);
          expect(spent).toBeLessThanOrEqual(credit);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('overspends without the lock, so the test above depends on it', async () => {
    const ratingsDb = new FakeRatingsDb(false);
    const { service } = createService(ratingsDb, 100);

    const results = await Promise.allSettled([
      service.updateRating(rateRequest('target-1', 60), {}),
      service.updateRating(rateRequest('target-2', 60), {})
    ]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled'
    ]);
    expect(ratingsDb.spentBy(RATER)).toBe(120);
  });

  it('takes the lock first in a bulk rating, so two bulk ratings cannot both spend the same credit', async () => {
    const ratingsDb = new FakeRatingsDb();
    const { service } = createService(ratingsDb, 100);
    const bulkRate = (address: string) =>
      service.bulkRateProfiles(AuthenticationContext.fromProfileId(RATER), {
        matter: 'REP',
        category: CATEGORY,
        amount_to_add: 60,
        target_wallet_addresses: [address]
      } as any);

    const results = await Promise.allSettled([
      bulkRate('0x0000000000000000000000000000000000000001'),
      bulkRate('0x0000000000000000000000000000000000000002')
    ]);

    expect(ratingsDb.calls[0]).toBe('lock');
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected'
    ]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'Not enough credit to go through with this bulk rating'
    );
    expect(ratingsDb.spentBy(RATER)).toBe(60);
  });

  it('does not take the lock when a merge moves ratings without a credit check', async () => {
    const ratingsDb = new FakeRatingsDb();
    const { service } = createService(ratingsDb, 0);
    ratingsDb.committed.set(
      ratingKey(rateRequest('target-1', 5)),
      rateRequest('target-1', 5)
    );

    await service.deleteRatingsForProfileArchival(
      [{ ...rateRequest('target-1', 5), last_modified: new Date() }],
      'source',
      'target',
      { writes: new Map(), held: new Map() } as any
    );

    expect(ratingsDb.calls).not.toContain('lock');
  });

  it('takes the lock first in each over-rate revocation transaction', async () => {
    const ratingsDb = new FakeRatingsDb();
    const overRated = rateRequest('target-1', 40);
    ratingsDb.committed.set(ratingKey(overRated), overRated);
    const fakeDb = Object.assign(ratingsDb, {
      getOverRateMatters: jest.fn().mockResolvedValue([
        {
          rater_profile_id: RATER,
          matter: RateMatter.REP,
          tally: 40,
          rater_credit: 0
        }
      ])
    });
    const { service } = createService(fakeDb, 0);

    await service.reduceOverRates();

    expect(ratingsDb.calls.slice(0, 2)).toEqual(['lock', 'getRatingsOnMatter']);
    expect(ratingsDb.spentBy(RATER)).toBe(0);
  });
});

describe('bulk REP checks what needs no profile before creating target profiles', () => {
  const TARGET_ADDRESS = '0x00000000000000000000000000000000000000aa';
  let makeSureProfiles: jest.SpyInstance;

  function createBulkRepService(raterWallets: string) {
    const calls: string[] = [];
    const ratingsDb = {
      lockRaterCreditOnMatter: jest.fn(async () => {
        calls.push('lock');
      }),
      getRaterRepRatingsForUpdate: jest.fn(async () => {
        calls.push('ratings');
        return [] as Rating[];
      }),
      getTotalCreditSpent: jest.fn(async () => {
        calls.push('spent');
        return 0;
      }),
      bulkUpsertRatings: jest.fn()
    };
    const identitiesDb = {
      executeNativeQueriesInTransaction: jest.fn(
        (fn: (connection: unknown) => Promise<unknown>) => fn({})
      ),
      getIdentityByProfileId: jest.fn(async () => {
        calls.push('rater wallets');
        return { consolidation_key: raterWallets };
      }),
      getTdhAndXTdhCombinedAndFloored: jest.fn(async () => {
        calls.push('credit');
        return 100;
      }),
      bulkUpdateReps: jest.fn()
    };
    const service = new RatingsService(
      ratingsDb as any,
      {} as any,
      { scheduleBulkRepRatingChangedEvents: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      { bulkCheckRepPhrases: jest.fn() } as any,
      identitiesDb as any,
      {} as any
    );
    makeSureProfiles.mockImplementation(async () => {
      calls.push('profiles');
      return { [TARGET_ADDRESS]: 'target-profile' };
    });
    return { service, calls, identitiesDb };
  }

  beforeEach(() => {
    makeSureProfiles = jest.spyOn(
      profilesService,
      'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
    );
    jest
      .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const request = {
    targets: [{ address: TARGET_ADDRESS, category: CATEGORY, amount: 5 }]
  };

  it('locks the rater credit first and reads the credit after the profiles exist', async () => {
    const { service, calls } = createBulkRepService('0xrater');

    await service.bulkRep(request, {
      authenticationContext: AuthenticationContext.fromProfileId(RATER)
    });

    expect(calls).toEqual([
      'lock',
      'rater wallets',
      'profiles',
      'ratings',
      'credit',
      'spent'
    ]);
  });

  it('rejects a target among the rater own wallets before creating any profile', async () => {
    const { service, calls } = createBulkRepService(
      `0xother-${TARGET_ADDRESS}`
    );

    await expect(
      service.bulkRep(request, {
        authenticationContext: AuthenticationContext.fromProfileId(RATER)
      })
    ).rejects.toThrow(`User can't rate themselves`);
    expect(calls).not.toContain('profiles');
  });

  it('rejects a proxy without REP rights before opening the transaction', async () => {
    const { service, identitiesDb } = createBulkRepService('0xrater');
    const proxyContext = new AuthenticationContext({
      authenticatedWallet: '0xproxy',
      authenticatedProfileId: 'proxy',
      roleProfileId: RATER,
      activeProxyActions: [
        {
          id: 'action',
          type: ProfileProxyActionType.ALLOCATE_CIC,
          credit_amount: null,
          credit_spent: null
        }
      ]
    });

    await expect(
      service.bulkRep(request, { authenticationContext: proxyContext })
    ).rejects.toThrow('Proxy is not allowed to give REP ratings');
    expect(
      identitiesDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('rejects a rater without a profile before opening the transaction', async () => {
    const { service, identitiesDb } = createBulkRepService('0xrater');

    await expect(
      service.bulkRep(request, {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow('Create a profile before you rate');
    expect(
      identitiesDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });
});
