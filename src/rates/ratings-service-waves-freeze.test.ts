jest.mock('../drops/participation-drops-over-vote-revocation', () => ({
  revokeTdhBasedDropWavesOverVotes: jest.fn(),
  revokeRepBasedDropOverVotes: jest.fn()
}));

import { RateMatter } from '@/entities/IRating';
import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { RatingsService } from './ratings.service';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const FLAG = 'FEATURE_WAVES_FROZEN';
const AT = 'WAVES_FREEZE_AT';
const ON_CHAIN = 'FEATURE_WAVES_ON_CHAIN';
const SETTINGS = [FLAG, AT, ON_CHAIN];
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

function waveRep(waveId: string, rating: number) {
  return {
    rater_profile_id: 'rater',
    matter: RateMatter.WAVE_REP,
    matter_category: 'Category',
    matter_target_id: waveId,
    rating
  };
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

// Every wave moves unless a test says otherwise.
beforeEach(() => {
  stubWavesScope();
});

describe('ratings during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of SETTINGS) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of SETTINGS) delete process.env[name];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of SETTINGS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('takes wave REP on a staying wave while frozen', async () => {
    process.env[FLAG] = 'true';
    stubWavesScope({ staying: ['target'] });
    const { service, ratingsDb } = createService();
    await expect(
      service.updateRating(rateRequest(RateMatter.WAVE_REP), {})
    ).rejects.toThrow(PAST_FREEZE);
    expect(ratingsDb.executeNativeQueriesInTransaction).toHaveBeenCalled();
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

  it('leaves all wave REP as it stood when the lock wait passes the freeze', async () => {
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
    stubWavesScope({ staying: ['staying-wave'] });
    ratingsDb.getRatingsOnMatter.mockResolvedValue([
      waveRep('moving-wave', 10),
      waveRep('staying-wave', 10)
    ]);
    const rewritten = jest
      .spyOn(service as any, 'insertLostCreditRating')
      .mockResolvedValue(null);
    await service.reduceOverRates();
    expect(ratingsDb.lockRaterCreditOnMatter).toHaveBeenCalledTimes(1);
    expect(ratingsDb.getRatingsOnMatter).not.toHaveBeenCalled();
    expect(rewritten).not.toHaveBeenCalled();
    expect(ratingsDb.applyBulkIdentityUpdates).not.toHaveBeenCalled();
  });

  it("leaves staying waves' REP alone too while frozen", async () => {
    process.env[FLAG] = 'true';
    stubWavesScope({ staying: ['staying-wave'] });
    const { service, ratingsDb, connection } = createService((callback) =>
      callback(connection)
    );
    ratingsDb.getOverRateMatters.mockResolvedValue([
      {
        rater_profile_id: 'rater',
        matter: RateMatter.WAVE_REP,
        tally: 20,
        rater_credit: 10
      }
    ]);
    ratingsDb.getRatingsOnMatter.mockResolvedValue([
      waveRep('staying-wave', 10)
    ]);
    const rewritten = jest
      .spyOn(service as any, 'insertLostCreditRating')
      .mockResolvedValue(null);
    await service.reduceOverRates();
    expect(ratingsDb.lockRaterCreditOnMatter).not.toHaveBeenCalled();
    expect(rewritten).not.toHaveBeenCalled();
  });

  /** A rater over their wave REP credit, after the switch-on. */
  function switchedOnOverRate(
    tally: number,
    ratings: ReturnType<typeof waveRep>[]
  ) {
    process.env[FLAG] = 'true';
    process.env[ON_CHAIN] = 'true';
    stubWavesScope({ staying: ['staying-wave', 'other-staying-wave'] });
    const { service, ratingsDb, connection } = createService((callback) =>
      callback(connection)
    );
    ratingsDb.getOverRateMatters.mockResolvedValue([
      {
        rater_profile_id: 'rater',
        matter: RateMatter.WAVE_REP,
        tally,
        rater_credit: 10
      }
    ]);
    ratingsDb.getRatingsOnMatter.mockResolvedValue(ratings);
    const rewritten = jest
      .spyOn(service as any, 'insertLostCreditRating')
      .mockResolvedValue(null);
    return { service, connection, rewritten };
  }

  it("reduces only staying waves' REP after the switch-on, against their own tally", async () => {
    const { service, connection, rewritten } = switchedOnOverRate(30, [
      waveRep('moving-wave', 10),
      waveRep('staying-wave', 12),
      waveRep('other-staying-wave', -8)
    ]);
    await service.reduceOverRates();
    // Staying tally 20 against a credit of 10: each is halved.
    expect(rewritten.mock.calls).toEqual([
      [
        expect.objectContaining({ matter_target_id: 'staying-wave' }),
        6,
        connection
      ],
      [
        expect.objectContaining({ matter_target_id: 'other-staying-wave' }),
        -4,
        connection
      ]
    ]);
  });

  it('cuts no staying wave REP for a rater over credit only through moved waves', async () => {
    const { service, rewritten } = switchedOnOverRate(105, [
      waveRep('moving-wave', 100),
      waveRep('staying-wave', 5)
    ]);
    await service.reduceOverRates();
    expect(rewritten).not.toHaveBeenCalled();
  });

  it.each([
    [true, false, [RateMatter.REP]],
    [true, true, [RateMatter.REP, RateMatter.WAVE_REP]],
    [false, false, [RateMatter.REP, RateMatter.WAVE_REP]]
  ])(
    'over-rates loop with the freeze %s and the switch-on %s locks %j',
    async (frozen, switchedOn, reduced) => {
      if (frozen) process.env[FLAG] = 'true';
      if (switchedOn) process.env[ON_CHAIN] = 'true';
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
