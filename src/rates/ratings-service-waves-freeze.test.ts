jest.mock('../drops/participation-drops-over-vote-revocation', () => ({
  revokeTdhBasedDropWavesOverVotes: jest.fn(),
  revokeRepBasedDropOverVotes: jest.fn()
}));

import { RateMatter } from '@/entities/IRating';
import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { isWaveRepFrozen, RatingsService } from './ratings.service';

const FLAG = 'FEATURE_WAVES_FROZEN';
const AT = 'WAVES_FREEZE_AT';
const FREEZE = Date.UTC(2026, 10, 25);
const PAST_FREEZE = 'reached the rating transaction after the freeze check';

function createService(transaction?: (callback: any) => Promise<unknown>) {
  const connection = {};
  const ratingsDb = {
    executeNativeQueriesInTransaction: jest.fn(
      transaction ?? (() => Promise.reject(new Error(PAST_FREEZE)))
    ),
    getOverRateMatters: jest.fn(),
    lockRaterCreditOnMatter: jest.fn(),
    getRatingsOnMatter: jest.fn().mockResolvedValue([]),
    applyBulkIdentityUpdates: jest.fn(),
    getRating: jest.fn().mockRejectedValue(new Error(PAST_FREEZE)),
    updateRating: jest.fn()
  };
  const service = new RatingsService(
    ratingsDb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  jest
    .spyOn(service as any, 'uploadRatesSnapshotsToArweave')
    .mockResolvedValue(undefined);
  return { service, ratingsDb, connection };
}

function rateRequest(matter: RateMatter) {
  return {
    matter,
    matter_category: 'Category',
    matter_target_id: 'target',
    rating: 1,
    authenticationContext: {} as any
  } as any;
}

/** The freeze starts while the request waits on the rater's credit lock. */
function freezeStartsDuringTheLockWait(ratingsDb: {
  lockRaterCreditOnMatter: jest.Mock;
}) {
  process.env[AT] = new Date(FREEZE).toISOString();
  const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(FREEZE - 1);
  ratingsDb.lockRaterCreditOnMatter.mockImplementation(async () => {
    now.mockReturnValue(FREEZE + 1);
  });
}

describe('ratings during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, AT]) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of [FLAG, AT]) delete process.env[name];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of [FLAG, AT]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('freezes wave REP only, and only while waves are frozen', () => {
    expect(isWaveRepFrozen(RateMatter.WAVE_REP, true)).toBe(true);
    expect(isWaveRepFrozen(RateMatter.REP, true)).toBe(false);
    expect(isWaveRepFrozen(RateMatter.CIC, true)).toBe(false);
    expect(isWaveRepFrozen(RateMatter.WAVE_REP, false)).toBe(false);
  });

  it('refuses a wave REP rating before its transaction', async () => {
    process.env[FLAG] = 'true';
    const { service, ratingsDb } = createService();
    await expect(
      service.updateRating(rateRequest(RateMatter.WAVE_REP), {})
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(ratingsDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it.each([RateMatter.REP, RateMatter.CIC])(
    'lets a %s rating through',
    async (matter) => {
      process.env[FLAG] = 'true';
      const { service } = createService();
      await expect(
        service.updateRating(rateRequest(matter), {})
      ).rejects.toThrow(PAST_FREEZE);
    }
  );

  it('rates wave REP as before when the flag is off', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.updateRating(rateRequest(RateMatter.WAVE_REP), {})
    ).rejects.toThrow(PAST_FREEZE);
  });

  it('refuses a wave REP rating whose lock wait passes the freeze', async () => {
    const { service, ratingsDb, connection } = createService((callback) =>
      callback(connection)
    );
    freezeStartsDuringTheLockWait(ratingsDb);
    const request = {
      ...rateRequest(RateMatter.WAVE_REP),
      rater_profile_id: 'rater',
      authenticationContext: {
        getActingAsId: () => 'rater',
        isAuthenticatedAsProxy: () => false
      }
    };
    await expect(service.updateRating(request, {})).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    expect(ratingsDb.lockRaterCreditOnMatter).toHaveBeenCalledTimes(1);
    expect(ratingsDb.getRating).not.toHaveBeenCalled();
    expect(ratingsDb.updateRating).not.toHaveBeenCalled();
  });

  it('leaves wave REP as it stood when the lock wait passes the freeze', async () => {
    const { service, ratingsDb, connection } = createService((callback) =>
      callback(connection)
    );
    freezeStartsDuringTheLockWait(ratingsDb);
    ratingsDb.getOverRateMatters.mockResolvedValue([
      {
        rater_profile_id: 'rater',
        matter: RateMatter.WAVE_REP,
        tally: 10,
        rater_credit: 1
      }
    ]);
    await service.reduceOverRates();
    expect(ratingsDb.lockRaterCreditOnMatter).toHaveBeenCalledTimes(1);
    expect(ratingsDb.getRatingsOnMatter).not.toHaveBeenCalled();
    expect(ratingsDb.applyBulkIdentityUpdates).not.toHaveBeenCalled();
  });

  it.each([
    [true, [RateMatter.REP]],
    [false, [RateMatter.REP, RateMatter.WAVE_REP]]
  ])(
    'over-rates loop with the freeze %s reduces %j',
    async (frozen, reduced) => {
      if (frozen) process.env[FLAG] = 'true';
      else delete process.env[FLAG];
      const { service, ratingsDb, connection } = createService((callback) =>
        callback(connection)
      );
      ratingsDb.getOverRateMatters.mockResolvedValue(
        [RateMatter.REP, RateMatter.WAVE_REP].map((matter) => ({
          rater_profile_id: 'rater',
          matter,
          tally: 10,
          rater_credit: 1
        }))
      );
      await service.reduceOverRates();
      expect(
        ratingsDb.lockRaterCreditOnMatter.mock.calls.map(
          ([request]) => request.matter
        )
      ).toEqual(reduced);
    }
  );
});
